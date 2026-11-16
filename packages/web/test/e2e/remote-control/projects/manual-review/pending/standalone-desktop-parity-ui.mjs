// 独立 Web 与桌面能力对齐（UI 侧）的隔离回归：本地 esbuild 打包真实源码 + jsdom/react-dom 渲染，
// 不连接任何真实 Host，不触碰用户数据。
//
// 对应 docs/standalone-web-task-and-project-compat.md、docs/git/worktree.md §3.1/§3.6、
// docs/ui/assistant-code-comment-cards.md。被测的是真实源码模块：
//   packages/ui/src/TaskActionMenuContent.tsx
//   packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx
//   packages/ui/src/project-sidebar/ProjectEditor.tsx
//   packages/ui/src/project-sidebar/ManagedWorktreesDialog.tsx
//   packages/client/src/websocket.ts（含真实 RemoteServiceAccess、ProxyChannel）
// 仅把与本场景无关的依赖替换为最小桩：i18n Provider（改读真实 zh-CN / en-US 词表，缺 key 直接抛错）；
// 菜单组件的 Radix ContextMenu / Tooltip 换成同形态的普通元素（Radix 右键需要真实指针事件）。
//
// 覆盖（共 26 项检查）：
// 任务菜单：TaskActionMenuContent（侧栏与顶栏共用）与 GroupedTaskContextMenuContent（侧栏右键）各 6 项：
//  1. canOpenLocalFiles=false + onOpenTaskFiles：显示「显示文件树」、点击只触发 onOpenTaskFiles；
//     不渲染「在文件管理器中打开」与「前往配置」（zh-CN 与 en-US 文案各验一次，共 2 项）。
//  2. canOpenLocalFiles=false 无 onOpenTaskFiles（顶栏）：三项均不渲染。
//  3. 手机远控（hideMobileUnsupportedActions，或侧栏不传 onOpenTaskFiles 且无本机能力）：三项均不渲染。
//  4. canOpenLocalFiles=true 或缺省（桌面）：保持原样，文件管理器与「前往配置」可点击，不出现「显示文件树」。
//  5. 只读禁用态下「显示文件树」为禁用，点击不触发回调。
// 项目编辑器（ProjectEditor）：
//  6. 独立 Web 编辑既有项目：移除最后一个目录后保存 roots: []，且不渲染 standaloneAutoRootHint。
//  7. 独立 Web 多目录：每行都有移除入口。
//  8. 独立 Web 新建项目：不渲染自动目录提示文案，空态浏览入口可用。
//  9. 真实远端既有项目：不渲染移除/添加目录入口，保存仍携带原目录。
// 10. 桌面（有 selectDirectories）本地项目：移除入口保持可用。
// 11. 两份词表均已移除 project.standaloneAutoRootHint，源码树 0 残留引用。
// 受管 Worktree 弹窗（ManagedWorktreesDialog）：
// 12. canOpenLocalFiles=false：不渲染文件管理器按钮，复制路径、删除仍在。
// 13. canOpenLocalFiles=true（桌面对照）：渲染文件管理器按钮。
// 连接装配（connectViaWebSocket + RemoteServiceAccess）：
// 14. 缺省与 managedWorktreeService=false：不创建 managedWorktreeService 代理。
// 15. managedWorktreeService=true：创建代理，且不影响 windowControllerService 缺省关闭。
// 能力协商（/api/server-info）：
// 16. serverRemoteInfoSchema 与 serverRemoteInfoOutputSchema 接受可选 managedWorktrees: true，缺省为 undefined，
//     拒绝 false/字符串，严格输出仍拒绝未知能力。
// 17. 真实 resolveWebBootstrap（抽取 main.tsx 源码段执行）：仅在 capabilities.managedWorktrees === true 时开启；
//     能力缺省、非 true、!response.ok、fetch 抛错均不设置；`?remote=` 不读取 server-info 且不开启。
// 入口装配（源码级断言）：
// 18. web/main.tsx：独立 Root 开启 assistantCodeCommentCardsEnabled（home-only 保持关闭）；
//     `?remote=` 分支不带 managedWorktrees。
// 19. project-sidebar/index.tsx：受管 Worktree 入口不再依赖 isDesktop，仍排除手机远控。
//
// 渲染依赖 jsdom + react-dom（与 react 同目录）。依赖查找顺序：ZCODE_ISOLATION_NODE_MODULES（路径分隔符分隔）、
// 仓库自身 node_modules、验证工具目录，最后是与仓库同级的 ZCode-upstream-3.18.2/node_modules（维护工作区布局）。
//
// 运行（仓库根目录；至少需要 esbuild、jsdom、react、react-dom）：
//   node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-desktop-parity-ui.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function resolveWorkspacePackage(spec) {
  const [, name, ...rest] = spec.split("/");
  const packageDir = join(repoRoot, "packages", name);
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let target = manifest.exports?.[rest.length ? `./${rest.join("/")}` : "."];
  if (target && typeof target === "object") target = target.default ?? target.import;
  return typeof target === "string" ? resolve(packageDir, target) : null;
}

