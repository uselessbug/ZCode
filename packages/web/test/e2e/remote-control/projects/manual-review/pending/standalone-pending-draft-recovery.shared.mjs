// 独立 Web 无项目草稿恢复回归的共享运行时：
// esbuild 打包真实 UI hook/store/resolver 与真实 createProjectService / SQLite，
// 在 jsdom + react-dom 中提供各场景共用的服务、重置与挂载工具。
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../../../../../../../");
export const uiSrc = join(repoRoot, "packages/ui/src");
const sharedSrc = join(repoRoot, "packages/shared/src");
const servicesSrc = join(repoRoot, "packages/services/src");

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
const require = createRequire(import.meta.url);
const esbuildDir = findPackageDir("esbuild");
const { build } = esbuildDir
  ? require(join(esbuildDir, "esbuild/lib/main.js"))
  : await import("esbuild");

const reactDomDir = nodePaths.find(
  (dir) =>
    existsSync(join(dir, "react-dom/package.json")) && existsSync(join(dir, "react/package.json")),
);
const jsdomDir = findPackageDir("jsdom");
if (!reactDomDir || !jsdomDir) {
  throw new Error(`Missing react-dom or jsdom in candidate node_modules: ${nodePaths.join(", ")}`);
}

export const root = await mkdtemp(join(tmpdir(), "zcode-pending-draft-recovery-"));
const outfile = join(root, "pending-draft-recovery-bundle.cjs");

