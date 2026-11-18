/* eslint-disable max-lines -- Web Push 后端、SW、设置页与通知点击导航回归集中在同一个串行脚本里，共享 esbuild 打包与 jsdom 环境。 */
// 独立 Web 后台推送（Web Push）一体化定向回归：本地 esbuild 打包真实源码，不连接任何真实 Host，
// 不触碰用户数据。三部分检查串行执行：
//  1. 后端 Web Push 套件：esbuild 打包 packages/server/test/web-push.test.ts，子进程 `node --test`，退出码必须为 0。
//  2. 前端平台通知与 SW 套件：esbuild 打包 packages/web/test/web-notifications-platform.test.ts，同样以 `node --test` 运行。
//  3. 真实 UI 组件 jsdom + react-dom 渲染与交互回归。被测的是真实源码模块：
//       packages/ui/src/settingsPageHelpers.tsx（GeneralSectionContent，即设置页“常规”分区）
//       packages/ui/src/settings-search/SettingsSearch.tsx 与 settingsSearchIndex.ts（SETTINGS_SEARCH_ITEMS）
//     仅把 i18n Provider 换成读取真实 zh-CN / en-US 词表的最小桩（缺 key 直接抛错）。
//     并校验静态产物 packages/web/public/manifest.webmanifest 与 packages/web/index.html。
//  4. 通知点击导航回归（真实源码，独立 esbuild 打包 + jsdom）：
//       useRootPlatformEffects（通知点击解析 + 冷启动 bootstrap）、useTabPersistence（历史 tab 恢复）、
//       useWorkspaceTaskNavigation.handleSelectTask 与通知导航缓冲通道、WebRemoteControlMobileShell。
//     全程 taskListCache === null（V4 真实状态）；只替换 toast、services 与 i18n 的最小桩。
//     另验手机壳 Home 列表在前台时 syncActiveTaskSession 上报 null（不吞该任务的通知）。
//  5. 终态通知与独立 Web 连接恢复回归：
//       packages/ui/src/lib/taskNotificationOrchestrator.ts（真实 collectTerminalTaskNotificationPayloads：
//       completedSuccess 完成、error 失败、completedInterrupted 静默）；
//       packages/web/src/main.tsx（抽取真实 createStandaloneWebConnection 源码段执行：首连单往返、后台恢复 0ms 重连、
//       退避序列；源码级断言仅首连有 3000ms 提示、保留登录过期入口、首屏不清空 #root 启动动画且不锁屏）。
//
// 容器资源纪律：所有 esbuild 构建与子进程严格串行，且 GOMAXPROCS 默认 2（外部已设置则尊重外部值）；
// 临时打包目录在 finally 中用 fs.rm 清理。
//
// 依赖查找顺序与 standalone-desktop-parity-ui.mjs 一致：ZCODE_ISOLATION_NODE_MODULES（路径分隔符分隔）、
// 仓库自身 node_modules、验证工具目录，最后是与仓库同级的 ZCode-upstream-3.18.2/node_modules。
//
// 运行（仓库根目录；至少需要 esbuild、jsdom、react、react-dom）：
//   env GOMAXPROCS=2 node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-web-push.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 必须先于 esbuild 加载：esbuild 的 Go 子进程在首次构建时才启动，此时会读取该变量。
process.env.GOMAXPROCS ??= "2";

const here = dirname(fileURLToPath(import.meta.url));
// remote-control/projects/manual-review/pending 目录 → 仓库根
const repoRoot = resolve(here, "../../../../../../../..");
const uiSrc = join(repoRoot, "packages/ui/src");

// ---------------------------------------------------------------------------
// 依赖定位。
// ---------------------------------------------------------------------------
function candidateNodeModules() {
  const extra = (process.env.ZCODE_ISOLATION_NODE_MODULES ?? "").split(delimiter).filter(Boolean);
  const dirs = [
    ...extra,
    join(repoRoot, "packages/ui/node_modules"),
    join(repoRoot, "node_modules"),
  ];
  const esbuildBin = join(repoRoot, "node_modules/.bin/esbuild");
  if (existsSync(esbuildBin)) {
    dirs.push(join(dirname(realpathSync(esbuildBin)), "../../.."));
    dirs.push(join(dirname(realpathSync(esbuildBin)), "../.."));
  }
  dirs.push(join(repoRoot, "../ZCode-upstream-3.18.2/node_modules"));
  return dirs.filter((dir, index) => existsSync(dir) && dirs.indexOf(dir) === index);
}

const nodePaths = candidateNodeModules();
const findPackageDir = (name) =>
  nodePaths.find((dir) => existsSync(join(dir, name, "package.json"))) ?? null;

async function loadEsbuild() {
  const dir = findPackageDir("esbuild");
  return dir ? createRequire(import.meta.url)(join(dir, "esbuild/lib/main.js")) : import("esbuild");
}
const esbuild = await loadEsbuild();

// react 与 react-dom 必须来自同一目录（react-dom 会校验版本一致）；jsdom 用于真实 DOM。
const reactDomDir = nodePaths.find(
  (dir) =>
    existsSync(join(dir, "react-dom/package.json")) && existsSync(join(dir, "react/package.json")),
);
const jsdomDir = findPackageDir("jsdom");
if (!reactDomDir || !jsdomDir) {
  throw new Error(
    "本回归需要 jsdom + react-dom（请先 pnpm install，或设置 ZCODE_ISOLATION_NODE_MODULES）",
  );
}
const reactAlias = {
  react: realpathSync(join(reactDomDir, "react")),
  "react-dom": realpathSync(join(reactDomDir, "react-dom")),
};
const { JSDOM } = createRequire(join(jsdomDir, "noop.js"))("jsdom");

// ---------------------------------------------------------------------------
// esbuild 插件：`@/` 别名、`@zcode/*` workspace 包（按 package.json exports 指向源码）、`.js`→`.ts(x)`、最小桩。
// ---------------------------------------------------------------------------
function resolveTsCandidate(absPath) {
  const candidates = [absPath];
  if (absPath.endsWith(".js")) {
    const stem = absPath.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  candidates.push(`${absPath}.ts`, `${absPath}.tsx`, join(absPath, "index.ts"));
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

// `@zcode/<name>` → packages/<dir>：包名与目录名并不总是一致，按 package.json 的 name 建立映射。
const workspacePackages = new Map();
for (const entry of readdirSync(join(repoRoot, "packages"))) {
  const manifestPath = join(repoRoot, "packages", entry, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.name === "string") {
    workspacePackages.set(manifest.name, { dir: join(repoRoot, "packages", entry), manifest });
  }
}

function pickExportTarget(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    return pickExportTarget(target.import ?? target.default ?? target.node ?? target.require);
  }
  return null;
}

function resolveWorkspacePackage(spec) {
  const [scope, name, ...rest] = spec.split("/");
  const pkg = workspacePackages.get(`${scope}/${name}`);
  if (!pkg) return null;
  const subpath = rest.length ? `./${rest.join("/")}` : ".";
  const exportsMap = pkg.manifest.exports;
  let target = exportsMap && typeof exportsMap === "object" ? exportsMap[subpath] : undefined;
  if (target === undefined && exportsMap && typeof exportsMap === "object") {
    // 通配子路径：`./foo/*` → `./src/foo/*`
    for (const [pattern, value] of Object.entries(exportsMap)) {
      const star = pattern.indexOf("*");
      if (star < 0) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
        const picked = pickExportTarget(value);
        if (picked) {
          target = picked.replace("*", matched);
          break;
        }
      }
    }
  }
  const picked = pickExportTarget(target);
  if (picked) return resolve(pkg.dir, picked);
  if (subpath === ".") {
    const main = pkg.manifest.module ?? pkg.manifest.main;
    if (typeof main === "string") return resolve(pkg.dir, main);
  }
  return null;
}

const builtinSpecs = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function createPlugin(stubs, { externalNative = [] } = {}) {
  return {
    name: "standalone-web-push-isolation",
    setup(build) {
      const stubNs = "isolation-stub";
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (builtinSpecs.has(spec) || spec.startsWith("node:")) return undefined;
        if (externalNative.includes(spec)) return { path: spec, external: true };
        let absolute = null;
        if (spec.startsWith("@/")) {
          absolute = resolveTsCandidate(join(uiSrc, spec.slice(2)));
        } else if (spec.startsWith("@zcode/")) {
          const workspaceEntry = resolveWorkspacePackage(spec);
          absolute = workspaceEntry ? (resolveTsCandidate(workspaceEntry) ?? workspaceEntry) : null;
        } else if (spec.startsWith(".") && args.importer && args.namespace === "file") {
          absolute = resolveTsCandidate(resolve(dirname(args.importer), spec));
        }
        if (!absolute) return undefined;
        const key = absolute.startsWith(`${uiSrc}/`)
          ? absolute.replace(`${uiSrc}/`, "ui:").replace(/\.(tsx?|js)$/u, "")
          : null;
        if (key && stubs[key]) return { path: key, namespace: stubNs };
        return { path: absolute };
      });
      build.onLoad({ filter: /.*/, namespace: stubNs }, (args) => ({
        contents: stubs[args.path],
        loader: "tsx",
        resolveDir: uiSrc,
      }));
    },
  };
}