function createPlugin(stubs) {
  return {
    name: "standalone-desktop-parity-isolation",
    setup(build) {
      const stubNs = "isolation-stub";
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        let absolute = null;
        if (spec.startsWith("@/")) {
          absolute = resolveTsCandidate(join(uiSrc, spec.slice(2)));
        } else if (spec.startsWith("@zcode/")) {
          absolute = resolveWorkspacePackage(spec);
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

async function bundle(contents, outfile, stubs) {
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

// ---------------------------------------------------------------------------
// 桩与入口。
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
    const locale = globalThis.__parityLocale ?? "zh-CN";
    cache[locale] ??= { intl: createIntl(locale), locale, localeResolved: true };
    return cache[locale];
  }
`;

// Radix ContextMenu 只能经真实右键指针事件打开；这里换成同形态普通元素，只验证条目是否渲染与回调。
const CONTEXT_MENU_STUB = `
  import { createElement as h } from "react";
  const box = (tag) => ({ children, ...rest }) => h(tag, rest, children);
  export const ContextMenuContent = box("div");
  export const ContextMenuSub = box("div");
  export const ContextMenuSubContent = box("div");
  export const ContextMenuSubTrigger = ({ children, disabled, title, ...rest }) =>
    h("button", { type: "button", disabled, title, ...rest }, children);
  export const ContextMenuSeparator = () => h("hr");
  export const ContextMenuItem = ({ children, disabled, title, onSelect, ...rest }) =>
    h("button", { type: "button", "data-menu-item": "", disabled, title, onClick: onSelect, ...rest }, children);
`;
const TOOLTIP_STUB = `
  export const SidebarNativeTooltip = ({ children }) => children;
  export const ControlHintTooltip = ({ children }) => children;
`;

const MOUNT_HELPERS = `
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
`;

const MENU_ENTRY = `
  ${MOUNT_HELPERS}
  export { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
  export { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
  export { createIntl } from "@/i18n/IntlProvider.js";
  export const MenuItem = ({ children, disabled, onSelect, title }) =>
    h("button", { type: "button", "data-menu-item": "", disabled, title, onClick: onSelect }, children);
  export const MenuSeparator = () => h("hr");
`;

const DIALOG_ENTRY = `
  ${MOUNT_HELPERS}
  export { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
  export { ManagedWorktreesDialog } from "@/project-sidebar/ManagedWorktreesDialog.js";
  export { PlatformProvider } from "@/hooks/usePlatform.js";
  export { TooltipProvider } from "@/components/ui/tooltip.js";
  import zhCN from "@/i18n/locales/zh-CN.js";
  import enUS from "@/i18n/locales/en-US.js";
  export const LOCALES = { "zh-CN": zhCN, "en-US": enUS };
`;

const SCHEMA_ENTRY = `
  export {
    serverRemoteInfoOutputSchema,
    serverRemoteInfoSchema,
  } from ${JSON.stringify(join(repoRoot, "packages/shared/src/server-remote.ts"))};
`;

const CLIENT_ENTRY = `
  export { connectViaWebSocket } from ${JSON.stringify(join(repoRoot, "packages/client/src/websocket.ts"))};
`;

// ---------------------------------------------------------------------------
// jsdom 全局：react-dom 与 Radix 需要真实 DOM、ResizeObserver 与 jsdom 自己的 Event 类。
// ---------------------------------------------------------------------------
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// 检查工具。
// ---------------------------------------------------------------------------
let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const settle = (act, ms = 20) =>
  act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });

function click(act, element) {
  assert.ok(element, "待点击元素不存在");
  return act(async () => {
    element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const menuLabels = (container) =>
  [...container.querySelectorAll("[data-menu-item]")].map((node) => node.textContent.trim());
const findItem = (container, label) =>
  [...container.querySelectorAll("[data-menu-item]")].find(
    (node) => node.textContent.trim() === label,
  );

const LABELS = {
  "zh-CN": { tree: "显示文件树", manager: "在文件管理器中打开", config: "前往配置" },
  "en-US": { tree: "Show file tree", manager: "Open in File Manager", config: "Go to config" },
};

// ---------------------------------------------------------------------------
// 任务菜单：TaskActionMenuContent 与 GroupedTaskContextMenuContent 共用同一组断言。
// ---------------------------------------------------------------------------
function createMenuCases(mod, locale) {
  const intl = mod.createIntl(locale);
  const calls = () => ({ manager: 0, tree: 0, config: 0 });
  const common = (counter, extra = {}) => ({
    intl,
    fileManagerLabel: LABELS[locale].manager,
    taskSessionFile: { loading: false, path: "/data/session.json", exists: true },
    taskNativeSessionLogFile: { loading: false, path: "/data/session.log", exists: true },
    providerConfigFile: { loading: false, path: "/data/provider.json", exists: true },
    onOpenTaskPathInFileManager: () => void (counter.manager += 1),
    onOpenProviderConfig: () => void (counter.config += 1),
    ...extra,
  });
  const task = {
    taskId: "task-1",
    workspacePath: "/workspace/app",
    title: "任务",
    projectId: "p1",
    hostId: "local",
  };
  return {
    calls,
    renderers: {
      action: (counter, extra) =>
        mod.mountElement(
          mod.h(mod.TaskActionMenuContent, {
            ...common(counter),
            isPinned: false,
            Item: mod.MenuItem,
            Separator: mod.MenuSeparator,
            onTogglePinTask() {},
            onStartRenameTask() {},
            onCopyWorkspacePath() {},
            onCopyTaskPath() {},
            onCopyTaskLogPath() {},
            ...extra,
          }),
        ),
      grouped: (counter, extra) =>
        mod.mountElement(
          mod.h(mod.GroupedTaskContextMenuContent, {
            ...common(counter),
            task,
            groups: [],
            onMoveTaskToGroup() {},
            onMoveTaskToTop() {},
            onStartRenameTask() {},
            onArchiveTask() {},
            onMarkTaskAsUnread() {},
            onCopyText() {},
            onOpenTaskFeedback() {},
            ...extra,
            // grouped 版本的禁用入口是 disabledReason，统一在下面按组件转换。
          }),
        ),
    },
  };
}

async function runMenuSuite(mod) {
  const variants = [
    {
      name: "TaskActionMenuContent",
      kind: "action",
      disable: { disableTaskActions: true, disabledReason: "只读" },
    },
    { name: "GroupedTaskContextMenuContent", kind: "grouped", disable: { disabledReason: "只读" } },
  ];
  for (const variant of variants) {
    console.log(`任务菜单：${variant.name}`);
    for (const locale of ["zh-CN", "en-US"]) {
      const L = LABELS[locale];
      const { calls, renderers } = createMenuCases(mod, locale);
      const render = renderers[variant.kind];

      await check(
        `${locale} canOpenLocalFiles=false + onOpenTaskFiles：显示文件树，隐藏文件管理器与前往配置`,
        async () => {
          const counter = calls();
          const mounted = await render(counter, {
            canOpenLocalFiles: false,
            onOpenTaskFiles: () => void (counter.tree += 1),
          });
          const labels = menuLabels(mounted.container);
          assert.ok(labels.includes(L.tree), `缺少「${L.tree}」：${labels.join("|")}`);
          assert.ok(!labels.includes(L.manager), "不应出现文件管理器入口");
          assert.ok(!labels.includes(L.config), "不应出现前往配置入口");
          await click(mod.act, findItem(mounted.container, L.tree));
          assert.deepEqual(counter, { manager: 0, tree: 1, config: 0 });
          await mounted.unmount();
        },
      );

      if (locale !== "zh-CN") continue;

      await check("canOpenLocalFiles=false 无 onOpenTaskFiles（顶栏）：三项均不渲染", async () => {
        const counter = calls();
        const mounted = await render(counter, { canOpenLocalFiles: false });
        const labels = menuLabels(mounted.container);
        for (const label of [L.tree, L.manager, L.config]) {
          assert.ok(!labels.includes(label), `不应出现「${label}」`);
        }
        await mounted.unmount();
      });

      if (variant.kind === "action") {
        await check("hideMobileUnsupportedActions（手机远控）：三项均不渲染", async () => {
          const counter = calls();
          const mounted = await render(counter, {
            canOpenLocalFiles: false,
            hideMobileUnsupportedActions: true,
            onOpenTaskFiles: () => void (counter.tree += 1),
          });
          const labels = menuLabels(mounted.container);
          for (const label of [L.tree, L.manager, L.config]) {
            assert.ok(!labels.includes(label), `不应出现「${label}」`);
          }
          await mounted.unmount();
        });
      } else {
        await check("手机远控侧栏（不传 onOpenTaskFiles 且无本机能力）：三项均不渲染", async () => {
          const counter = calls();
          const mounted = await render(counter, {
            canOpenLocalFiles: false,
            onOpenTaskFiles: undefined,
          });
          const labels = menuLabels(mounted.container);
          for (const label of [L.tree, L.manager, L.config]) {
            assert.ok(!labels.includes(label), `不应出现「${label}」`);
          }
          await mounted.unmount();
        });
      }

      await check("canOpenLocalFiles=true / 缺省（桌面）：保持原样，不出现显示文件树", async () => {
        for (const explicit of [true, undefined]) {
          const counter = calls();
          const mounted = await render(counter, {
            ...(explicit === undefined ? {} : { canOpenLocalFiles: explicit }),
            onOpenTaskFiles: () => void (counter.tree += 1),
          });
          const labels = menuLabels(mounted.container);
          assert.ok(labels.includes(L.manager), "桌面应保留文件管理器入口");
          assert.ok(labels.includes(L.config), "桌面应保留前往配置入口");
          assert.ok(!labels.includes(L.tree), "桌面不应出现显示文件树");
          await click(mod.act, findItem(mounted.container, L.manager));
          await click(mod.act, findItem(mounted.container, L.config));
          assert.deepEqual(counter, { manager: 1, tree: 0, config: 1 });
          await mounted.unmount();
        }
      });

      await check("禁用态（只读）下点击显示文件树不触发回调", async () => {
        const counter = calls();
        const mounted = await render(counter, {
          canOpenLocalFiles: false,
          onOpenTaskFiles: () => void (counter.tree += 1),
          ...variant.disable,
        });
        const item = findItem(mounted.container, L.tree);
        assert.ok(item?.disabled, "只读时显示文件树应为禁用态");
        await click(mod.act, item);
        assert.equal(counter.tree, 0);
        await mounted.unmount();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 项目编辑器与受管 Worktree 弹窗。
// ---------------------------------------------------------------------------
function makeProject(overrides = {}) {
  return {
    id: "project-1",
    hostId: "local",
    name: "演示项目",
    nameOverridden: true,
    roots: [{ rootPath: "/workspace/demo", position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeProjectService() {
  const saved = [];
  return {
    saved,
    async saveProject(input) {
      saved.push(input);
      return makeProject({
        id: input.id ?? "created",
        roots: (input.roots ?? []).map((rootPath, position) => ({
          rootPath,
          position,
          isPrimary: position === 0,
        })),
      });
    },
    async readTree() {
      return { projects: [], tasks: [] };
    },
    async readDirectory() {
      return { path: "/workspace", entries: [] };
    },
    async deleteProject() {},
  };
}

const q = (selector) => [...document.querySelectorAll(selector)];

async function runEditorSuite(mod) {
  console.log("项目编辑器：ProjectEditor");
  const standalonePlatform = {};
  const desktopPlatform = { selectDirectories: async () => [] };

  async function open({ platform, project, extra = {} }) {
    const service = makeProjectService();
    const events = { saved: 0, closed: 0 };
    const mounted = await mod.mountElement(
      mod.h(
        mod.PlatformProvider,
        { platform },
        mod.h(mod.ProjectEditor, {
          project,
          projects: project ? [project] : [],
          service,
          async onSaved() {
            events.saved += 1;
          },
          onClose() {
            events.closed += 1;
          },
          ...extra,
        }),
      ),
    );
    await settle(mod.act);
    return { service, events, mounted };
  }

  await check("独立 Web：移除最后一个目录后保存 roots: []，且无自动目录提示", async () => {
    const { service, events, mounted } = await open({
      platform: standalonePlatform,
      project: makeProject(),
    });
    assert.equal(q('[data-testid="virtual-project-remove-folder"]').length, 1);
    await click(mod.act, q('[data-testid="virtual-project-remove-folder"]')[0]);
    assert.equal(q('[data-testid="virtual-project-root-row"]').length, 0);
    assert.ok(q('[data-testid="virtual-project-browse"]').length === 1, "应回到空态浏览入口");
    await click(mod.act, q('[data-testid="virtual-project-save"]')[0]);
    await settle(mod.act);
    assert.equal(service.saved.length, 1);
    assert.equal(service.saved[0].id, "project-1");
    assert.deepEqual(service.saved[0].roots, []);
    assert.equal(events.saved, 1);
    assert.equal(events.closed, 1);
    await mounted.unmount();
  });

  await check("独立 Web 多目录：每个目录行都有移除入口", async () => {
    const project = makeProject({
      roots: [
        { rootPath: "/workspace/a", position: 0, isPrimary: true },
        { rootPath: "/workspace/b", position: 1, isPrimary: false },
      ],
    });
    const { mounted } = await open({ platform: standalonePlatform, project });
    assert.equal(q('[data-testid="virtual-project-root-row"]').length, 2);
    assert.equal(q('[data-testid="virtual-project-remove-folder"]').length, 2);
    await mounted.unmount();
  });

  await check("独立 Web 新建项目：不渲染自动目录提示，空态浏览入口可用", async () => {
    const { mounted } = await open({ platform: standalonePlatform, project: null });
    const text = document.body.textContent;
    assert.ok(!text.includes("未选择文件夹时"), "不应出现旧的自动目录提示（zh-CN）");
    assert.ok(!/With no folder selected/u.test(text), "不应出现旧的自动目录提示（en-US）");
    assert.equal(q('[data-testid="virtual-project-browse"]').length, 1);
    assert.equal(q('[data-testid="virtual-project-remove-folder"]').length, 0);
    await mounted.unmount();
  });

  await check("真实远端既有项目：目录编辑入口禁用，保存仍携带原目录", async () => {
    const project = makeProject({
      id: "remote-project",
      hostId: "remote-host",
      roots: [{ rootPath: "/srv/repo", position: 0, isPrimary: true }],
    });
    const { service, mounted } = await open({ platform: standalonePlatform, project });
    assert.equal(q('[data-testid="virtual-project-root-row"]').length, 1);
    assert.equal(q('[data-testid="virtual-project-remove-folder"]').length, 0);
    assert.equal(q('[data-testid="virtual-project-browse"]').length, 0);
    await click(mod.act, q('[data-testid="virtual-project-save"]')[0]);
    await settle(mod.act);
    assert.equal(service.saved.length, 1);
    assert.deepEqual(service.saved[0].roots, ["/srv/repo"]);
    await mounted.unmount();
  });

  await check("桌面本地项目（有 selectDirectories）：移除入口保持可用", async () => {
    const { mounted } = await open({ platform: desktopPlatform, project: makeProject() });
    assert.equal(q('[data-testid="virtual-project-remove-folder"]').length, 1);
    await mounted.unmount();
  });

  await check("词表已移除 project.standaloneAutoRootHint，源码树 0 残留引用", async () => {
    const mod2 = mod;
    for (const [locale, table] of Object.entries(mod2.LOCALES)) {
      assert.ok(!("project.standaloneAutoRootHint" in table), `${locale} 仍含死 key`);
    }
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|mjs|md)$/u.test(entry.name) && full !== fileURLToPath(import.meta.url)) {
          if (readFileSync(full, "utf8").includes("standaloneAutoRootHint")) offenders.push(full);
        }
      }
    };
    for (const dir of ["packages/ui/src", "packages/web/src", "packages/client/src"]) {
      walk(join(repoRoot, dir));
    }
    assert.deepEqual(offenders, []);
  });
}

async function runWorktreeSuite(mod) {
  console.log("受管 Worktree 弹窗：ManagedWorktreesDialog");
  const worktree = {
    path: "/workspace/.worktrees/app/a1",
    sourceRoot: "/workspace/app",
    bucket: "a1",
    branchName: "feature/demo",
    head: "0123456789abcdef",
    state: "ready",
    dirty: false,
    creating: false,
    tasks: [],
  };

  async function open(platform) {
    const service = {
      async listWorktrees() {
        return { groups: [{ sourceRoot: "/workspace/app", worktrees: [worktree] }] };
      },
      async removeWorktree() {
        return { ok: true };
      },
      async pruneWorktrees() {},
    };
    const mounted = await mod.mountElement(
      mod.h(
        mod.PlatformProvider,
        { platform: { getInstalledEditors: async () => [], ...platform } },
        mod.h(
          mod.TooltipProvider,
          null,
          mod.h(mod.ManagedWorktreesDialog, {
            project: makeProject({ id: "p1", name: "App" }),
            service,
            onClose() {},
            onOpenTask() {},
          }),
        ),
      ),
    );
    await settle(mod.act);
    return mounted;
  }

  await check("canOpenLocalFiles=false：不渲染文件管理器按钮，复制路径与删除仍在", async () => {
    const mounted = await open({ canOpenLocalFiles: false });
    assert.equal(q('[data-testid="managed-worktree-row"]').length, 1);
    assert.equal(q('[data-testid="managed-worktree-reveal"]').length, 0);
    assert.equal(q('[data-testid="managed-worktree-copy-path"]').length, 1);
    assert.equal(q('[data-testid="managed-worktree-delete"]').length, 1);
    await mounted.unmount();
  });

  await check("canOpenLocalFiles=true（桌面对照）：渲染文件管理器按钮", async () => {
    const mounted = await open({ canOpenLocalFiles: true });
    assert.equal(q('[data-testid="managed-worktree-row"]').length, 1);
    assert.equal(q('[data-testid="managed-worktree-reveal"]').length, 1);
    await mounted.unmount();
  });
}

// ---------------------------------------------------------------------------
// 连接装配：真实 connectViaWebSocket + RemoteServiceAccess + ProxyChannel。
// ---------------------------------------------------------------------------
class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  #listeners = new Map();
  constructor(url) {
    this.url = url;
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.#emit("open", {});
    }, 0);
  }
  addEventListener(type, listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  removeEventListener() {}
  #emit(type, event) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

async function runConnectionSuite(mod) {
  console.log("连接装配：connectViaWebSocket");
  globalThis.WebSocket = FakeWebSocket;
  const connect = async (options) => {
    const services = await mod.connectViaWebSocket("ws://localhost/ws", options);
    return services;
  };

  await check(
    "缺省与 managedWorktreeService=false：不创建 managedWorktreeService 代理",
    async () => {
      for (const options of [undefined, {}, { managedWorktreeService: false }]) {
        const services = await connect(options);
        assert.equal(services.managedWorktreeService, undefined, JSON.stringify(options ?? null));
      }
    },
  );

  await check(
    "managedWorktreeService=true：创建代理，windowControllerService 缺省仍关闭",
    async () => {
      const services = await connect({ managedWorktreeService: true });
      assert.ok(services.managedWorktreeService, "应创建受管 worktree 代理");
      assert.equal(typeof services.managedWorktreeService.listWorktrees, "function");
      assert.equal(services.windowControllerService, undefined);
    },
  );
}

// ---------------------------------------------------------------------------
// /api/server-info 能力协商：schema 合同 + 真实 resolveWebBootstrap 行为。
// ---------------------------------------------------------------------------
const serverInfoBase = (capabilities) => ({
  serverId: "server-1",
  version: "3.18.2",
  protocolVersion: 1,
  authRequired: false,
  workspaces: [{ path: "/workspace/app", workspaceIdentity: "id-app" }],
  capabilities: { desktopContinuous: true, websocketRpc: true, ...capabilities },
});

async function runCapabilitySuite(schemaMod) {
  console.log("能力协商：managedWorktrees");
  const { serverRemoteInfoOutputSchema: output, serverRemoteInfoSchema: input } = schemaMod;

  await check(
    "server-info schema：managedWorktrees 为可选 literal(true)，缺省为 undefined",
    async () => {
      for (const schema of [input, output]) {
        const withCap = schema.parse(serverInfoBase({ managedWorktrees: true }));
        assert.equal(withCap.capabilities.managedWorktrees, true);
        const without = schema.parse(serverInfoBase({}));
        assert.equal(without.capabilities.managedWorktrees, undefined);
        assert.ok(!("managedWorktrees" in without.capabilities));
        assert.throws(() => schema.parse(serverInfoBase({ managedWorktrees: false })));
        assert.throws(() => schema.parse(serverInfoBase({ managedWorktrees: "true" })));
      }
      // 严格输出仍拒绝未知能力，避免放宽泄漏面。
      assert.throws(() => output.parse(serverInfoBase({ unknownCapability: true })));
    },
  );

  await check(
    "resolveWebBootstrap：只在 server-info 声明能力时开启，失败分支 fail-closed",
    async () => {
      const source = readFileSync(join(repoRoot, "packages/web/src/main.tsx"), "utf8");
      const from = source.indexOf("function resolveDefaultWsOrigin");
      const to = source.indexOf("function isWebRemoteControlRoute");
      assert.ok(from > 0 && to > from, "未找到 resolveWebBootstrap 源码段");
      const { code } = await esbuild.transform(source.slice(from, to), { loader: "ts" });
      const load = new Function("window", "fetch", `${code}\nreturn resolveWebBootstrap;`);
      const run = async ({ search = "", respond }) => {
        const calls = [];
        const fakeWindow = { location: { protocol: "http:", host: "h:1", search } };
        const bootstrap = load(fakeWindow, async (url) => {
          calls.push(url);
          return respond();
        });
        return { result: await bootstrap(), calls };
      };
      const ok = (body) => () => ({ ok: true, json: async () => body });

      const enabled = await run({ respond: ok(serverInfoBase({ managedWorktrees: true })) });
      assert.equal(enabled.result.managedWorktrees, true);
      assert.equal(enabled.result.initialWorkspaceAbsPath, "/workspace/app");
      assert.equal(enabled.result.wsUrl, "ws://h:1/ws");

      for (const caps of [{}, { managedWorktrees: false }, { managedWorktrees: "true" }]) {
        const { result } = await run({ respond: ok(serverInfoBase(caps)) });
        assert.ok(!("managedWorktrees" in result), JSON.stringify(caps));
      }
      const noCapabilities = await run({ respond: ok({ workspaces: [] }) });
      assert.ok(!("managedWorktrees" in noCapabilities.result));

      const notOk = await run({ respond: () => ({ ok: false, json: async () => ({}) }) });
      assert.deepEqual(notOk.result, { wsUrl: "ws://h:1/ws" });

      const thrown = await run({
        respond: () => {
          throw new Error("network down");
        },
      });
      assert.deepEqual(thrown.result, { wsUrl: "ws://h:1/ws" });

      const remote = await run({
        search: "?remote=abc",
        respond: ok(serverInfoBase({ managedWorktrees: true })),
      });
      assert.deepEqual(remote.result, { wsUrl: "ws://h:1/ws/remote/abc" });
      assert.deepEqual(remote.calls, [], "跨机代理不应读取本机 server-info");
    },
  );
}

// ---------------------------------------------------------------------------
// 入口装配：源码级断言（main.tsx 无法脱离整个应用单独渲染）。
// ---------------------------------------------------------------------------
async function runWiringSuite() {
  console.log("入口装配：源码断言");
  const mainSource = readFileSync(join(repoRoot, "packages/web/src/main.tsx"), "utf8");
  const sidebarSource = readFileSync(join(uiSrc, "project-sidebar/index.tsx"), "utf8");

  await check(
    "web/main.tsx：独立 Root 开启代码评论卡片；连接选项只读取 bootstrap.managedWorktrees",
    async () => {
      // 独立 Web 的 Root 是 bootstrapWebApp 内唯一带 initialWorkspaceAbsPath + allowOpenWorkspace 的挂载。
      const standaloneAt = mainSource.indexOf("allowOpenWorkspace={bootstrap.allowOpenWorkspace}");
      assert.ok(standaloneAt > 0, "未找到独立 Web Root");
      const rootBlock = mainSource.slice(
        mainSource.lastIndexOf("<Root", standaloneAt),
        mainSource.indexOf("/>", standaloneAt),
      );
      assert.match(rootBlock, /preferDirectoryBrowser/u);
      assert.match(rootBlock, /assistantCodeCommentCardsEnabled(\s|$)/u);
      // home-only 入口不承载会话正文，保持默认关闭。
      const homeOnlyAt = mainSource.indexOf("renderExternalRelayHomeOnlyRoot = async");
      const homeOnlyBlock = mainSource.slice(
        mainSource.indexOf("<Root", homeOnlyAt),
        mainSource.indexOf("/>", mainSource.indexOf("<Root", homeOnlyAt)),
      );
      assert.doesNotMatch(homeOnlyBlock, /assistantCodeCommentCardsEnabled/u);
      assert.doesNotMatch(mainSource, /const managedWorktrees = true/u, "不得硬编码开启");
      assert.match(mainSource, /managedWorktreeService: bootstrap\.managedWorktrees === true/u);
    },
  );

  await check("project-sidebar：受管 Worktree 入口不依赖 isDesktop，仍排除手机远控", async () => {
    const line = sidebarSource.match(/const canManageWorktrees = [^;]+;/u)?.[0] ?? "";
    assert.ok(line, "未找到 canManageWorktrees 声明");
    assert.doesNotMatch(line, /isDesktop/u);
    assert.match(line, /managedWorktreeService/u);
    assert.match(line, /!props\.isWebRemoteControl/u);
  });
}

const workDir = await mkdtemp(join(tmpdir(), "zcode-desktop-parity-ui-"));
try {
  const menuOut = join(workDir, "menu.mjs");
  const dialogOut = join(workDir, "dialog.mjs");
  const clientOut = join(workDir, "client.mjs");
  const schemaOut = join(workDir, "schema.mjs");
  await Promise.all([
    bundle(MENU_ENTRY, menuOut, {
      "ui:i18n/IntlProvider": INTL_STUB,
      "ui:components/ui/context-menu": CONTEXT_MENU_STUB,
      "ui:ControlHintTooltip": TOOLTIP_STUB,
    }),
    bundle(DIALOG_ENTRY, dialogOut, { "ui:i18n/IntlProvider": INTL_STUB }),
    bundle(CLIENT_ENTRY, clientOut, {}),
    bundle(SCHEMA_ENTRY, schemaOut, {}),
  ]);

  await runMenuSuite(await import(pathToFileURL(menuOut).href));
  const dialogMod = await import(pathToFileURL(dialogOut).href);
  await runEditorSuite(dialogMod);
  await runWorktreeSuite(dialogMod);
  await runConnectionSuite(await import(pathToFileURL(clientOut).href));
  await runCapabilitySuite(await import(pathToFileURL(schemaOut).href));
  await runWiringSuite();
  console.log(`standalone-desktop-parity-ui: ${passed} checks passed`);
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
// react-dom 内部的 scheduler 可能遗留 MessagePort 句柄；走到这里说明所有断言已通过
// （失败会在上方抛出并以非 0 退出），显式退出避免脚本挂起。
process.exit(0);