await build({
  stdin: {
    contents: [
      `export * as React from "react";`,
      `export * as ReactDOMClient from "react-dom/client";`,
      `export { TaskIndexRepo } from ${JSON.stringify(join(servicesSrc, "session/taskIndexRepo.ts"))};`,
      `export { createProjectService } from ${JSON.stringify(join(servicesSrc, "project/index.ts"))};`,
      `export { useRootWorkspaceActions } from ${JSON.stringify(join(uiSrc, "root/useRootWorkspaceActions.ts"))};`,
      `export { useRootPlatformEffects, persistStandaloneWebNavigationSnapshot } from ${JSON.stringify(join(uiSrc, "root/useRootPlatformEffects.ts"))};`,
      `export { useConversationWorkspaceActions } from ${JSON.stringify(join(uiSrc, "root/useConversationWorkspaceActions.ts"))};`,
      `export { resolveConversationWorkspaceTarget } from ${JSON.stringify(join(uiSrc, "conversation-workspace-target/resolve.ts"))};`,
      `export * as composerDraftStore from ${JSON.stringify(join(uiSrc, "v4/composer/composerDraftStore.ts"))};`,
      `export { useDraftSessionPrewarm } from ${JSON.stringify(join(uiSrc, "v4/composer/useDraftSessionPrewarm.ts"))};`,
      `export { useComposerAttachments } from ${JSON.stringify(join(uiSrc, "v4/composer/useComposerAttachments.ts"))};`,
      `export { useComposerAttachmentUploadStore } from ${JSON.stringify(join(uiSrc, "store/composerAttachmentUploadStore.ts"))};`,
      `export { WebRemoteControlMobileShell } from ${JSON.stringify(join(uiSrc, "WebRemoteControlMobileShell.tsx"))};`,
      `export { createTabStore } from ${JSON.stringify(join(uiSrc, "store/tabStore.ts"))};`,
      `export { StoreProvider } from ${JSON.stringify(join(uiSrc, "store/StoreProvider.tsx"))};`,
      `export { TabStoreProvider, useTabStore, useTabStoreApi } from ${JSON.stringify(join(uiSrc, "store/TabStoreProvider.tsx"))};`,
      `export { useZCodeSessionStore } from ${JSON.stringify(join(uiSrc, "store/zcodeSessionStore.ts"))};`,
      `export { ServiceProvider } from ${JSON.stringify(join(uiSrc, "hooks/useServices.tsx"))};`,
      `export { PlatformProvider } from ${JSON.stringify(join(uiSrc, "hooks/usePlatform.tsx"))};`,
      `export { ZCodeIntlProvider } from ${JSON.stringify(join(uiSrc, "i18n/IntlProvider.tsx"))};`,
    ].join("\n"),
    resolveDir: repoRoot,
    loader: "ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  jsx: "automatic",
  external: ["electron"],
  loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl", ".jpg": "dataurl" },
  define: {
    "import.meta.url": JSON.stringify(pathToFileURL(outfile).href),
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://invalid.example.test/report"),
  },
  logLevel: "silent",
  plugins: [
    {
      name: "pending-draft-recovery-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^react($|\/)/ }, ({ path }) => ({
          path: createRequire(join(reactDomDir, "package.json")).resolve(path),
        }));
        builder.onResolve({ filter: /^react-dom($|\/)/ }, ({ path }) => ({
          path: createRequire(join(reactDomDir, "package.json")).resolve(path),
        }));
        builder.onResolve({ filter: /^@\/project-sidebar\/index\.js$/ }, () => ({
          path: join(uiSrc, "project-sidebar/view-preference.ts"),
        }));
        builder.onResolve({ filter: /^@\/components\/ui\/toast\.js$/ }, () => ({
          path: "stub:toast",
          namespace: "stub-toast",
        }));
        builder.onLoad({ filter: /.*/, namespace: "stub-toast" }, () => ({
          contents: `export const toast = (msg) => { globalThis.__toastMessages?.push(String(msg)); return 1; }; export const dismissToast = () => {}; export const updateToast = () => {};`,
          loader: "js",
        }));
        builder.onResolve({ filter: /^@\// }, ({ path }) => {
          const base = join(uiSrc, path.slice(2));
          const stem = base.replace(/\.js$/, "");
          const found = [`${stem}.ts`, `${stem}.tsx`, base].find((file) => existsSync(file));
          if (!found) throw new Error(`Cannot resolve UI alias: ${path}`);
          return { path: found };
        });
        builder.onResolve({ filter: /^@zcode\// }, ({ path }) => {
          const [, name, ...subpath] = path.split("/");
          const packageRoot = join(repoRoot, "packages", name);
          const manifest = require(join(packageRoot, "package.json"));
          const key = subpath.length ? `./${subpath.join("/")}` : ".";
          const entry = manifest.exports?.[key];
          const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
          if (!target) throw new Error(`Cannot resolve @zcode export: ${path}`);
          return { path: join(packageRoot, target) };
        });
        builder.onResolve({ filter: /^#session-control\// }, ({ path }) => ({
          path: join(
            repoRoot,
            "packages/session-control/src",
            `${path.slice("#session-control/".length)}.ts`,
          ),
        }));
        builder.onResolve({ filter: /^#src\// }, ({ path, importer }) => ({
          path: join(
            importer.startsWith(sharedSrc) ? sharedSrc : servicesSrc,
            path.slice(5).replace(/\.js$/, ".ts"),
          ),
        }));
        builder.onResolve({ filter: /^(@streamdown\/|@pierre\/)/ }, ({ path }) => ({
          path: `stub:${path}`,
          namespace: "stub-ui-heavy",
        }));
        builder.onLoad({ filter: /.*/, namespace: "stub-ui-heavy" }, () => ({
          contents: `export default {}; export const FileDiff = () => null; export const File = () => null; export const mermaid = {}; export const createMermaidPlugin = () => ({});`,
          loader: "js",
        }));
        builder.onResolve({ filter: /^[^./#][^:]*$/ }, ({ path, importer }) => {
          if (path.startsWith("@/") || path.startsWith("@zcode/")) return;
          if (
            path === "electron" ||
            path === "@napi-rs/keyring" ||
            path.startsWith("@napi-rs/keyring-") ||
            builtinModules.includes(path)
          ) {
            return { path, external: true };
          }
          const req = importer ? createRequire(importer) : require;
          try {
            return { path: req.resolve(path) };
          } catch {
            for (const dir of nodePaths) {
              try {
                return { path: createRequire(join(dir, "package.json")).resolve(path) };
              } catch {
                // continue
              }
            }
            throw new Error(`Cannot resolve package ${path} from ${importer}`);
          }
        });
      },
    },
  ],
});

