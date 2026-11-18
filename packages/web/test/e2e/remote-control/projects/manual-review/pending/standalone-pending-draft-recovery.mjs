// 独立 Web 无项目草稿恢复与竞态回归（对应 docs/standalone-web-multi-root-projects.md、
// docs/standalone-web-task-and-project-compat.md、packages/ui/src/conversation-workspace-target/CONTRACT.md）。
// 使用 esbuild 打包真实 UI hook/store/resolver 与真实 createProjectService / SQLite，
// 在 jsdom + react-dom 环境中复现并验证以下场景：
// 1. 迟到 ENOENT 在导航已过时（!isCurrent）时不得换绑或重试（useRootWorkspaceActions + useConversationWorkspaceActions）。
// 2. rotateMissingPendingTaskDraft 即使遇到已被其他入口换绑的 current，也必须先判断 commandId（有在途命令返回 null）。
// 3. ENOENT 幂等重试必须使用 current.workspacePath 对应的 reuseDraft 状态（不得强行 reuseDraft: false 重建已删目录）。
// 4. 异步 prepareSession 成功返回后，必须核验当前导航与草稿所有权（draftId 仍匹配）才写回绑定或导航。
// 5. 无项目草稿菜单（resolveConversationWorkspaceTarget）命中当前受管 pendingDraft 路径时须走 prepareSession；
//    真实历史非项目会话快捷路径（非受管 pendingDraft 路径）保持直返，不调用 prepareSession。
//
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-pending-draft-recovery.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../../../../../");
const uiSrc = join(repoRoot, "packages/ui/src");
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

const root = await mkdtemp(join(tmpdir(), "zcode-pending-draft-recovery-"));
const outfile = join(root, "pending-draft-recovery-bundle.cjs");

