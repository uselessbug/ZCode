// 场景 1-4：useRootWorkspaceActions / useConversationWorkspaceActions
// 的迟到 ENOENT、幂等 reuseDraft、草稿所有权与卸载防护。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  React,
  ReactDOMClient,
  composerDraftStore,
  conversationsDir,
  createRealService,
  createTabStore,
  deferred,
  dom,
  mountRootActionsHarness,
  passes,
  projDir,
  resetState,
  useConversationWorkspaceActions,
  workspaceRoot,
} from "./standalone-pending-draft-recovery.shared.mjs";

export async function runRootCases() {
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
      const p1 = harness.latest.actions.startNewTaskFromActiveWorkspace("case1", {
        projectId: null,
      });
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
      const p1 = harness.latest.actions.startNewTaskFromActiveWorkspace("case2", {
        projectId: null,
      });
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
      const p1 = harness.latest.actions.startNewTaskFromActiveWorkspace("case3", {
        projectId: null,
      });
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
}