async function bundleUi(contents, outfile, stubs, { banner } = {}) {
  await esbuild.build({
    stdin: { contents, resolveDir: uiSrc, loader: "tsx", sourcefile: "isolation-entry.tsx" },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    logLevel: "error",
    nodePaths,
    alias: reactAlias,
    define: { "import.meta.env": '{"PROD":true,"DEV":false}' },
    // 导航回归会经由真实模块图引入图片资源；jsdom 里只需要一个可用的 URL。
    loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
    ...(banner ? { banner: { js: banner } } : {}),
    plugins: [createPlugin(stubs)],
  });
}

// node:test 文件打包为单个 ESM；CJS 依赖里的 require 通过 createRequire 垫片提供。
const NODE_TEST_BANNER =
  'import { createRequire as __webPushCreateRequire } from "node:module";' +
  "const require = __webPushCreateRequire(import.meta.url);";

// pinSourceUrl：用例用 `new URL("../public/...", import.meta.url)` 定位源码相邻文件时，
// 打包后 import.meta.url 会指向临时目录，需要固定回源文件位置。
async function bundleNodeTest(entryFile, outfile, { pinSourceUrl = false } = {}) {
  await esbuild.build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "error",
    nodePaths,
    banner: { js: NODE_TEST_BANNER },
    define: pinSourceUrl
      ? { "import.meta.url": JSON.stringify(pathToFileURL(entryFile).href) }
      : {},
    plugins: [createPlugin({}, { externalNative: ["node-pty", "@napi-rs/keyring"] })],
  });
}

// ---------------------------------------------------------------------------
// 检查工具。
// ---------------------------------------------------------------------------
let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function runNodeTestSuite(label, bundlePath) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", bundlePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GOMAXPROCS: process.env.GOMAXPROCS },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  assert.equal(
    result.status,
    0,
    `${label} 退出码应为 0，实际为 ${result.status}（signal=${result.signal}，error=${result.error?.message ?? "无"}）`,
  );
  const counts = Object.fromEntries(
    [...(result.stdout ?? "").matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  assert.ok((counts.tests ?? 0) > 0, `${label} 未执行任何用例`);
  assert.equal(counts.fail ?? 0, 0, `${label} 存在失败用例`);
  return counts;
}

// ---------------------------------------------------------------------------
// 第 3 部分的桩与入口。
// ---------------------------------------------------------------------------
// useZCodeIntl 读取真实词表；缺 key 抛错，能直接暴露被删除词条的残留引用。
const INTL_STUB = `
  import zhCN from "@/i18n/locales/zh-CN.js";
  import enUS from "@/i18n/locales/en-US.js";
  const TABLES = { "zh-CN": zhCN, "en-US": enUS };
  export function createIntl(locale) {
    const table = TABLES[locale];
    return {
      formatMessage({ id }, values) {
        const text = table[id];
        if (text === undefined) throw new Error("missing i18n key " + id + " (" + locale + ")");
        return text.replace(/\\{(\\w+)\\}/g, (raw, key) => (values && values[key] !== undefined ? String(values[key]) : raw));
      },
    };
  }
  const cache = {};
  export function useZCodeIntl() {
    const locale = globalThis.__webPushLocale ?? "zh-CN";
    cache[locale] ??= { intl: createIntl(locale), locale, localeResolved: true };
    return cache[locale];
  }
`;

const UI_ENTRY = `
  import { createElement as h, act } from "react";
  import { createRoot } from "react-dom/client";
  export { h, act };
  export async function mountElement(element) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(element); });
    return {
      container,
      async unmount() {
        await act(async () => { root.unmount(); });
        container.remove();
      },
    };
  }
  export { GeneralSectionContent } from "@/settingsPageHelpers.js";
  export { SettingsSearch } from "@/settings-search/SettingsSearch.js";
  export { SETTINGS_SEARCH_ITEMS } from "@/settings-search/settingsSearchIndex.js";
  export { createSettingsPageConfig } from "@/settings/settingsPageConfig.js";
  import zhCN from "@/i18n/locales/zh-CN.js";
  import enUS from "@/i18n/locales/en-US.js";
  export const LOCALES = { "zh-CN": zhCN, "en-US": enUS };
`;

// ---------------------------------------------------------------------------
// 第 4 部分：通知点击导航回归的入口与桩。
// ---------------------------------------------------------------------------
const TOAST_STUB = `
  export function toast(message) {
    (globalThis.__toasts ??= []).push(String(message));
    return 1;
  }
  export function dismissToast() {}
  export function updateToast() {}
`;

const WORKSPACE_SERVICES_STUB = `
  export function useBaseWorkspaceServices() {
    return globalThis.__baseServices;
  }
  export function useOptionalBaseWorkspaceServices() {
    return globalThis.__baseServices ?? null;
  }
`;

const SERVICES_STUB = `
  export function useServices() {
    return globalThis.__baseServices;
  }
  export function useOptionalServices() {
    return globalThis.__baseServices ?? null;
  }
  export function useComposerClientNamespace() {
    return "web-test";
  }
`;

// 主题菜单依赖 StoreProvider，任务查看上报依赖远控桥；两者与导航无关，换成空组件。
const NULL_COMPONENT_STUB = `
  export function WebRemoteControlThemeMenu() { return null; }
  export function WebRemoteControlTaskViewReporter() { return null; }
`;

const NAV_ENTRY = `
  import { createElement as h, act, useCallback, useEffect, useMemo, useRef, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
  import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
  import { onTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
  import { isWorkspaceTab } from "@/store/tabStore.js";
  import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
  import { useTabPersistence } from "@/hooks/useTabPersistence.js";
  import {
    subscribeNotificationTaskNavigation,
    useWorkspaceTaskNavigation,
  } from "@/app-shell/useWorkspaceTaskNavigation.js";
  import {
    WebRemoteControlMobileShell,
    isWebRemoteControlMobileHomeListVisible,
  } from "@/WebRemoteControlMobileShell.js";
  import { createIntl } from "@/i18n/IntlProvider.js";
  import zhCN from "@/i18n/locales/zh-CN.js";
  export const LOCALES = { "zh-CN": zhCN };
  export {
    h,
    act,
    useZCodeSessionStore,
    onTaskNavigationCommitted,
    TabStoreProvider,
    isWorkspaceTab,
    isWebRemoteControlMobileHomeListVisible,
  };

  export async function mountElement(element) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(element); });
    return {
      container,
      rerender: (next) => act(async () => { root.render(next); }),
      async unmount() {
        await act(async () => { root.unmount(); });
        container.remove();
      },
    };
  }

  export function createFakePlatform({ standalone = true } = {}) {
    let handler = null;
    const noop = () => () => {};
    return {
      platform: {
        onFocusTab: noop,
        onNewTab: noop,
        onNewTask: noop,
        onOpenWorkspace: noop,
        onTaskNotificationClick: (next) => {
          handler = next;
          return () => { if (handler === next) handler = null; };
        },
        syncWindowTabs(paths) {
          (globalThis.__syncedWindowTabs ??= []).push(paths);
        },
        syncActiveTaskSession(sessionId) {
          (globalThis.__syncedSessions ??= []).push(sessionId);
        },
        setApplicationLocale: async () => {},
        ...(standalone ? { setWebPushSubscribed: async () => ({}) } : {}),
      },
      click: (taskId, context) => handler(taskId, context),
      hasHandler: () => handler !== null,
    };
  }

  // 与 Root + WorkspaceShellLayout 的接线保持同构：useTabPersistence 决定何时允许 bootstrap，
  // useRootPlatformEffects 处理通知点击，壳层订阅通知导航并驱动手机壳切到 Chat。
  function Harness({ platform, initial, settingService, isDesktop, onApi, intl, mobile }) {
    const api = useTabStoreApi();
    useEffect(() => { onApi?.(api); }, [api, onApi]);
    const tabs = useTabStore((state) => state.tabs);
    const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
    const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
    const [, setIsBootstrapping] = useState(Boolean(initial?.workspacePath));
    const { hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
      settingService,
      restoreSession: Boolean(settingService),
      persistSession: false,
    });
    const addTab = useCallback((path, options) => { api.getState().addTab(path, options); }, [api]);
    const activateTabByPath = useCallback(
      (path, options) => api.getState().activateTabByPath(path, options),
      [api],
    );
    const startDraftInWorkspace = useCallback((path, identity, options) => {
      (globalThis.__drafts ??= []).push(path);
      useZCodeSessionStore.getState().startDraft(path, undefined, identity, options);
    }, []);
    const noop = useCallback(() => {}, []);
    useRootPlatformEffects({
      initialWorkspaceAbsPath: initial?.workspacePath,
      initialWorkspaceIdentity: initial?.workspaceIdentity,
      initialTaskId: initial?.taskId,
      clientMode: "desktop-continuous",
      canBootstrapInitialWorkspace: hasCompletedInitialRestore,
      addTab,
      setIsBootstrappingInitialWorkspace: setIsBootstrapping,
      platform,
      activateTabByPath,
      startDraftInWorkspace,
      startNewTaskFromActiveWorkspace: noop,
      openWorkspace: noop,
      openWorkspacePath: noop,
      setWorkspaceActionError: noop,
      isDesktop,
      locale: "zh-CN",
      tabs,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      hasCompletedFullTabRestore: hasCompletedFullRestore,
      intl,
      isRestoringOAuthSession: false,
    });
    return mobile ? h(MobileShellStub, { intl, activateTabByPath }) : null;
  }

  function MobileShellStub({ intl, activateTabByPath }) {
    const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath) ?? "";
    const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity) ?? undefined;
    const activeTaskId = useZCodeSessionStore(
      (state) => state.getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity).activeTaskId,
    );
    const { handleSelectTask } = useWorkspaceTaskNavigation({
      intl,
      workspaceAbsPath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      activateTabByPath,
    });
    const selectRef = useRef(handleSelectTask);
    selectRef.current = handleSelectTask;
    const [revealChatRequestId, setRevealChatRequestId] = useState(0);
    useEffect(
      () =>
        subscribeNotificationTaskNavigation((request) => {
          (globalThis.__navRequests ??= []).push(request);
          selectRef.current(request.workspacePath, request.taskId, request.workspaceIdentity);
          if (request.revealChat) setRevealChatRequestId((id) => id + 1);
        }),
      [],
    );
    return h(WebRemoteControlMobileShell, {
      isMobileViewport: true,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      activeTaskId: activeTaskId ?? null,
      taskViewEnabled: false,
      revealChatRequestId,
      renderTaskHome: () => h("div", { "data-testid": "task-home" }, "home"),
      renderChatHeader: () => null,
      chatContent: h("div", { "data-testid": "chat", "data-task": activeTaskId ?? "" }),
    });
  }

  export function mountHarness(props) {
    return mountElement(
      h(TabStoreProvider, null, h(Harness, { ...props, intl: createIntl("zh-CN") })),
    );
  }
`;

// ---------------------------------------------------------------------------
// jsdom 全局：react-dom 与 Radix 需要真实 DOM、ResizeObserver 与 jsdom 自己的 Event 类。
// ---------------------------------------------------------------------------
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win = dom.window;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in globalThis) continue;
    Object.defineProperty(globalThis, key, { configurable: true, get: () => win[key] });
  }
  for (const key of ["Event", "CustomEvent", "EventTarget", "MouseEvent", "KeyboardEvent"]) {
    Object.defineProperty(globalThis, key, { configurable: true, value: win[key] });
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: win.document });
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  win.ResizeObserver = FakeResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  // cmdk 在选中项变化时调用 scrollIntoView，jsdom 未实现。
  win.Element.prototype.scrollIntoView = () => {};
  // jsdom 未实现 canvas；返回 null 即可避免 "Not implemented" 噪声。
  win.HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return win;
}

