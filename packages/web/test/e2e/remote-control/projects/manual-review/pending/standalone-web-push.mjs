// 独立 Web 后台推送（Web Push）一体化定向回归：本地 esbuild 打包真实源码，不连接任何真实 Host，
// 不触碰用户数据。三部分检查串行执行：
//  1. 后端 Web Push 套件：esbuild 打包 packages/server/test/web-push.test.ts，子进程 `node --test`，退出码必须为 0。
//  2. 前端平台通知与 SW 套件：esbuild 打包 packages/web/test/web-notifications-platform.test.ts，同样以 `node --test` 运行。
//  3. 真实 UI 组件 jsdom + react-dom 渲染与交互回归。被测的是真实源码模块：
//       packages/ui/src/settingsPageHelpers.tsx（GeneralSectionContent，即设置页“常规”分区）
//       packages/ui/src/settings-search/SettingsSearch.tsx 与 settingsSearchIndex.ts（SETTINGS_SEARCH_ITEMS）
//     仅把 i18n Provider 换成读取真实 zh-CN / en-US 词表的最小桩（缺 key 直接抛错）。
//     并校验静态产物 packages/web/public/manifest.webmanifest 与 packages/web/index.html。
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

async function bundleUi(contents, outfile, stubs) {
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
  await runStaticAssetSuite();
  console.log(`standalone-web-push: ${passed} checks passed`);
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
// react-dom 内部的 scheduler 可能遗留 MessagePort 句柄；走到这里说明所有断言已通过
// （失败会在上方抛出并以非 0 退出），显式退出避免脚本挂起。
process.exit(0);