const bundle = require(outfile);
const { JSDOM } = require(join(jsdomDir, "jsdom"));
export const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://zcode.example.test/",
});
dom.window.URL.createObjectURL = () => "blob:mock-url";
dom.window.URL.revokeObjectURL = () => {};
for (const [key, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["localStorage", dom.window.localStorage],
  ["sessionStorage", dom.window.sessionStorage],
  ["navigator", dom.window.navigator],
  ["File", dom.window.File],
  ["Blob", dom.window.Blob],
  ["FileReader", dom.window.FileReader],
  ["URL", dom.window.URL],
  ["HTMLElement", dom.window.HTMLElement],
  ["CustomEvent", dom.window.CustomEvent],
  ["Event", dom.window.Event],
]) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export const {
  React,
  ReactDOMClient,
  TaskIndexRepo,
  createProjectService,
  useRootWorkspaceActions,
  useRootPlatformEffects,
  persistStandaloneWebNavigationSnapshot,
  useConversationWorkspaceActions,
  resolveConversationWorkspaceTarget,
  composerDraftStore,
  useDraftSessionPrewarm,
  useComposerAttachments,
  useComposerAttachmentUploadStore,
  WebRemoteControlMobileShell,
  createTabStore,
  StoreProvider,
  TabStoreProvider,
  useTabStore,
  useTabStoreApi,
  useZCodeSessionStore,
  ServiceProvider,
  PlatformProvider,
  ZCodeIntlProvider,
} = bundle;

export const hostId = "remote:server:e2e-pending-draft-recovery";
export const workspaceRoot = join(root, "workspace");
export const conversationsDir = join(workspaceRoot, ".zcode", "conversations");
export const projDir = join(workspaceRoot, "proj-a");
await mkdir(projDir, { recursive: true });

export async function createRealService(name) {
  const index = new TaskIndexRepo(undefined, hostId, join(root, `${name}.sqlite`));
  const repository = await index.getProjectRepository({
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspaceRoot,
    allowStandaloneMultiRoot: true,
  });
  return createProjectService({
    repository: async () => repository,
    workspaceDirectory: join(workspaceRoot, ".zcode", "workspace"),
    ownerHostId: hostId,
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspaceRoot,
    allowStandaloneMultiRoot: true,
  });
}

export function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function resetState() {
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
  globalThis.__toastMessages = [];
  useZCodeSessionStore.setState({ workspaces: {} });
  useComposerAttachmentUploadStore.setState({ scopes: {} });
}

export async function mountRootActionsHarness({
  projectService,
  tabStoreApi,
  clientNamespace = "web",
}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const reactRoot = ReactDOMClient.createRoot(container);
  let latest = null;
  let workspaceActionError = null;
  const setUser = () => {};
  const setOAuthError = () => {};
  const updateAppSettings = async () => {};
  const refreshProviderState = async () => {};
  const intl = { formatMessage: ({ id }) => id };
  const platform = {
    activateOrSetWorkspace: async () => ({ activated: false }),
    selectDirectory: async () => null,
    executeDesktopCommand: async () => {},
  };
  const services = {
    projectService,
    settingService: { get: async () => ({}) },
    oauthService: { logout: async () => {} },
    modelSelectionService: {},
  };

  function Harness() {
    const activeTabId = tabStoreApi((s) => s.activeTabId);
    const activeWorkspacePath = tabStoreApi((s) => s.activeWorkspacePath);
    const activeWorkspaceIdentity = tabStoreApi((s) => s.activeWorkspaceIdentity);
    const addTab = tabStoreApi((s) => s.addTab);
    const actions = useRootWorkspaceActions({
      intl,
      platform,
      services,
      tabStoreApi,
      addTab,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      supportsSettings: true,
      isDesktop: false,
      allowOpenWorkspace: true,
      preferDirectoryBrowser: true,
      refreshProviderState,
      updateAppSettings,
      setOAuthError,
      setUser,
      workbenchGroupClientMode: "desktop-continuous",
    });
    latest = {
      actions,
      activeTabId,
      activeWorkspacePath,
      get workspaceActionError() {
        return actions.workspaceActionError;
      },
    };
    workspaceActionError = actions.workspaceActionError;
    return null;
  }

  await React.act(async () => {
    reactRoot.render(
      React.createElement(
        ServiceProvider,
        { services, composerClientNamespace: clientNamespace },
        React.createElement(Harness),
      ),
    );
  });

  return {
    get latest() {
      return latest;
    },
    get workspaceActionError() {
      return workspaceActionError;
    },
    async unmount() {
      await React.act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    },
  };
}

export const passes = [];
