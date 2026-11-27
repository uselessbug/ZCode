// 场景 6：独立 Web 页面导航隔离与冷恢复
// （已删项目回退保留草稿、读失败不误判、深链优先、commandId 恢复）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  PlatformProvider,
  React,
  ReactDOMClient,
  ServiceProvider,
  TabStoreProvider,
  composerDraftStore,
  createRealService,
  dom,
  passes,
  persistStandaloneWebNavigationSnapshot,
  projDir,
  repoRoot,
  resetState,
  useRootPlatformEffects,
  useTabStore,
  useTabStoreApi,
  useZCodeSessionStore,
  workspaceRoot,
} from "./standalone-pending-draft-recovery.shared.mjs";

export async function runPlatformCase() {
  // ---------------------------------------------------------------------------
  // 6. 独立 Web 页面导航隔离与冷恢复
  // ---------------------------------------------------------------------------
  {
    const mountPlatformHarness = async ({
      projectService,
      zcodeTaskService = { getTaskMeta: async () => null },
      initialWorkspaceAbsPath,
      initialTaskId,
    }) => {
      const container = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(container);
      const reactRoot = ReactDOMClient.createRoot(container);
      let latest = null;
      const noop = () => {};
      const platform = {
        onFocusTab: () => () => {},
        onNewTab: () => () => {},
        onNewTask: () => () => {},
        onOpenWorkspace: () => () => {},
        onTaskNotificationClick: () => () => {},
        syncWindowTabs: () => {},
        syncActiveTaskSession: () => {},
        activateOrSetWorkspace: async () => ({ activated: false }),
        selectDirectory: async () => null,
        executeDesktopCommand: async () => {},
        setWebPushSubscribed: async () => {},
      };
      const services = {
        projectService,
        zcodeTaskService,
        settingService: { get: async () => ({}), update: async () => {} },
        oauthService: { logout: async () => {} },
        modelSelectionService: {},
      };
      function Harness() {
        const api = useTabStoreApi();
        const tabs = useTabStore((s) => s.tabs);
        const activeWorkspacePath = useTabStore((s) => s.activeWorkspacePath);
        const activeWorkspaceIdentity = useTabStore((s) => s.activeWorkspaceIdentity);
        const [bootstrapping, setBootstrapping] = React.useState(true);
        const [actionError, setActionError] = React.useState(null);
        const addTab = React.useCallback(
          (path, options) => api.getState().addTab(path, options),
          [api],
        );
        const activateTabByPath = React.useCallback(
          (path, options) => api.getState().activateTabByPath(path, options),
          [api],
        );
        const startDraftInWorkspace = React.useCallback(
          (workspacePath, workspaceIdentity, options) => {
            const projectId =
              options?.projectId !== undefined
                ? options.projectId
                : (composerDraftStore.readComposerWorkspaceScope(
                    workspacePath,
                    workspaceIdentity,
                    "web",
                  )?.projectId ?? null);
            const scope = composerDraftStore.resolveComposerScope(
              projectId,
              workspaceIdentity,
              "web",
            );
            composerDraftStore.rememberComposerWorkspaceScope(
              workspacePath,
              workspaceIdentity,
              scope,
            );
            if (options?.draftId) {
              composerDraftStore.bindPendingTaskDraft(scope, options.draftId, workspacePath);
            }
            useZCodeSessionStore
              .getState()
              .startDraft(workspacePath, options?.provider, workspaceIdentity, {
                projectId,
                taskGroupId: options?.taskGroupId,
              });
          },
          [],
        );
        useRootPlatformEffects({
          standaloneWebNavigation: true,
          initialWorkspaceAbsPath,
          initialTaskId,
          clientMode: "desktop-continuous",
          canBootstrapInitialWorkspace: true,
          addTab,
          setIsBootstrappingInitialWorkspace: setBootstrapping,
          platform,
          activateTabByPath,
          startDraftInWorkspace,
          startNewTaskFromActiveWorkspace: noop,
          openWorkspace: noop,
          openWorkspacePath: noop,
          setWorkspaceActionError: setActionError,
          isDesktop: false,
          locale: "zh-CN",
          tabs,
          activeWorkspacePath,
          activeWorkspaceIdentity,
          hasCompletedFullTabRestore: true,
          intl: { formatMessage: ({ id }) => id },
          isRestoringOAuthSession: false,
        });
        latest = {
          get tabs() {
            return api.getState().tabs;
          },
          get activeWorkspacePath() {
            return api.getState().activeWorkspacePath;
          },
          bootstrapping,
          actionError,
        };
        return null;
      }
      await React.act(async () => {
        reactRoot.render(
          React.createElement(
            ServiceProvider,
            { services, composerClientNamespace: "web" },
            React.createElement(
              PlatformProvider,
              { platform },
              React.createElement(TabStoreProvider, null, React.createElement(Harness)),
            ),
          ),
        );
      });
      const deadline = Date.now() + 1000;
      while (latest?.bootstrapping && Date.now() < deadline) {
        await React.act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      assert.equal(
        latest?.bootstrapping,
        false,
        `bootstrap 未完成: actionError=${latest?.actionError}`,
      );
      return {
        get latest() {
          return latest;
        },
        async unmount() {
          await React.act(async () => {
            reactRoot.unmount();
          });
          container.remove();
        },
      };
    };

    // 6a. 已软删除项目的缓存导航：冷恢复确认项目已删除后路由到无项目草稿并保留正文与模型选择
    resetState();
    const realService6 = await createRealService("case6");
    const deletedProj = await realService6.saveProject({ name: "TempProj", roots: [projDir] });
    await realService6.deleteProject(deletedProj.id);
    const staleScope = composerDraftStore.resolveComposerScope(deletedProj.id, undefined, "web");
    composerDraftStore.rememberComposerWorkspaceScope(projDir, undefined, staleScope);
    composerDraftStore.persistV4ComposerDraft(
      projDir,
      undefined,
      composerDraftStore.V4_DRAFT_SCOPE_ROOT,
      {
        text: "保留的正文草稿",
        mode: "build",
        planEnabled: true,
        modelSelection: { providerId: "zai", modelId: "glm-4.7" },
        projectId: deletedProj.id,
      },
      staleScope,
    );
    persistStandaloneWebNavigationSnapshot({
      workspacePath: projDir,
      workspacePurpose: "project",
      taskId: null,
      projectId: deletedProj.id,
    });

    const m6a = await mountPlatformHarness({ projectService: realService6 });
    try {
      const recoveredPath = m6a.latest.activeWorkspacePath;
      assert.ok(
        recoveredPath && recoveredPath.includes(`${join(".zcode", "conversations", "draft-")}`),
        `应路由到正常无项目草稿目录，实际: ${recoveredPath}`,
      );
      const wsState = useZCodeSessionStore.getState().getWorkspaceState(recoveredPath);
      assert.equal(wsState.draftProjectId, null, "失效项目必须清成 null");
      assert.equal(
        composerDraftStore.readComposerWorkspaceScope(projDir, undefined, "web"),
        undefined,
        "失效缓存作用域应清除",
      );
      const nullScope = composerDraftStore.resolveComposerScope(null, undefined, "web");
      const preserved = composerDraftStore.readV4ComposerDraft(
        recoveredPath,
        undefined,
        composerDraftStore.V4_DRAFT_SCOPE_ROOT,
        nullScope,
      );
      assert.equal(preserved?.text, "保留的正文草稿", "回退无项目草稿必须保留正文");
      assert.equal(preserved?.planEnabled, true, "回退无项目草稿必须保留 Plan/模式选择");
      assert.equal(preserved?.modelSelection?.modelId, "glm-4.7", "回退无项目草稿必须保留模型选择");
    } finally {
      await m6a.unmount();
    }

    // 6b. 读取项目失败不得当成项目已删除
    resetState();
    const activeProj = await realService6.saveProject({ name: "LiveProj", roots: [projDir] });
    const liveScope = composerDraftStore.resolveComposerScope(activeProj.id, undefined, "web");
    composerDraftStore.rememberComposerWorkspaceScope(projDir, undefined, liveScope);
    persistStandaloneWebNavigationSnapshot({
      workspacePath: projDir,
      workspacePurpose: "project",
      taskId: null,
      projectId: activeProj.id,
    });
    const failingReadService = {
      ...realService6,
      readProjects: async () => {
        throw new Error("ConnectionClosed");
      },
    };
    const m6b = await mountPlatformHarness({ projectService: failingReadService });
    try {
      assert.equal(m6b.latest.activeWorkspacePath, projDir, "读取失败不得强行切到无项目草稿");
      assert.equal(
        useZCodeSessionStore.getState().getWorkspaceState(projDir).draftProjectId,
        activeProj.id,
        "读取失败必须保留原 projectId",
      );
      assert.equal(m6b.latest.actionError, "ConnectionClosed");
      assert.equal(
        composerDraftStore.readComposerWorkspaceScope(projDir, undefined, "web")?.projectId,
        activeProj.id,
        "读取失败不得清除项目缓存作用域",
      );
    } finally {
      await m6b.unmount();
    }

    // 6c. 通知深链优先于本地页面/浏览器导航
    resetState();
    persistStandaloneWebNavigationSnapshot({
      workspacePath: projDir,
      workspacePurpose: "project",
      taskId: null,
      projectId: activeProj.id,
    });
    const deepLinkDir = join(workspaceRoot, "proj-deeplink");
    await mkdir(deepLinkDir, { recursive: true });
    const m6c = await mountPlatformHarness({
      projectService: realService6,
      initialWorkspaceAbsPath: deepLinkDir,
      initialTaskId: "task-notify-1",
    });
    try {
      assert.equal(
        m6c.latest.activeWorkspacePath,
        deepLinkDir,
        "通知深链必须优先于本地缓存导航",
      );
      assert.equal(
        useZCodeSessionStore.getState().getWorkspaceState(deepLinkDir).activeTaskId,
        "task-notify-1",
      );
    } finally {
      await m6c.unmount();
    }

    // 6d. 活跃无项目草稿与在途首发 commandId：冷恢复复用原草稿目录并保留 commandId（不轮换、不重放）
    resetState();
    const nullScope6d = composerDraftStore.resolveComposerScope(null, undefined, "web");
    const d6 = composerDraftStore.ensurePendingTaskDraft(nullScope6d);
    const p6 = await realService6.prepareSession({ draftId: d6.draftId });
    composerDraftStore.bindPendingTaskDraft(nullScope6d, d6.draftId, p6.workspacePath);
    composerDraftStore.markPendingTaskDraftCommand(
      nullScope6d,
      d6.draftId,
      "cmd-inflight-1",
      "sess-inflight-1",
    );
    composerDraftStore.persistV4ComposerDraft(
      p6.workspacePath,
      undefined,
      composerDraftStore.V4_DRAFT_SCOPE_ROOT,
      { text: "断线前草稿", projectId: null },
      nullScope6d,
    );
    persistStandaloneWebNavigationSnapshot({
      workspacePath: p6.workspacePath,
      workspacePurpose: "conversation",
      taskId: null,
      projectId: null,
    });
    const m6d = await mountPlatformHarness({ projectService: realService6 });
    try {
      assert.equal(m6d.latest.activeWorkspacePath, p6.workspacePath, "应复用同一 draft 目录");
      const restoredPending = composerDraftStore.readPendingTaskDraft(nullScope6d);
      assert.equal(restoredPending?.draftId, d6.draftId);
      assert.equal(restoredPending?.commandId, "cmd-inflight-1", "不得清除或覆盖在途首发 commandId");
      assert.equal(
        composerDraftStore.readV4ComposerDraft(
          p6.workspacePath,
          undefined,
          composerDraftStore.V4_DRAFT_SCOPE_ROOT,
          nullScope6d,
        )?.text,
        "断线前草稿",
      );
    } finally {
      await m6d.unmount();
    }
    const mainSource = readFileSync(join(repoRoot, "packages/web/src/main.tsx"), "utf8");
    assert.match(mainSource, /standaloneWebNavigation/);
    assert.match(
      mainSource,
      /standaloneWebDefaultWorkspacePath=\{bootstrap.initialWorkspaceAbsPath\}/,
    );
    assert.match(mainSource, /restoreSession=\{false\}/);
    assert.doesNotMatch(
      mainSource,
      /coldLaunchWorkspace\?\.workspacePath\s*\?\?\s*bootstrap\.initialWorkspaceAbsPath/,
      "独立 Web 不得无条件注入服务器默认 /workspace",
    );
    passes.push("6 独立 Web 仅保留页面导航、通知深链优先、已删项目安全回退与 commandId 恢复");
  }
}