// ---------------------------------------------------------------------------
// 第 3 部分：设置页“常规”分区与设置搜索。
// ---------------------------------------------------------------------------
const TEXT = {
  "zh-CN": {
    permissionDefault: "还没有允许浏览器通知。",
    permissionRequest: "允许通知",
    webPush: "后台推送",
    mobilePush: "手机推送通知",
    descriptionWeb: "任务完成、失败或等待确认时发送浏览器通知。",
    descriptionDesktop: "任务完成、失败或需要确认时发送桌面通知。",
  },
  "en-US": {
    permissionDefault: "Browser notifications are not allowed yet.",
    permissionRequest: "Allow notifications",
    webPush: "Background notifications",
    mobilePush: "Mobile push notifications",
    descriptionWeb:
      "Send browser notifications when a task completes, fails, or needs your confirmation.",
    descriptionDesktop:
      "Send desktop notifications when a task completes, fails, or needs approval.",
  },
};

const ERROR_CODES = {
  permission_denied: "settings.webPushError.permissionDenied",
  push_unsupported: "settings.webPushError.pushUnsupported",
  server_unavailable: "settings.webPushError.serverUnavailable",
  subscribe_failed: "settings.webPushError.subscribeFailed",
  unsubscribe_failed: "settings.webPushError.unsubscribeFailed",
};