await build({
  stdin: {
    contents: [
      `export * as React from "react";`,
      `export * as ReactDOMClient from "react-dom/client";`,
      `export { TaskIndexRepo } from ${JSON.stringify(join(servicesSrc, "session/taskIndexRepo.ts"))};`,
      `export { createProjectService } from ${JSON.stringify(join(servicesSrc, "project/index.ts"))};`,
      `export { useRootWorkspaceActions } from ${JSON.stringify(join(uiSrc, "root/useRootWorkspaceActions.ts"))};`,
      `export { useConversationWorkspaceActions } from ${JSON.stringify(join(uiSrc, "root/useConversationWorkspaceActions.ts"))};`,
      `export { resolveConversationWorkspaceTarget } from ${JSON.stringify(join(uiSrc, "conversation-workspace-target/resolve.ts"))};`,
      `export * as composerDraftStore from ${JSON.stringify(join(uiSrc, "v4/composer/composerDraftStore.ts"))};`,
      `export { createTabStore } from ${JSON.stringify(join(uiSrc, "store/tabStore.ts"))};`,
      `export { useZCodeSessionStore } from ${JSON.stringify(join(uiSrc, "store/zcodeSessionStore.ts"))};`,
      `export { ServiceProvider } from ${JSON.stringify(join(uiSrc, "hooks/useServices.tsx"))};`,
    ].join("\n"),
    resolveDir: repoRoot,
    loader: "ts",
  },
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
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
          contents: `export const toast = (msg) => { globalThis.__toastMessages?.push(String(msg)); };`,
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
        builder.onResolve({ filter: /^[^./#@][^:]*$/ }, ({ path, importer }) => {
          if (path === "electron") return { path, external: true };
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
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "https://zcode.example.test/",
});
for (const [key, value] of [
  ["window", dom.window],
  ["document", dom.window.document],
  ["localStorage", dom.window.localStorage],
  ["HTMLElement", dom.window.HTMLElement],
  ["CustomEvent", dom.window.CustomEvent],
  ["Event", dom.window.Event],
]) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  React,
  ReactDOMClient,
  TaskIndexRepo,
  createProjectService,
  useRootWorkspaceActions,
  useConversationWorkspaceActions,
  resolveConversationWorkspaceTarget,
  composerDraftStore,
  createTabStore,
  useZCodeSessionStore,
  ServiceProvider,
} = bundle;

const hostId = "remote:server:e2e-pending-draft-recovery";
const workspaceRoot = join(root, "workspace");
const conversationsDir = join(workspaceRoot, ".zcode", "conversations");
const projDir = join(workspaceRoot, "proj-a");
await mkdir(projDir, { recursive: true });

async function createRealService(name) {
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

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function resetState() {
  dom.window.localStorage.clear();
  globalThis.__toastMessages = [];
  useZCodeSessionStore.setState({ workspaces: {} });
}

async function mountRootActionsHarness({ projectService, tabStoreApi, clientNamespace = "web" }) {
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

const passes = [];

// ---------------------------------------------------------------------------
// 1. useRootWorkspaceActions: 迟到 ENOENT 在导航过时后不得换绑或重试
// ---------------------------------------------------------------------------
{
  resetState();
  const realService = await createRealService("case1");
  const scope = composerDraftStore.resolveComposerScope(null, undefined, "web");
  const d1 = composerDraftStore.ensurePendingTaskDraft(scope);
  const first = await realService.prepareSession({ draftId: d1.draftId });
  composerDraftStore.bindPendingTaskDraft(scope, d1.draftId, first.workspacePath);
  await rm(first.workspacePath, { recursive: true, force: true });

  const calls = [];
  const firstPrepare = deferred();
  const wrappedService = {
    ...realService,
    async prepareSession(params) {
      calls.push(params);
      if (calls.length === 1) return firstPrepare.promise;
      return realService.prepareSession(params);
    },
  };

  const tabStoreApi = createTabStore();
  tabStoreApi.getState().addTab(projDir, { workspacePurpose: "project" });
  const harness = await mountRootActionsHarness({
    projectService: wrappedService,
    tabStoreApi,
    clientNamespace: "web",
  });

  try {
    // 发起无项目新建（卡在第一次 prepareSession）
    const p1 = harness.latest.actions.startNewTaskFromActiveWorkspace("case1", { projectId: null });
    await Promise.resolve();
    assert.equal(calls.length, 1);

    // 导航已被用户新动作替代（切换到项目目录）
    await React.act(async () => {
      await harness.latest.actions.handleSelectProject(projDir, false);
    });

    // 迟到的 ENOENT 返回
    await React.act(async () => {
      firstPrepare.reject(new Error("project.draft-workspace-missing"));
      await p1;
    });

    assert.equal(calls.length, 1, "导航已过时，迟到 ENOENT 不得重试 prepareSession");
    assert.equal(
      composerDraftStore.readPendingTaskDraft(scope)?.draftId,
      d1.draftId,
      "导航已过时，迟到 ENOENT 不得换绑 pendingDraft",
    );
    assert.equal(globalThis.__toastMessages.length, 0, "过时导航不得弹出错误 toast");
    passes.push("1 useRootWorkspaceActions 迟到 ENOENT 在导航过时后不换绑不重试");
  } finally {
    await harness.unmount();
  }
}

// ---------------------------------------------------------------------------
// 2. useRootWorkspaceActions: 换绑返回被其他入口已绑定草稿时，幂等重试必须带当前 reuseDraft 状态
// ---------------------------------------------------------------------------
{
  resetState();
  const realService = await createRealService("case2");
  const scope = composerDraftStore.resolveComposerScope(null, undefined, "web");
  const d1 = composerDraftStore.ensurePendingTaskDraft(scope);
  const first = await realService.prepareSession({ draftId: d1.draftId });
  composerDraftStore.bindPendingTaskDraft(scope, d1.draftId, first.workspacePath);
  await rm(first.workspacePath, { recursive: true, force: true });

  const calls = [];
  const firstPrepare = deferred();
  const wrappedService = {
    ...realService,
    async prepareSession(params) {
      calls.push(params);
      if (calls.length === 1) return firstPrepare.promise;
      return realService.prepareSession(params);
    },
  };

  const tabStoreApi = createTabStore();
  tabStoreApi.getState().addTab(projDir, { workspacePurpose: "project" });
  const harness = await mountRootActionsHarness({
    projectService: wrappedService,
    tabStoreApi,
    clientNamespace: "web",
  });

  try {
    const p1 = harness.latest.actions.startNewTaskFromActiveWorkspace("case2", { projectId: null });
    await Promise.resolve();
    assert.equal(calls.length, 1);

    // 并发入口先一步将 D1 换绑成 D2 并绑定到 dir2，随后 dir2 也被删除
    const d2 = composerDraftStore.rotateMissingPendingTaskDraft(scope, d1.draftId);
    const dir2 = join(conversationsDir, `draft-${d2.draftId}`);
    composerDraftStore.bindPendingTaskDraft(scope, d2.draftId, dir2);
    assert.equal(existsSync(dir2), false);

    await React.act(async () => {
      firstPrepare.reject(new Error("project.draft-workspace-missing"));
      await p1;
    });

    assert.equal(calls.length, 2, "应执行一次幂等重试");
    assert.equal(calls[1].draftId, d2.draftId);
    assert.equal(
      calls[1].reuseDraft,
      true,
      "重试已绑定 workspacePath 的 current 草稿时必须传 reuseDraft: true",
    );
    assert.equal(existsSync(dir2), false, "不得用 reuseDraft: false 重建已被删除的 dir2 空目录");
    passes.push("2 useRootWorkspaceActions 幂等重试使用 current.workspacePath 对应 reuseDraft");
  } finally {
    await harness.unmount();
  }
}

// ---------------------------------------------------------------------------
// 3. useRootWorkspaceActions: 异步成功回包前草稿所有权已变更时不得写回绑定或切 tab
// ---------------------------------------------------------------------------
{
  resetState();
  const realService = await createRealService("case3");
  const scope = composerDraftStore.resolveComposerScope(null, undefined, "web");
  const d1 = composerDraftStore.ensurePendingTaskDraft(scope);
  const firstPrepare = deferred();
  const wrappedService = {
    ...realService,
    async prepareSession() {
      return firstPrepare.promise;
    },
  };

  const tabStoreApi = createTabStore();
  tabStoreApi.getState().addTab(projDir, { workspacePurpose: "project" });
  const harness = await mountRootActionsHarness({
    projectService: wrappedService,
    tabStoreApi,
    clientNamespace: "web",
  });

  try {
    const p1 = harness.latest.actions.startNewTaskFromActiveWorkspace("case3", { projectId: null });
    await Promise.resolve();

    // 在途期间草稿已被另一个入口换绑为 D2 并绑定到 dir2
    const d2 = composerDraftStore.rotateMissingPendingTaskDraft(scope, d1.draftId);
    const dir2 = join(conversationsDir, `draft-${d2.draftId}`);
    composerDraftStore.bindPendingTaskDraft(scope, d2.draftId, dir2);

    const staleDir1 = join(conversationsDir, `draft-${d1.draftId}`);
    await React.act(async () => {
      firstPrepare.resolve({
        workspacePath: staleDir1,
        additionalDirectories: [],
        projectId: null,
      });
      await p1;
    });

    assert.equal(
      composerDraftStore.readPendingTaskDraft(scope)?.draftId,
      d2.draftId,
      "不得覆盖已被换绑的 pendingDraft",
    );
    assert.equal(
      tabStoreApi.getState().activeWorkspacePath,
      projDir,
      "丧失草稿所有权的异步结果不得新建或激活旧草稿 tab",
    );
    assert.equal(
      tabStoreApi
        .getState()
        .tabs.some((tab) => tab.kind === "workspace" && tab.workspacePath === staleDir1),
      false,
    );
    passes.push("3 useRootWorkspaceActions 异步结果验证草稿所有权");
  } finally {
    await harness.unmount();
  }
}

// ---------------------------------------------------------------------------
// 4. useConversationWorkspaceActions: 过时导航 ENOENT、幂等 reuseDraft 与所有权校验
// ---------------------------------------------------------------------------
{
  resetState();
  const realService = await createRealService("case4");
  const scope = composerDraftStore.resolveComposerScope(null, undefined, "web");
  const d1 = composerDraftStore.ensurePendingTaskDraft(scope);
  const first = await realService.prepareSession({ draftId: d1.draftId });
  composerDraftStore.bindPendingTaskDraft(scope, d1.draftId, first.workspacePath);
  await rm(first.workspacePath, { recursive: true, force: true });

  const calls = [];
  let mode = "stale-enoent";
  let gate = deferred();
  const wrappedService = {
    ...realService,
    async prepareSession(params) {
      calls.push(params);
      if (mode === "stale-enoent" && calls.length === 1) return gate.promise;
      if (mode === "ownership-lost" && calls.length === 1) return gate.promise;
      return realService.prepareSession(params);
    },
  };

  const tabStoreApi = createTabStore();
  const tabA = tabStoreApi.getState().addTab(projDir, { workspacePurpose: "project" });
  const harness = await mountRootActionsHarness({
    projectService: wrappedService,
    tabStoreApi,
    clientNamespace: "web",
  });

  try {
    let rejectedStale = false;
    let pStale;
    await React.act(async () => {
      pStale = harness.latest.actions.handleResolveConversationWorkspace().catch((err) => {
        rejectedStale = true;
        return err;
      });
      await Promise.resolve();
      const tabB = tabStoreApi.getState().addTab(join(workspaceRoot, "proj-b"), {
        workspacePurpose: "project",
      });
      assert.notEqual(tabB, tabA);
      gate.reject(new Error("project.draft-workspace-missing"));
      await pStale;
    });
    assert.equal(rejectedStale, true, "过时 resolve 应 reject 阻止壳层切页");
    assert.equal(calls.length, 1, "过时 ENOENT 不得重试");
    assert.equal(composerDraftStore.readPendingTaskDraft(scope)?.draftId, d1.draftId);
    assert.equal(harness.latest.workspaceActionError, null, "过时取消不得写入错误态");

    // 4b. 并发换绑后幂等重试不得强行 reuseDraft: false
    calls.length = 0;
    mode = "stale-enoent";
    gate = deferred();
    let d2;
    let dir2;
    await React.act(async () => {
      const pReuse = harness.latest.actions
        .handleResolveConversationWorkspace()
        .catch((err) => err);
      await Promise.resolve();
      d2 = composerDraftStore.rotateMissingPendingTaskDraft(scope, d1.draftId);
      dir2 = join(conversationsDir, `draft-${d2.draftId}`);
      composerDraftStore.bindPendingTaskDraft(scope, d2.draftId, dir2);
      gate.reject(new Error("project.draft-workspace-missing"));
      await pReuse;
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].draftId, d2.draftId);
    assert.equal(calls[1].reuseDraft, true);
    assert.equal(existsSync(dir2), false);

    // 4c. 异步成功前草稿所有权丢失（已完成/换绑）不得写回 rememberComposerWorkspaceScope 或返回旧路径
    calls.length = 0;
    mode = "ownership-lost";
    gate = deferred();
    const d2Current = composerDraftStore.readPendingTaskDraft(scope);
    let pOwnershipError = null;
    let d3;
    const stalePath = join(conversationsDir, `draft-${d2Current.draftId}`);
    await React.act(async () => {
      const pOwn = harness.latest.actions.handleResolveConversationWorkspace().catch((err) => {
        pOwnershipError = err;
      });
      await Promise.resolve();
      composerDraftStore.completePendingTaskDraft(scope, d2Current.draftId);
      d3 = composerDraftStore.ensurePendingTaskDraft(scope);
      gate.resolve({ workspacePath: stalePath, additionalDirectories: [], projectId: null });
      await pOwn;
    });
    assert.ok(pOwnershipError, "丧失草稿所有权时不得返回旧路径");
    assert.equal(composerDraftStore.readPendingTaskDraft(scope)?.draftId, d3.draftId);
    assert.equal(
      composerDraftStore.readComposerWorkspaceScope(stalePath, undefined, "web"),
      undefined,
      "丧失所有权时不得写回 workspace scope",
    );

    // 4d. 独立使用 useConversationWorkspaceActions（不传外置 navigationSequenceRef）时的并发/卸载防护
    const standaloneContainer = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(standaloneContainer);
    const standaloneRoot = ReactDOMClient.createRoot(standaloneContainer);
    let standaloneActions = null;
    let standaloneError = null;
    const standaloneGate = deferred();
    const standaloneCalls = [];
    function StandaloneHarness() {
      standaloneActions = useConversationWorkspaceActions({
        services: {
          projectService: {
            ...realService,
            prepareSession: async (params) => {
              standaloneCalls.push(params);
              if (standaloneCalls.length === 1) return standaloneGate.promise;
              return realService.prepareSession(params);
            },
          },
        },
        addTab: () => "",
        createTask: async () => {},
        setWorkspaceActionError: (err) => {
          standaloneError = err;
        },
        composerClientNamespace: "web",
      });
      return null;
    }
    await React.act(async () => {
      standaloneRoot.render(React.createElement(StandaloneHarness));
    });
    let standaloneRejected = false;
    await React.act(async () => {
      const p1 = standaloneActions.handleResolveConversationWorkspace().catch(() => {
        standaloneRejected = true;
      });
      await Promise.resolve();
      await standaloneRoot.unmount();
      standaloneGate.reject(new Error("project.draft-workspace-missing"));
      await p1;
    });
    standaloneContainer.remove();
    assert.equal(standaloneRejected, true, "卸载后迟到 ENOENT 应取消");
    assert.equal(standaloneCalls.length, 1, "卸载后迟到 ENOENT 不得重试");
    assert.equal(standaloneError, null, "卸载取消不得设置错误状态");
    passes.push("4 useConversationWorkspaceActions 过时 ENOENT、幂等 reuseDraft 与所有权校验");
  } finally {
    await harness.unmount();
  }
}

// ---------------------------------------------------------------------------
// 5. resolveConversationWorkspaceTarget & Root.tsx 接线：
//    受管 pendingDraft 菜单走 prepareSession；真实历史会话保留快捷路径
// ---------------------------------------------------------------------------
{
  resetState();
  const realService = await createRealService("case5");
  const scope = composerDraftStore.resolveComposerScope(null, undefined, "web");
  const d1 = composerDraftStore.ensurePendingTaskDraft(scope);
  const first = await realService.prepareSession({ draftId: d1.draftId });
  composerDraftStore.bindPendingTaskDraft(scope, d1.draftId, first.workspacePath);
  await rm(first.workspacePath, { recursive: true, force: true });

  const tabStoreApi = createTabStore();
  tabStoreApi.getState().addTab(first.workspacePath, { workspacePurpose: "conversation" });
  const harness = await mountRootActionsHarness({
    projectService: realService,
    tabStoreApi,
    clientNamespace: "web",
  });

  try {
    // 5a. 当前 tab 是受管 pendingDraft 路径且目录已被删除：必须走 resolveLocalConversationWorkspacePath
    let resolvedViaPrepare = 0;
    let targetManaged;
    await React.act(async () => {
      targetManaged = await resolveConversationWorkspaceTarget({
        getTabs: () => tabStoreApi.getState().tabs,
        activeWorkspacePath: first.workspacePath,
        activeWorkspaceIdentity: null,
        getManagedPendingDraftWorkspacePath: () =>
          composerDraftStore.readPendingTaskDraft(
            composerDraftStore.resolveComposerScope(null, undefined, "web"),
          )?.workspacePath ?? null,
        resolveLocalConversationWorkspacePath: async () => {
          resolvedViaPrepare += 1;
          return harness.latest.actions.handleResolveConversationWorkspace();
        },
      });
    });
    assert.equal(resolvedViaPrepare, 1, "受管 pendingDraft 路径必须走 prepareSession");
    assert.notEqual(targetManaged.workspacePath, first.workspacePath, "应换绑并重建新草稿目录");
    assert.equal((await stat(targetManaged.workspacePath)).isDirectory(), true);

    // 5b. 真实历史非项目会话 tab（路径不是当前受管 pendingDraft）：保留快捷路径，不调用 prepareSession
    const historicalConvPath = join(conversationsDir, "draft-00000000-0000-4000-8000-000000000099");
    await mkdir(historicalConvPath, { recursive: true });
    await React.act(async () => {
      tabStoreApi.getState().addTab(historicalConvPath, { workspacePurpose: "conversation" });
    });
    let historicalPrepareCalls = 0;
    const targetHistorical = await resolveConversationWorkspaceTarget({
      getTabs: () => tabStoreApi.getState().tabs,
      activeWorkspacePath: historicalConvPath,
      activeWorkspaceIdentity: null,
      getManagedPendingDraftWorkspacePath: () =>
        composerDraftStore.readPendingTaskDraft(
          composerDraftStore.resolveComposerScope(null, undefined, "web"),
        )?.workspacePath ?? null,
      resolveLocalConversationWorkspacePath: async () => {
        historicalPrepareCalls += 1;
        return harness.latest.actions.handleResolveConversationWorkspace();
      },
    });
    assert.equal(historicalPrepareCalls, 0, "真实历史非项目会话应保留快捷路径");
    assert.equal(targetHistorical.workspacePath, historicalConvPath);

    // 5c. 核验 Root.tsx 真实接线已注入 getManagedPendingDraftWorkspacePath
    const rootSource = readFileSync(join(uiSrc, "Root.tsx"), "utf8");
    assert.match(
      rootSource,
      /resolveConversationWorkspaceTarget\(\{[\s\S]*getManagedPendingDraftWorkspacePath:/,
      "Root.tsx 必须向 resolveConversationWorkspaceTarget 注入受管 pendingDraft 路径",
    );
    passes.push("5 无项目草稿菜单校验受管 pendingDraft 并保留历史会话快捷路径");
  } finally {
    await harness.unmount();
  }
}

for (const line of passes) console.log(`PASS ${line}`);
console.log(`\n${passes.length} 组回归全部通过（临时目录 ${root}）`);
dom.window.close();
await rm(root, { recursive: true, force: true });
process.exit(0);