function createSuite(mod, win) {
  const settle = (ms = 20) =>
    mod.act(async () => {
      await new Promise((done) => setTimeout(done, ms));
    });
  const click = (element) => {
    assert.ok(element, "待点击元素不存在");
    return mod.act(async () => {
      element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const text = (locale, key) => {
    const value = mod.LOCALES[locale][key];
    if (value === undefined) throw new Error(`missing i18n key ${key} (${locale})`);
    return value;
  };
  const row = (container, id) => container.querySelector(`[data-settings-search-id="${id}"]`);
  const rowSwitch = (container, id) => row(container, id)?.querySelector('[role="switch"]') ?? null;
  const findButton = (container, label) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === label);

  // 记录所有平台调用；状态通过 getWebNotificationState 异步给出，与真实 web 平台一致。
  function createPlatform(state, { withNotificationApi = true } = {}) {
    const calls = { permission: 0, subscribe: [] };
    if (!withNotificationApi) return { calls, platform: { notifyRendererReady() {} } };
    return {
      calls,
      platform: {
        getWebNotificationState: () => Promise.resolve(state),
        onWebNotificationStateChanged: () => () => {},
        requestWebNotificationPermission: () => {
          calls.permission += 1;
          return Promise.resolve(state);
        },
        setWebPushSubscribed: (subscribed, options) => {
          calls.subscribe.push(options === undefined ? [subscribed] : [subscribed, options]);
          return Promise.resolve(state);
        },
      },
    };
  }

  async function renderGeneral(
    locale,
    { platform, isDesktop, notificationEnabled = true, ...rest },
  ) {
    globalThis.__webPushLocale = locale;
    const handlers = { notification: [], sound: [] };
    const mounted = await mod.mountElement(
      mod.h(mod.GeneralSectionContent, {
        localePreference: "system",
        notificationEnabled,
        notificationSoundEnabled: true,
        closeToTrayOnWindows: false,
        receivePreviewUpdates: false,
        autoDownloadAndInstallUpdates: false,
        dataBaseDir: "/data",
        terminalInheritSystemProfile: true,
        terminalFontFamily: "",
        defaultHomeDir: "/home/user",
        isDesktop,
        platform,
        setLocalePreference() {},
        setNotificationEnabled: (enabled) => void handlers.notification.push(enabled),
        setNotificationSoundEnabled: (enabled) => void handlers.sound.push(enabled),
        onDataBaseDirChange: async () => {},
        onSelectDataBaseDir: async () => null,
        onTerminalInheritSystemProfileChange: async () => {},
        onTerminalFontFamilyChange: async () => {},
        onCloseToTrayOnWindowsChange: async () => {},
        onReceivePreviewUpdatesChange: async () => {},
        onAutoDownloadAndInstallUpdatesChange: async () => {},
        onOpenOnboardingDialog() {},
        ...rest,
      }),
    );
    await settle();
    return { ...mounted, handlers };
  }

  const webState = (overrides) => ({
    permission: "granted",
    pushAvailable: true,
    pushSupported: true,
    pushSubscribed: false,
    ...overrides,
  });

  async function runWebWorkbenchSuite() {
    console.log("Web 工作台态（isDesktop=false，pushAvailable=true）");
    for (const locale of ["zh-CN", "en-US"]) {
      const T = TEXT[locale];
      assert.equal(T.webPush, text(locale, "settings.webPush"), "测试期望需与真实词表一致");

      await check(`${locale} permission=default：权限提示与请求按钮，点击触发授权`, async () => {
        const { platform, calls } = createPlatform(webState({ permission: "default" }));
        const mounted = await renderGeneral(locale, { platform, isDesktop: false });
        const hint = mounted.container.querySelector(
          '[data-testid="settings-web-notification-permission"]',
        );
        assert.ok(hint, "缺少权限提示");
        assert.equal(hint.getAttribute("data-permission"), "default");
        assert.ok(hint.textContent.includes(T.permissionDefault), hint.textContent);
        assert.ok(
          row(mounted.container, "settings.notification").textContent.includes(T.descriptionWeb),
        );
        const button = findButton(mounted.container, T.permissionRequest);
        assert.ok(button, `缺少「${T.permissionRequest}」按钮`);
        await click(button);
        assert.equal(calls.permission, 1);
        assert.deepEqual(calls.subscribe, []);
        const pushRow = row(mounted.container, "settings.webPush");
        assert.ok(pushRow, "缺少后台推送行");
        assert.ok(pushRow.textContent.includes(T.webPush));
        assert.ok(rowSwitch(mounted.container, "settings.webPush"), "缺少后台推送开关");
        assert.ok(!mounted.container.textContent.includes(T.mobilePush), "不应出现手机推送通知");
        await mounted.unmount();
      });

      await check(`${locale} permission=denied：阻止提示且后台推送开关禁用`, async () => {
        const { platform } = createPlatform(webState({ permission: "denied" }));
        const mounted = await renderGeneral(locale, { platform, isDesktop: false });
        const hint = mounted.container.querySelector(
          '[data-testid="settings-web-notification-permission"]',
        );
        assert.equal(hint?.getAttribute("data-permission"), "denied");
        assert.ok(hint.textContent.includes(text(locale, "settings.notificationPermissionDenied")));
        assert.ok(!findButton(mounted.container, T.permissionRequest), "denied 不应再给请求按钮");
        const toggle = rowSwitch(mounted.container, "settings.webPush");
        assert.ok(toggle, "缺少后台推送开关");
        assert.equal(toggle.disabled, true);
        await mounted.unmount();
      });

      await check(
        `${locale} permission=ios-install-required：添加到主屏幕指引，开关可见且禁用`,
        async () => {
          const { platform } = createPlatform(
            webState({ permission: "ios-install-required", pushSupported: false }),
          );
          const mounted = await renderGeneral(locale, { platform, isDesktop: false });
          const hint = mounted.container.querySelector(
            '[data-testid="settings-web-notification-permission"]',
          );
          assert.equal(hint?.getAttribute("data-permission"), "ios-install-required");
          assert.ok(
            hint.textContent.includes(text(locale, "settings.notificationPermissionIosInstall")),
          );
          assert.ok(
            row(mounted.container, "settings.webPush"),
            "iOS 需先安装，行仍应可见以给出指引",
          );
          assert.equal(rowSwitch(mounted.container, "settings.webPush")?.disabled, true);
          await mounted.unmount();
        },
      );

      await check(
        `${locale} permission=granted：无权限提示，总开关与声音开关联动订阅`,
        async () => {
          const state = webState({ permission: "granted", pushSubscribed: true });
          const { platform, calls } = createPlatform(state);
          const mounted = await renderGeneral(locale, { platform, isDesktop: false });
          assert.ok(
            !mounted.container.querySelector(
              '[data-testid="settings-web-notification-permission"]',
            ),
            "granted 不应显示权限提示",
          );
          const pushToggle = rowSwitch(mounted.container, "settings.webPush");
          assert.equal(pushToggle?.getAttribute("aria-checked"), "true");
          assert.equal(pushToggle.disabled, false);

          // 切换声音：已订阅时静默同步服务端，带上当前语言与新的声音偏好。
          await click(rowSwitch(mounted.container, "settings.notificationSound"));
          assert.deepEqual(mounted.handlers.sound, [false]);
          assert.deepEqual(calls.subscribe, [[true, { locale, soundEnabled: false }]]);

          // 关闭任务通知总开关：同时退订本设备后台推送。
          await click(rowSwitch(mounted.container, "settings.notification"));
          assert.deepEqual(mounted.handlers.notification, [false]);
          assert.deepEqual(calls.subscribe.at(-1), [false]);
          assert.equal(calls.subscribe.length, 2);
          assert.equal(calls.permission, 0, "granted 不应再次请求授权");

          // 后台推送开关自身：已订阅 → 取消订阅，只携带 locale。
          await click(pushToggle);
          assert.deepEqual(calls.subscribe.at(-1), [false, { locale }]);
          await mounted.unmount();
        },
      );

      await check(`${locale} 未订阅时切换开关不触发订阅同步`, async () => {
        const { platform, calls } = createPlatform(webState({ pushSubscribed: false }));
        const mounted = await renderGeneral(locale, { platform, isDesktop: false });
        await click(rowSwitch(mounted.container, "settings.notificationSound"));
        await click(rowSwitch(mounted.container, "settings.notification"));
        assert.deepEqual(calls.subscribe, []);
        assert.deepEqual(mounted.handlers.sound, [false]);
        assert.deepEqual(mounted.handlers.notification, [false]);
        await mounted.unmount();
      });

      await check(`${locale} 通知总开关关闭：后台推送开关禁用`, async () => {
        const { platform } = createPlatform(webState({ pushSubscribed: true }));
        const mounted = await renderGeneral(locale, {
          platform,
          isDesktop: false,
          notificationEnabled: false,
        });
        const toggle = rowSwitch(mounted.container, "settings.webPush");
        assert.equal(toggle?.disabled, true);
        assert.equal(toggle.getAttribute("aria-checked"), "false");
        await mounted.unmount();
      });

      await check(`${locale} 错误码渲染友好提示，不泄露原始异常`, async () => {
        for (const [code, key] of Object.entries(ERROR_CODES)) {
          const raw =
            "TypeError: Failed to fetch\n    at fetchConfig (https://host/assets/app.js:1:1)";
          const { platform } = createPlatform({ ...webState({ error: code }), message: raw });
          const mounted = await renderGeneral(locale, { platform, isDesktop: false });
          const alert = row(mounted.container, "settings.webPush")?.querySelector('[role="alert"]');
          assert.ok(alert, `${code} 缺少错误提示`);
          assert.equal(alert.textContent.trim(), text(locale, key));
          assert.ok(!/TypeError|Failed to fetch|\bat \w+ \(/u.test(mounted.container.textContent));
          await mounted.unmount();
        }
        const { platform } = createPlatform(webState({ error: null }));
        const mounted = await renderGeneral(locale, { platform, isDesktop: false });
        assert.ok(!mounted.container.querySelector('[role="alert"]'), "无错误时不应渲染 alert");
        await mounted.unmount();
      });
    }
  }

  async function runMobileProxySuite() {
    console.log("手机远控代理态（isDesktop=false，pushAvailable=false）与设置搜索");
    for (const locale of ["zh-CN", "en-US"]) {
      const T = TEXT[locale];
      await check(
        `${locale} ios-install-required 且 pushAvailable=false：不渲染后台推送行`,
        async () => {
          const { platform } = createPlatform(
            webState({
              permission: "ios-install-required",
              pushAvailable: false,
              pushSupported: false,
            }),
          );
          const mounted = await renderGeneral(locale, { platform, isDesktop: false });
          assert.ok(!row(mounted.container, "settings.webPush"), "代理页不应有后台推送行");
          assert.ok(!mounted.container.textContent.includes(T.webPush));
          assert.ok(!mounted.container.querySelector('[data-testid="settings-web-push-switch"]'));
          await mounted.unmount();
        },
      );
    }

    const sections = mod.createSettingsPageConfig({}).settingsSections;
    const availability = (webPush) => ({
      desktop: false,
      macDesktop: false,
      windowsHost: false,
      tray: false,
      notWindows: true,
      computerUse: false,
      webPush,
    });
    async function openSearch(locale, webPush) {
      globalThis.__webPushLocale = locale;
      const mounted = await mod.mountElement(
        mod.h(mod.SettingsSearch, { sections, availability: availability(webPush), onSelect() {} }),
      );
      await click(mounted.container.querySelector('[data-testid="settings-search-open"]'));
      await settle();
      return mounted;
    }
    const results = () =>
      [...document.querySelectorAll("[data-settings-search-result]")].map((node) =>
        node.getAttribute("data-settings-search-result"),
      );
    const typeQuery = async (value) => {
      const input = document.querySelector('[data-testid="settings-search-input"]');
      assert.ok(input, "搜索输入框不存在");
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
      await mod.act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      await settle();
    };

    await check("索引：settings.webPush 属于 general，可见性为 webPush", async () => {
      const item = mod.SETTINGS_SEARCH_ITEMS.find((entry) => entry.id === "settings.webPush");
      assert.ok(item, "SETTINGS_SEARCH_ITEMS 缺少 settings.webPush");
      assert.equal(item.section, "general");
      assert.equal(item.visibility, "webPush");
      for (const locale of ["zh-CN", "en-US"]) {
        text(locale, item.id);
        text(locale, item.description);
      }
    });

    for (const locale of ["zh-CN", "en-US"]) {
      await check(`${locale} SettingsSearch webPush=false：搜不到 settings.webPush`, async () => {
        const mounted = await openSearch(locale, false);
        const listed = results();
        assert.ok(listed.includes("settings.notification"), `搜索结果为空：${listed.join("|")}`);
        assert.ok(!listed.includes("settings.webPush"));
        await typeQuery(TEXT[locale].webPush);
        assert.ok(!results().includes("settings.webPush"));
        await mounted.unmount();
      });

      await check(`${locale} SettingsSearch webPush=true：可搜出 settings.webPush`, async () => {
        const mounted = await openSearch(locale, true);
        assert.ok(results().includes("settings.webPush"));
        await typeQuery(TEXT[locale].webPush);
        assert.ok(results().includes("settings.webPush"), results().join("|"));
        await mounted.unmount();
      });
    }
  }

  async function runDesktopSuite() {
    console.log("桌面态对照（isDesktop=true，无 getWebNotificationState）");
    for (const locale of ["zh-CN", "en-US"]) {
      const T = TEXT[locale];
      await check(
        `${locale} 保持桌面通知说明与手机推送通知行，不出现 Web 权限与后台推送`,
        async () => {
          const { platform } = createPlatform(null, { withNotificationApi: false });
          const mounted = await renderGeneral(locale, { platform, isDesktop: true });
          const notificationRow = row(mounted.container, "settings.notification");
          assert.ok(notificationRow.textContent.includes(T.descriptionDesktop));
          assert.ok(!notificationRow.textContent.includes(T.descriptionWeb));
          assert.ok(row(mounted.container, "settings.mobilePush"), "缺少手机推送通知行");
          assert.ok(mounted.container.textContent.includes(T.mobilePush));
          assert.ok(!row(mounted.container, "settings.webPush"));
          assert.ok(!mounted.container.textContent.includes(T.webPush));
          assert.ok(
            !mounted.container.querySelector(
              '[data-testid="settings-web-notification-permission"]',
            ),
          );
          assert.ok(!findButton(mounted.container, T.permissionRequest));
          await mounted.unmount();
        },
      );
    }
  }

  return { runWebWorkbenchSuite, runMobileProxySuite, runDesktopSuite };
}

// ---------------------------------------------------------------------------
// 第 4 部分：通知点击导航回归。
// ---------------------------------------------------------------------------
function createNavigationSuite(mod, win) {
  const settle = (ms = 30) =>
    mod.act(async () => {
      await new Promise((done) => setTimeout(done, ms));
    });
  // 点击与后续异步导航放在同一个 act 里，避免状态更新落在 act 之外。
  const clickAndSettle = (m, taskId, context, ms = 80) =>
    mod.act(async () => {
      m.fake.click(taskId, context);
      await new Promise((done) => setTimeout(done, ms));
    });
  const OPEN_FAILED = mod.LOCALES["zh-CN"]["automations.runs.openSessionFailed"];
  const BACK_HOME = mod.LOCALES["zh-CN"]["webRemoteControl.mobileShell.backHome"];
  const MAINTENANCE = "/workspace/maintenance";
  const DEFAULT_WORKSPACE = "/workspace";

  const initialSessionState = mod.useZCodeSessionStore.getInitialState();
  function resetGlobals() {
    mod.useZCodeSessionStore.setState(initialSessionState, true);
    globalThis.__webPushLocale = "zh-CN";
    globalThis.__toasts = [];
    globalThis.__drafts = [];
    globalThis.__navRequests = [];
    globalThis.__syncedSessions = [];
    globalThis.__syncedWindowTabs = [];
    globalThis.__taskMetaCalls = [];
    win.history.replaceState(null, "");
  }

  // services 只提供通知流程用到的 getTaskMeta；metaFor 决定每次查询的结果或抛错。
  function installServices(metaFor) {
    globalThis.__baseServices = {
      zcodeTaskService: {
        getTaskMeta: async (params) => {
          globalThis.__taskMetaCalls.push(params);
          return metaFor(params, globalThis.__taskMetaCalls.length);
        },
        setTaskUnread: async () => ({}),
      },
    };
  }

  const taskMeta = (params, overrides = {}) => ({
    taskId: params.taskId,
    title: "demo",
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...overrides,
  });

  function snapshot(api) {
    const state = api.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return {
      kind: active?.kind,
      path: active && mod.isWorkspaceTab(active) ? active.workspacePath : undefined,
      workspacePaths: state.tabs.filter(mod.isWorkspaceTab).map((tab) => tab.workspacePath),
    };
  }
  const activeTask = (path, identity) =>
    mod.useZCodeSessionStore.getState().getWorkspaceState(path, identity).activeTaskId;
  const page = (container) =>
    container.querySelector("[data-mobile-page]")?.getAttribute("data-mobile-page");

  async function mountReady({ initial, settingService, standalone = true } = {}) {
    const fake = mod.createFakePlatform({ standalone });
    let api = null;
    const mounted = await mod.mountHarness({
      platform: fake.platform,
      initial,
      settingService,
      isDesktop: !standalone,
      mobile: true,
      onApi: (next) => {
        api = next;
      },
    });
    await settle();
    return { ...mounted, fake, api: () => api };
  }

  async function runSuite() {
    console.log("通知点击导航（taskListCache === null，真实 hook 与手机壳）");

    await check(
      "设置页上点击通知：getTaskMeta 定位，打开目标 tab、退出设置页、选中任务并切到 Chat",
      async () => {
        resetGlobals();
        installServices((params) => taskMeta(params));
        const m = await mountReady();
        await mod.act(async () => {
          m.api().getState().addTab(DEFAULT_WORKSPACE);
          m.api().getState().openSettingsTab();
        });
        assert.equal(snapshot(m.api()).kind, "settings", "前置：设置页处于激活态");
        assert.equal(page(m.container), "home", "前置：手机壳停在 Home");
        assert.equal(
          mod.useZCodeSessionStore.getState().getWorkspaceState(MAINTENANCE).taskListCache,
          null,
          "前置：V4 下 taskListCache 恒为 null",
        );

        await clickAndSettle(m, "task-1", { workspacePath: MAINTENANCE });

        assert.deepEqual(globalThis.__toasts, [], "不应弹出失败 toast");
        const after = snapshot(m.api());
        assert.equal(after.kind, "workspace", "必须退出设置页");
        assert.equal(after.path, MAINTENANCE);
        assert.ok(after.workspacePaths.includes(DEFAULT_WORKSPACE), "原 tab 保留");
        assert.equal(activeTask(MAINTENANCE), "task-1");
        assert.deepEqual(globalThis.__drafts, [], "不得落入草稿");
        assert.equal(globalThis.__taskMetaCalls.length, 1);
        assert.equal(globalThis.__taskMetaCalls[0].workspacePath, MAINTENANCE);
        assert.equal(page(m.container), "chat", "手机壳应从 Home 自动切到 Chat");
        assert.equal(
          m.container.querySelector('[data-testid="chat"]')?.getAttribute("data-task"),
          "task-1",
        );
        await m.unmount();
      },
    );

    await check(
      "手机壳在 Chat 点返回仍可回到 Home，同一请求不会重放；再次点击通知重新切入 Chat",
      async () => {
        resetGlobals();
        installServices((params) => taskMeta(params));
        const m = await mountReady();
        await mod.act(async () => {
          m.api().getState().addTab(MAINTENANCE);
        });
        await clickAndSettle(m, "task-a", { workspacePath: MAINTENANCE });
        assert.equal(page(m.container), "chat");

        const back = [...m.container.querySelectorAll("button")].find(
          (node) => node.getAttribute("aria-label") === BACK_HOME,
        );
        assert.ok(back, "缺少返回 Home 的按钮");
        await mod.act(async () => {
          back.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
        });
        await settle();
        assert.equal(page(m.container), "home", "返回箭头必须能回到 Home");
        await settle(60);
        assert.equal(page(m.container), "home", "已处理的请求不能再次把用户拉回 Chat");

        await clickAndSettle(m, "task-b", { workspacePath: MAINTENANCE });
        assert.equal(page(m.container), "chat");
        assert.equal(activeTask(MAINTENANCE), "task-b");
        await m.unmount();
      },
    );

    await check(
      "canonical workspaceIdentity 查不到时回退纯 path；tab 无 identity 时沿用本地 tab",
      async () => {
        resetGlobals();
        installServices((params) => (params.workspaceIdentity ? null : taskMeta(params)));
        const m = await mountReady();
        await mod.act(async () => {
          m.api().getState().addTab(MAINTENANCE);
        });
        await clickAndSettle(m, "task-1", {
          workspacePath: MAINTENANCE,
          workspaceIdentity: "canonical:maint",
        });
        assert.deepEqual(globalThis.__toasts, []);
        assert.deepEqual(
          globalThis.__taskMetaCalls.map((call) => call.workspaceIdentity),
          ["canonical:maint", undefined],
          "先带 identity 查，再回退不带 identity",
        );
        assert.deepEqual(snapshot(m.api()).workspacePaths, [MAINTENANCE], "不得另开 identity tab");
        assert.equal(activeTask(MAINTENANCE), "task-1");

        // Host 回包带 canonical identity、而浏览器本地 tab 没有时，同样沿用本地 tab。
        await mod.act(async () => {
          resetGlobals();
        });
        installServices((params) => taskMeta(params, { workspaceIdentity: "canonical:maint" }));
        await clickAndSettle(m, "task-2", {
          workspacePath: MAINTENANCE,
          workspaceIdentity: "canonical:maint",
        });
        assert.deepEqual(globalThis.__toasts, []);
        assert.deepEqual(snapshot(m.api()).workspacePaths, [MAINTENANCE]);
        assert.equal(activeTask(MAINTENANCE), "task-2");
        await m.unmount();
      },
    );

    await check("只有 taskId 的旧桌面 IPC：遍历已打开的 workspace tab 定位所属工作区", async () => {
      resetGlobals();
      installServices((params) => (params.workspacePath === MAINTENANCE ? taskMeta(params) : null));
      const m = await mountReady({ standalone: false });
      await mod.act(async () => {
        m.api().getState().addTab(MAINTENANCE);
        m.api().getState().addTab("/workspace/other");
      });
      assert.equal(snapshot(m.api()).path, "/workspace/other");
      await clickAndSettle(m, "task-1", undefined);
      assert.deepEqual(globalThis.__toasts, []);
      assert.equal(snapshot(m.api()).path, MAINTENANCE);
      assert.equal(activeTask(MAINTENANCE), "task-1");
      assert.equal(activeTask("/workspace/other"), null);
      await m.unmount();
    });

    await check("连接断线重连：RPC 暂时抛错时等待重试，不立即判定不存在", async () => {
      resetGlobals();
      installServices((params, callCount) => {
        if (callCount <= 2) throw new Error("connection lost");
        return taskMeta(params);
      });
      const m = await mountReady();
      await mod.act(async () => {
        m.api().getState().addTab(DEFAULT_WORKSPACE);
      });
      await clickAndSettle(m, "task-1", { workspacePath: MAINTENANCE }, 100);
      assert.deepEqual(globalThis.__toasts, [], "重试期间不应提示失败");
      assert.equal(activeTask(MAINTENANCE), null, "连接恢复前不应选中");
      await settle(1_000);
      assert.deepEqual(globalThis.__toasts, []);
      assert.ok(globalThis.__taskMetaCalls.length >= 3);
      assert.equal(snapshot(m.api()).path, MAINTENANCE);
      assert.equal(activeTask(MAINTENANCE), "task-1");
      await m.unmount();
    });

    await check("getTaskMeta 明确返回 null：弹出打开失败 toast，且不改动 tab", async () => {
      resetGlobals();
      installServices(() => null);
      const m = await mountReady();
      await mod.act(async () => {
        m.api().getState().addTab(DEFAULT_WORKSPACE);
      });
      await clickAndSettle(m, "missing", { workspacePath: MAINTENANCE });
      assert.deepEqual(globalThis.__toasts, [OPEN_FAILED]);
      assert.deepEqual(snapshot(m.api()).workspacePaths, [DEFAULT_WORKSPACE]);
      assert.equal(globalThis.__navRequests.length, 0);
      assert.equal(page(m.container), "home");
      await m.unmount();
    });

    await check(
      "syncActiveTaskSession：设置页与手机 Home 列表上报 null，进入 Chat 后才上报当前任务",
      async () => {
        resetGlobals();
        installServices((params) => taskMeta(params));
        const m = await mountReady();
        const lastSynced = () => globalThis.__syncedSessions.at(-1);
        const clickBack = async () => {
          const back = [...m.container.querySelectorAll("button")].find(
            (node) => node.getAttribute("aria-label") === BACK_HOME,
          );
          assert.ok(back, "缺少返回 Home 的按钮");
          await mod.act(async () => {
            back.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
          });
          await settle();
        };
        await mod.act(async () => {
          m.api().getState().addTab(MAINTENANCE);
        });
        await clickAndSettle(m, "task-a", { workspacePath: MAINTENANCE });
        assert.equal(page(m.container), "chat");
        assert.equal(lastSynced(), "task-a", "停在 Chat：正在查看该任务");

        // 手机窄屏回到 Home 列表：activeTaskId 仍保留，但聊天区不可见，不能把该任务当成正在查看。
        await clickBack();
        assert.equal(page(m.container), "home");
        assert.equal(activeTask(MAINTENANCE), "task-a", "前置：activeTaskId 未被清空");
        assert.equal(lastSynced(), null, "Home 列表在前台：必须上报 null，通知照常展示");

        // 再次通知点击切入 Chat：恢复上报该任务。
        await clickAndSettle(m, "task-b", { workspacePath: MAINTENANCE });
        assert.equal(page(m.container), "chat");
        assert.equal(lastSynced(), "task-b");

        // 设置页不是 workspace tab：workspacePath 为空，同样上报 null。
        await mod.act(async () => {
          m.api().getState().openSettingsTab();
        });
        await settle();
        assert.equal(snapshot(m.api()).kind, "settings");
        assert.equal(lastSynced(), null, "设置页不得吞掉任何任务的通知");
        assert.deepEqual(globalThis.__syncedWindowTabs.at(-1), ["", MAINTENANCE]);

        // 壳层卸载后复位，避免残留的 Home 状态让桌面或宽屏一直上报“未在查看”。
        await clickBack();
        assert.equal(mod.isWebRemoteControlMobileHomeListVisible(), true, "前置：Home 在前台");
        await m.unmount();
        assert.equal(mod.isWebRemoteControlMobileHomeListVisible(), false);
      },
    );

    await check(
      "历史 tab 恢复完成前点击通知：等待就绪后再导航，不被 restoreTabs 覆盖",
      async () => {
        resetGlobals();
        installServices((params) => taskMeta(params));
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const settingService = {
          get: async () => {
            await gate;
            return { lastActiveWorkspace: { kind: "local", workspacePath: DEFAULT_WORKSPACE } };
          },
          update: async () => {},
        };
        const m = await mountReady({ settingService });
        await clickAndSettle(m, "task-1", { workspacePath: MAINTENANCE }, 80);
        assert.equal(globalThis.__taskMetaCalls.length, 0, "恢复完成前不应查询");
        assert.deepEqual(snapshot(m.api()).workspacePaths, []);
        assert.deepEqual(globalThis.__toasts, []);

        release();
        await settle(150);
        assert.deepEqual(globalThis.__toasts, []);
        const after = snapshot(m.api());
        assert.equal(after.path, MAINTENANCE);
        assert.ok(after.workspacePaths.includes(DEFAULT_WORKSPACE), "恢复出的 tab 必须保留");
        assert.equal(activeTask(MAINTENANCE), "task-1");
        await m.unmount();
      },
    );

    await check(
      "冷启动深链：已有其他持久化 tab 时最终激活目标 workspace 与任务，不落入默认草稿",
      async () => {
        resetGlobals();
        installServices((params) => taskMeta(params));
        const committed = [];
        const subscription = mod.onTaskNavigationCommitted((entry) => committed.push(entry.taskId));
        const settingService = {
          get: async () => ({
            lastActiveWorkspace: { kind: "local", workspacePath: "/workspace/previous" },
          }),
          update: async () => {},
        };
        const m = await mountReady({
          settingService,
          initial: { workspacePath: MAINTENANCE, taskId: "task-cold" },
        });
        await settle(100);
        const after = snapshot(m.api());
        assert.equal(after.path, MAINTENANCE, "最终激活的必须是深链 workspace");
        assert.ok(after.workspacePaths.includes("/workspace/previous"), "历史 tab 不丢");
        assert.equal(activeTask(MAINTENANCE), "task-cold");
        assert.deepEqual(globalThis.__drafts, [], "不得走默认草稿");
        assert.ok(committed.includes("task-cold"), "选中冷启动任务必须发布已查看事实以清除未读");
        assert.deepEqual(globalThis.__toasts, []);
        subscription.dispose();
        await m.unmount();
      },
    );

    await check(
      "冷启动深链带 canonical identity：沿用已恢复的同路径本地 tab，不重复开 tab",
      async () => {
        resetGlobals();
        installServices((params) => taskMeta(params));
        const settingService = {
          get: async () => ({ lastActiveWorkspace: { kind: "local", workspacePath: MAINTENANCE } }),
          update: async () => {},
        };
        const m = await mountReady({
          settingService,
          initial: {
            workspacePath: MAINTENANCE,
            workspaceIdentity: "canonical:maint",
            taskId: "task-cold",
          },
        });
        await settle(100);
        assert.deepEqual(snapshot(m.api()).workspacePaths, [MAINTENANCE]);
        assert.equal(activeTask(MAINTENANCE), "task-cold");
        await m.unmount();
      },
    );
  }

  return { runSuite };
}

// ---------------------------------------------------------------------------
// 第 5 部分：终态通知收集（真实 taskNotificationOrchestrator）。
// ---------------------------------------------------------------------------
const ORCHESTRATOR_ENTRY = `
  export { collectTerminalTaskNotificationPayloads } from "@/lib/taskNotificationOrchestrator.js";
`;

async function runTerminalNotificationSuite(mod) {
  console.log("终态通知收集：collectTerminalTaskNotificationPayloads");
  const formatMessage = ({ id }, values) => (values?.title ? `${id}:${values.title}` : String(id));
  const session = (sessionId, phase, title = "demo") => ({ sessionId, phase, title });
  const collect = (previousPhase, nextPhase, extra = {}) =>
    mod.collectTerminalTaskNotificationPayloads({
      previousBySessionId: new Map(
        previousPhase === null ? [] : [["s1", session("s1", previousPhase)]],
      ),
      sessions: [session("s1", nextPhase)],
      formatMessage,
      ...extra,
    });

  await check(
    "completedSuccess 产生完成通知，error 产生失败通知，并携带 workspace 上下文",
    async () => {
      const workspace = { workspacePath: "/repo", workspaceIdentity: "id-1" };
      const [completed] = collect("running", "completedSuccess", { workspace });
      assert.equal(completed.status, "completed");
      assert.equal(completed.taskId, "s1");
      assert.equal(completed.title, "notification.completed");
      assert.equal(completed.workspacePath, "/repo");
      assert.equal(completed.workspaceIdentity, "id-1");

      const failed = collect("running", "error");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].status, "failed");
      assert.equal(failed[0].title, "notification.error");
    },
  );

  await check(
    "completedInterrupted（主动停止或发新消息打断旧回合）不发任何通知，含从各前态进入",
    async () => {
      for (const previous of ["running", "completedSuccess", "error", "idle"]) {
        assert.deepEqual(
          collect(previous, "completedInterrupted"),
          [],
          `${previous} -> interrupted`,
        );
      }
      // 一批会话里只有中断的会话被静默，其余终态照常通知。
      const payloads = mod.collectTerminalTaskNotificationPayloads({
        previousBySessionId: new Map([
          ["s1", session("s1", "running")],
          ["s2", session("s2", "running")],
          ["s3", session("s3", "running")],
        ]),
        sessions: [
          session("s1", "completedInterrupted"),
          session("s2", "completedSuccess"),
          session("s3", "error"),
        ],
        formatMessage,
      });
      assert.deepEqual(
        payloads.map((payload) => [payload.taskId, payload.status]),
        [
          ["s2", "completed"],
          ["s3", "failed"],
        ],
      );
    },
  );

  await check("首次出现的会话与重复终态不通知", async () => {
    assert.deepEqual(collect(null, "completedSuccess"), [], "没有前态：不是状态迁移");
    assert.deepEqual(collect("completedSuccess", "completedSuccess"), [], "终态未变化");
    assert.deepEqual(collect("error", "error"), []);
  });
}

// ---------------------------------------------------------------------------
// 第 5 部分：独立 Web 连接恢复（真实 main.tsx 源码段）。
// ---------------------------------------------------------------------------
async function runStandaloneConnectionSuite() {
  console.log("独立 Web 首屏零 Banner 与重连：packages/web/src/main.tsx");
  const source = readFileSync(join(repoRoot, "packages/web/src/main.tsx"), "utf8");
  const from = source.indexOf("// 首次连接超过该时间仍未连上才显示连接提示");
  const to = source.indexOf("async function bootstrapWebApp");
  assert.ok(from > 0 && to > from, "未找到 createStandaloneWebConnection 源码段");
  const { code } = await esbuild.transform(source.slice(from, to), { loader: "ts" });
  const load = new Function(
    "setTimeout",
    "clearTimeout",
    "createWebRemoteControlLifecycleRecovery",
    `${code}
return {
  createStandaloneWebConnection,
  constants: {
    idlePulse: STANDALONE_IDLE_PULSE_TIMEOUT_MS,
    recoverPulse: STANDALONE_RECOVER_PULSE_TIMEOUT_MS,
  },
};`,
  );
  const realSetImmediate = setImmediate;
  const flush = async () => {
    for (let index = 0; index < 8; index += 1) await new Promise((done) => realSetImmediate(done));
  };

  // 假定时器：只记录登记的延迟，由用例按延迟手动触发，既不等待真实时间，也能精确断言 0ms / 退避 / 超时值。
  function createHarness({ initialAccessVerified, connect, checkAccess }) {
    const timers = new Map();
    let nextId = 1;
    const fakeSetTimeout = (callback, delay) => {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    };
    const fakeClearTimeout = (id) => void timers.delete(id);
    let lifecycle = null;
    const { createStandaloneWebConnection, constants } = load(
      fakeSetTimeout,
      fakeClearTimeout,
      (options) => {
        lifecycle = options;
        return { dispose() {} };
      },
    );
    const log = { states: [], ready: 0, connects: 0, accessChecks: 0, infoCalls: 0 };
    const makeServices = (info) => ({
      systemService: {
        info: () => {
          log.infoCalls += 1;
          return info();
        },
      },
      broadcastService: { onMessage: () => ({ dispose() {} }) },
      settingService: {},
    });
    const connection = createStandaloneWebConnection({
      initialAccessVerified,
      connect: async (options) => {
        log.connects += 1;
        return connect(options, makeServices, log);
      },
      checkAccess: async (signal) => {
        log.accessChecks += 1;
        return checkAccess ? checkAccess(signal, log) : true;
      },
      onReady: () => void (log.ready += 1),
      onState: (state) => void log.states.push(state),
      windowTarget: { addEventListener() {}, removeEventListener() {} },
      documentTarget: {
        addEventListener() {},
        removeEventListener() {},
        visibilityState: "visible",
      },
    });
    const pendingDelays = () => [...timers.values()].map((timer) => timer.delay);
    const fire = async (delay) => {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `没有登记 ${delay}ms 的定时器，当前：${JSON.stringify(pendingDelays())}`);
      timers.delete(entry[0]);
      entry[1].callback();
      await flush();
    };
    return {
      connection,
      constants,
      log,
      pendingDelays,
      fire,
      recover: async () => {
        lifecycle.onRecover();
        await flush();
      },
    };
  }
  const healthy = (_options, makeServices) => makeServices(() => Promise.resolve({}));

  await check(
    "首屏已确认登录态：首连不再请求 server-info，只有一次握手往返且无首包探活",
    async () => {
      const h = createHarness({ initialAccessVerified: true, connect: healthy });
      await flush();
      assert.equal(h.log.accessChecks, 0, "不得重复访问检查");
      assert.equal(h.log.connects, 1);
      assert.equal(h.log.infoCalls, 0, "连上后不再额外发 info 探活往返");
      assert.deepEqual(h.log.states, ["connecting", "connected"]);
      assert.equal(h.log.ready, 1);
      assert.ok(h.pendingDelays().includes(25_000), "连上后登记 25s 空闲心跳");
      h.connection.dispose();
    },
  );

  await check("首屏登录态未知：先检查访问再握手；检查失败进入 auth-required 且不握手", async () => {
    const unknown = createHarness({ initialAccessVerified: false, connect: healthy });
    await flush();
    assert.equal(unknown.log.accessChecks, 1);
    assert.equal(unknown.log.connects, 1);
    unknown.connection.dispose();

    const denied = createHarness({
      initialAccessVerified: false,
      connect: healthy,
      checkAccess: () => false,
    });
    await flush();
    assert.equal(denied.log.connects, 0);
    assert.deepEqual(denied.log.states, ["connecting", "auth-required"]);
    denied.connection.dispose();
  });

  await check("已验证登录态后握手失败：只用一次访问检查区分鉴权失效与普通断线", async () => {
    const expired = createHarness({
      initialAccessVerified: true,
      connect: ({ onClose }) => {
        // 真实 WebSocket 适配器拒绝握手时也同步通知 onClose。
        onClose();
        return Promise.reject(new Error("WebSocket connection closed"));
      },
      checkAccess: () => false,
    });
    await flush();
    assert.equal(expired.log.accessChecks, 1);
    assert.equal(expired.log.states.at(-1), "auth-required");
    assert.deepEqual(expired.pendingDelays(), [], "鉴权失效不重试");
    expired.connection.dispose();

    const offline = createHarness({
      initialAccessVerified: true,
      connect: () => Promise.reject(new Error("offline")),
      checkAccess: () => {
        throw new Error("network down");
      },
    });
    await flush();
    assert.equal(offline.log.states.at(-1), "reconnecting");
    assert.deepEqual(offline.pendingDelays(), [0], "第一次重连不等待");
    offline.connection.dispose();
  });

  await check("切后台恢复：2.5s 快速探活失败后 0ms 立即重连，单往返、不再检查访问", async () => {
    let calls = 0;
    const h = createHarness({
      initialAccessVerified: true,
      connect: (_options, makeServices) => {
        calls += 1;
        // 第一代连接的 info 永不返回，模拟被系统冻结的死连接。
        return makeServices(calls === 1 ? () => new Promise(() => {}) : () => Promise.resolve({}));
      },
    });
    await flush();
    assert.deepEqual(h.log.states, ["connecting", "connected"]);

    await h.recover();
    assert.ok(
      h.pendingDelays().includes(h.constants.recoverPulse),
      `恢复探活超时应为 ${h.constants.recoverPulse}ms`,
    );
    assert.equal(h.constants.recoverPulse, 2_500);
    await h.fire(2_500);
    assert.equal(h.log.states.at(-1), "reconnecting");
    assert.ok(h.pendingDelays().includes(0), "重连延迟必须为 0ms");
    assert.ok(!h.pendingDelays().includes(1_000), "不能先等 1 秒");
    await h.fire(0);
    assert.equal(h.log.connects, 2, "只多一次握手往返");
    assert.equal(h.log.accessChecks, 0, "曾连上过：不重复检查访问");
    assert.equal(h.log.states.at(-1), "connected");
    h.connection.dispose();

    const idle = createHarness({
      initialAccessVerified: true,
      connect: (_options, makeServices) => makeServices(() => new Promise(() => {})),
    });
    await flush();
    await idle.fire(25_000);
    assert.deepEqual(idle.pendingDelays(), [10_000]);
    await idle.recover();
    assert.equal(idle.log.infoCalls, 1, "恢复时沿用已发出的心跳请求");
    assert.deepEqual(idle.pendingDelays(), [2_500]);
    await idle.fire(2_500);
    assert.deepEqual(idle.pendingDelays(), [0]);
    idle.connection.dispose();
  });

  await check("空闲心跳 10s 超时；连续失败按 0、1s、2s、4s、8s 退避，恢复事件清零", async () => {
    const idle = createHarness({ initialAccessVerified: true, connect: healthy });
    await flush();
    await idle.fire(25_000);
    assert.equal(idle.constants.idlePulse, 10_000);
    idle.connection.dispose();

    const h = createHarness({
      initialAccessVerified: true,
      connect: () => Promise.reject(new Error("down")),
    });
    await flush();
    const delays = [];
    for (let index = 0; index < 6; index += 1) {
      const [delay] = h.pendingDelays();
      delays.push(delay);
      await h.fire(delay);
    }
    assert.deepEqual(delays, [0, 1_000, 2_000, 4_000, 8_000, 8_000]);
    // 回到前台是新的恢复窗口：正在退避等待也立即重试，且之后再失败又从 0ms 开始。
    const before = h.log.connects;
    await h.recover();
    assert.equal(h.log.connects, before + 1, "恢复事件应立即重连");
    assert.deepEqual(h.pendingDelays(), [0]);
    h.connection.dispose();
  });

  await check(
    "main.tsx 源码：仅首连等待 3 秒后提示，登录过期立即提示，普通重连不弹横幅",
    async () => {
      assert.match(source, /STANDALONE_INITIAL_CONNECT_HINT_DELAY_MS = 3_000/u);
      const bootstrapAt = source.indexOf("async function bootstrapWebApp");
      const standalone = source.slice(source.indexOf("const coldLaunchTarget", bootstrapAt));
      // 首连成功前（services 为空且提示未显示）不渲染，保留 #root 中的启动动画。
      assert.match(standalone, /if \(!services && !showConnectionHint\) return;\s*root\.render\(/u);
      assert.equal((standalone.match(/root\.render\(/gu) ?? []).length, 1);
      assert.doesNotMatch(standalone, /root\.(unmount|replaceChildren)|innerHTML\s*=/u);
      assert.equal((standalone.match(/setTimeout\(/gu) ?? []).length, 1);
      assert.match(
        standalone,
        /if \(!authRequiredAtStart\) \{\s*connectionHintTimer = setTimeout\([\s\S]*?STANDALONE_INITIAL_CONNECT_HINT_DELAY_MS\);\s*startConnection\(\);/u,
        "只在首屏建连前启动提示计时器，不在连接状态变化时重设",
      );
      assert.match(standalone, /let showConnectionHint = authRequiredAtStart;/u);
      assert.match(
        standalone,
        /if \(next === "connected" \|\| next === "auth-required"\) \{\s*clearTimeout\(connectionHintTimer\);\s*showConnectionHint = next === "auth-required";/u,
        "连接成功关闭提示；登录失效立即提示",
      );
      assert.match(standalone, /initialAccessVerified: bootstrap\.initialAccessState === "ok"/u);
    },
  );

  await check(
    "main.tsx 源码：首连不重复请求 /api/server-info，且无 inert 与焦点恢复残留",
    async () => {
      // 请求只出现在 resolveWebBootstrap 与 checkAccess 两处；首连成功路径只经过前者。
      const fetches = source.match(/fetch\("\/api\/server-info"/gu) ?? [];
      assert.equal(fetches.length, 2, "server-info 只应在首屏 bootstrap 与 checkAccess 请求");
      assert.match(source, /const skippedAccessCheck = hadReady \|\| accessVerified;/u);
      assert.doesNotMatch(source, /inert/u, "重连期间不得再锁定页面");
      for (const leftover of [
        "StandaloneFocusRestore",
        "focusRestoreStore",
        "captureStandaloneFocusForRestore",
        "restoreStandaloneFocusAfterReconnect",
        "StandaloneFocusRestoreEffect",
      ]) {
        assert.ok(!source.includes(leftover), `main.tsx 仍残留 ${leftover}`);
      }
      assert.doesNotMatch(source, /useLayoutEffect/u, "焦点恢复移除后不应遗留未使用的导入");
    },
  );
}

// ---------------------------------------------------------------------------
// 静态产物：PWA manifest 与入口 HTML。
// ---------------------------------------------------------------------------
function readPngSize(file) {
  const bytes = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.subarray(0, 8).equals(signature), `${file} 不是合法 PNG`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `${file} 缺少 IHDR`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function runStaticAssetSuite() {
  console.log("静态产物：manifest 与 index.html");
  const publicDir = join(repoRoot, "packages/web/public");

  await check("manifest.webmanifest：id、图标与 PNG 尺寸头", async () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.id, "/");
    assert.equal(manifest.display, "standalone");
    assert.ok(Array.isArray(manifest.icons), "icons 必须是数组");
    const find = (size, purpose) =>
      manifest.icons.find((icon) => icon.sizes === size && icon.purpose === purpose);
    for (const icon of [
      find("192x192", "any"),
      find("512x512", "any"),
      find("512x512", "maskable"),
    ]) {
      assert.ok(icon, "缺少 192/512/maskable 图标之一");
      assert.equal(icon.type, "image/png");
      const file = join(publicDir, icon.src.replace(/^\//u, ""));
      assert.ok(existsSync(file), `图标文件不存在：${icon.src}`);
      const [width, height] = icon.sizes.split("x").map(Number);
      assert.deepEqual(readPngSize(file), { width, height }, `${icon.src} 尺寸与声明不符`);
    }
  });

  await check("index.html：manifest 带凭据、apple-touch-icon 与 black-translucent", async () => {
    const html = readFileSync(join(repoRoot, "packages/web/index.html"), "utf8");
    assert.match(
      html,
      /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s+crossorigin="use-credentials"/u,
    );
    const touch = html.match(/<link\s+rel="apple-touch-icon"\s+href="([^"]+)"/u);
    assert.ok(touch, "缺少 apple-touch-icon");
    const touchFile = join(publicDir, touch[1].replace(/^\//u, ""));
    assert.ok(existsSync(touchFile), `apple-touch-icon 文件不存在：${touch[1]}`);
    const size = readPngSize(touchFile);
    assert.ok(
      size.width === size.height && size.width >= 180,
      "apple-touch-icon 应为不小于 180 的正方形",
    );
    assert.match(
      html,
      /name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/u,
    );
    assert.match(html, /name="apple-mobile-web-app-capable"\s+content="yes"/u);
    assert.ok(existsSync(join(publicDir, "zcode-push-sw.js")), "缺少 Service Worker 脚本");
  });
}

// ---------------------------------------------------------------------------
// 主流程：全部串行。
// ---------------------------------------------------------------------------
const workDir = await mkdtemp(join(tmpdir(), "zcode-web-push-"));
try {
  console.log("后端 Web Push 套件：packages/server/test/web-push.test.ts");
  const serverOut = join(workDir, "server-web-push.test.mjs");
  await bundleNodeTest(join(repoRoot, "packages/server/test/web-push.test.ts"), serverOut);
  await check("node --test 退出码为 0", async () => {
    const counts = runNodeTestSuite("server web-push.test.ts", serverOut);
    console.log(`      tests=${counts.tests} pass=${counts.pass}`);
  });

  console.log("前端平台通知与 SW 套件：packages/web/test/web-notifications-platform.test.ts");
  const webOut = join(workDir, "web-notifications-platform.test.mjs");
  await bundleNodeTest(
    join(repoRoot, "packages/web/test/web-notifications-platform.test.ts"),
    webOut,
    { pinSourceUrl: true },
  );
  await check("node --test 退出码为 0", async () => {
    const counts = runNodeTestSuite("web web-notifications-platform.test.ts", webOut);
    console.log(`      tests=${counts.tests} pass=${counts.pass}`);
  });

  const win = installDom();
  const uiOut = join(workDir, "ui.mjs");
  await bundleUi(UI_ENTRY, uiOut, { "ui:i18n/IntlProvider": INTL_STUB });
  const suite = createSuite(await import(pathToFileURL(uiOut).href), win);
  await suite.runWebWorkbenchSuite();
  await suite.runMobileProxySuite();
  await suite.runDesktopSuite();

  const navOut = join(workDir, "notification-navigation.mjs");
  await bundleUi(
    NAV_ENTRY,
    navOut,
    {
      "ui:i18n/IntlProvider": INTL_STUB,
      "ui:components/ui/toast": TOAST_STUB,
      "ui:hooks/useWorkspaceServices": WORKSPACE_SERVICES_STUB,
      "ui:hooks/useServices": SERVICES_STUB,
      "ui:WebRemoteControlThemeMenu": NULL_COMPONENT_STUB,
      "ui:web-remote-control/index": NULL_COMPONENT_STUB,
    },
    { banner: NODE_TEST_BANNER },
  );
  const navMod = await import(pathToFileURL(navOut).href);
  await createNavigationSuite(navMod, win).runSuite();

  const orchestratorOut = join(workDir, "task-notification-orchestrator.mjs");
  await bundleUi(ORCHESTRATOR_ENTRY, orchestratorOut, {});
  await runTerminalNotificationSuite(await import(pathToFileURL(orchestratorOut).href));
  await runStandaloneConnectionSuite();
  await runStaticAssetSuite();
  console.log(`standalone-web-push: ${passed} checks passed`);
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
// react-dom 内部的 scheduler 可能遗留 MessagePort 句柄；走到这里说明所有断言已通过
// （失败会在上方抛出并以非 0 退出），显式退出避免脚本挂起。
process.exit(0);
