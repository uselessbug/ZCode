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
import { readFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { runPlatformCase } from "./standalone-pending-draft-recovery.platform-cases.mjs";
import { runRootCases } from "./standalone-pending-draft-recovery.root-cases.mjs";
import {
  PlatformProvider,
  React,
  ReactDOMClient,
  ServiceProvider,
  StoreProvider,
  WebRemoteControlMobileShell,
  ZCodeIntlProvider,
  composerDraftStore,
  conversationsDir,
  createRealService,
  createTabStore,
  dom,
  mountRootActionsHarness,
  passes,
  projDir,
  resetState,
  resolveConversationWorkspaceTarget,
  root,
  uiSrc,
  useComposerAttachments,
  useDraftSessionPrewarm,
  useRootWorkspaceActions,
  useZCodeSessionStore,
} from "./standalone-pending-draft-recovery.shared.mjs";

try {
  await runRootCases();

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
      const historicalConvPath = join(
        conversationsDir,
        "draft-00000000-0000-4000-8000-000000000099",
      );
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

  await runPlatformCase();

  // ---------------------------------------------------------------------------
  // 7. 显式保留 null（targetWorkspace.projectId=null 与 web-remote-replayable）
  // ---------------------------------------------------------------------------
  {
    resetState();
    const realService7 = await createRealService("case7");
    const proj7 = await realService7.saveProject({ name: "Proj7", roots: [projDir] });
    const tabStoreApi = createTabStore();
    tabStoreApi.getState().addTab(projDir, { workspacePurpose: "project" });
    useZCodeSessionStore.getState().startDraft(projDir, undefined, undefined, {
      projectId: proj7.id,
    });
    const harness = await mountRootActionsHarness({
      projectService: realService7,
      tabStoreApi,
      clientNamespace: "web",
    });
    try {
      // 7a. targetWorkspace.projectId: null 不得被活动工作区项目覆盖
      await React.act(async () => {
        await harness.latest.actions.startNewTaskFromActiveWorkspace("case7-null", {
          targetWorkspace: { workspacePath: projDir, projectId: null },
        });
      });
      const activePath = tabStoreApi.getState().activeWorkspacePath;
      assert.equal(
        useZCodeSessionStore.getState().getWorkspaceState(activePath).draftProjectId,
        null,
        "targetWorkspace 显式 projectId: null 必须保留",
      );

      // 7b. web-remote-replayable 下 openMobileProjectDraft 显式保留 null
      const receivedRequests = [];
      const mobileContainer = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(mobileContainer);
      const mobileRoot = ReactDOMClient.createRoot(mobileContainer);
      let mobileActions = null;
      function MobileHarness() {
        mobileActions = useRootWorkspaceActions({
          intl: { formatMessage: ({ id }) => id },
          platform: {
            activateOrSetWorkspace: async () => ({ activated: false }),
            selectDirectory: async () => null,
            executeDesktopCommand: async () => {},
          },
          services: {
            projectService: realService7,
            settingService: { get: async () => ({}) },
            oauthService: { logout: async () => {} },
            modelSelectionService: {},
          },
          tabStoreApi,
          addTab: tabStoreApi.getState().addTab,
          activeWorkspacePath: projDir,
          activeWorkspaceIdentity: null,
          supportsSettings: true,
          isDesktop: false,
          allowOpenWorkspace: false,
          preferDirectoryBrowser: true,
          refreshProviderState: async () => {},
          updateAppSettings: async () => {},
          setOAuthError: () => {},
          setUser: () => {},
          openMobileProjectDraft: async (req) => {
            receivedRequests.push(req);
          },
          workbenchGroupClientMode: "web-remote-replayable",
        });
        return null;
      }
      await React.act(async () => {
        mobileRoot.render(
          React.createElement(
            ServiceProvider,
            { services: { projectService: realService7 }, composerClientNamespace: "mobile:dev" },
            React.createElement(MobileHarness),
          ),
        );
      });
      await React.act(async () => {
        await mobileActions.startNewTaskFromActiveWorkspace("case7-mobile-null", {
          targetWorkspace: { workspacePath: projDir, projectId: null },
        });
      });
      await React.act(async () => {
        mobileRoot.unmount();
      });
      mobileContainer.remove();
      assert.equal(receivedRequests.length, 1);
      assert.equal(
        receivedRequests[0].projectId,
        null,
        "web-remote-replayable 必须显式透传 projectId: null",
      );
      passes.push("7 显式保留 projectId: null（本地 targetWorkspace 与手机远控入口）");
    } finally {
      await harness.unmount();
    }
  }

  // ---------------------------------------------------------------------------
  // 8. 预热失败出口与附件重试闭环（不解锁跳过未就绪/失败附件）
  // ---------------------------------------------------------------------------
  {
    resetState();
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const reactRoot = ReactDOMClient.createRoot(container);
    let latestPrewarm = null;
    let latestAttachments = null;
    let createCalls = 0;
    let shouldFailCreate = false;
    const uploadCalls = [];

    const platform = {
      openAttachmentDialog: async () => null,
    };
    const services = {
      promptAttachmentTransferService: {
        onDynamicProgress: () => () => {},
        stage: async () => ({ staged: true, ref: "ref", bytes: 5 }),
        adopt: async () => {},
        cancel: async () => {},
        cleanup: async () => {},
      },
    };

    function PrewarmAttachmentHarness() {
      const dispatchCommand = React.useCallback(async (type) => {
        if (type === "createSession") {
          createCalls += 1;
          if (shouldFailCreate) {
            throw new Error("createSession failed");
          }
          return {
            commandId: `cmd-${createCalls}`,
            status: "accepted",
            result: { type: "createSession", sessionId: `sess-prewarm-${createCalls}` },
          };
        }
        return { commandId: "cmd-del", status: "accepted" };
      }, []);

      const prewarm = useDraftSessionPrewarm({
        enabled: true,
        workspaceKey: conversationsDir,
        paneId: "primary",
        transportIdentity: "transport-1",
        dispatchCommand,
      });
      const attachments = useComposerAttachments({
        workspacePath: conversationsDir,
        scopeId: "__draft__",
        attachmentSessionId: prewarm.binding?.sessionId ?? null,
        sessionPreparationError: prewarm.error,
        onRetrySessionPreparation: prewarm.retry,
        attachmentPut: async (params) => {
          uploadCalls.push(params.sessionId);
          return { ref: `att-ref-${params.sessionId}` };
        },
      });
      latestPrewarm = prewarm;
      latestAttachments = attachments;
      return null;
    }

    await React.act(async () => {
      reactRoot.render(
        React.createElement(
          ZCodeIntlProvider,
          null,
          React.createElement(
            ServiceProvider,
            { services, composerClientNamespace: "web" },
            React.createElement(
              PlatformProvider,
              { platform },
              React.createElement(PrewarmAttachmentHarness),
            ),
          ),
        ),
      );
      await new Promise((r) => setTimeout(r, 20));
    });

    try {
      assert.ok(latestPrewarm.binding?.sessionId, "初始预热应成功");
      // 模拟预热会话失效（如 runtime 意外丢失），暴露失败出口
      await React.act(async () => {
        latestPrewarm.binding.discard("prewarm.session-lost");
      });
      assert.equal(latestPrewarm.binding, null);
      assert.equal(latestPrewarm.error, "prewarm.session-lost", "必须暴露预热失败出口");

      // 预热失败状态下添加附件：必须进入 failed，且绝不解锁跳过附件
      const file = new dom.window.File(["hello"], "note.txt", { type: "text/plain" });
      let addedIds = [];
      await React.act(async () => {
        addedIds = latestAttachments.addAttachmentFiles([file]);
      });
      assert.equal(addedIds.length, 1);
      assert.equal(latestAttachments.attachments[0].uploadStatus, "failed");
      assert.equal(latestAttachments.hasUnreadyAttachments, true, "失败附件不得解锁发送");
      assert.equal(
        await latestAttachments.prepareForSend(),
        null,
        "失败附件 prepareForSend 必须阻断",
      );

      // 利用现有附件重试按钮 -> 触发 prewarm.retry() -> 重建预热会话并完成附件上传
      shouldFailCreate = false;
      await React.act(async () => {
        latestAttachments.retryAttachment(addedIds[0]);
      });
      const uploadDeadline = Date.now() + 1000;
      while (
        ["waitingSession", "queued", "uploading", "committing"].includes(
          latestAttachments.attachments[0]?.uploadStatus,
        ) &&
        Date.now() < uploadDeadline
      ) {
        await React.act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      assert.equal(latestPrewarm.error, null, "重试成功后应清除预热错误");
      assert.ok(latestPrewarm.binding?.sessionId, "重试应重建预热会话");
      assert.equal(
        latestAttachments.attachments[0].uploadStatus,
        "ready",
        `唤醒后附件应完成上传: error=${latestAttachments.attachments[0]?.uploadError}`,
      );
      assert.equal(latestAttachments.hasUnreadyAttachments, false);
      assert.equal(uploadCalls.length, 1);
      passes.push("8 预热失败暴露重试出口且不解锁跳过未就绪/失败附件");
    } finally {
      await React.act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // 9. 手机 Home 新建等待目录准备完成后才 navigateToChat，失败留在 Home
  // ---------------------------------------------------------------------------
  {
    resetState();
    const shellSource = readFileSync(join(uiSrc, "app-shell/WorkspaceShellLayout.tsx"), "utf8");
    const onSourceIdx = shellSource.indexOf("onCreateConversationTaskOnSource={");
    const mobileBlock = shellSource.slice(
      shellSource.lastIndexOf("onCreateTask={", onSourceIdx),
      onSourceIdx,
    );
    assert.equal(
      (mobileBlock.match(/mobile\.navigateToChat\(\)/g) ?? []).length,
      2,
      "mobile.navigateToChat() 只能在 onCreateTask 与 onCreateConversationTask 的 onComplete 内各调用一次",
    );

    const realService9 = await createRealService("case9");
    let failPrepare = true;
    const wrappedService = {
      ...realService9,
      async prepareSession(params) {
        if (failPrepare) throw new Error("project.primaryRootMissing");
        return realService9.prepareSession(params);
      },
    };
    const tabStoreApi = createTabStore();
    tabStoreApi.getState().addTab(projDir, { workspacePurpose: "project" });
    const harness = await mountRootActionsHarness({
      projectService: wrappedService,
      tabStoreApi,
      clientNamespace: "web",
    });

    const mobileContainer = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(mobileContainer);
    const mobileRoot = ReactDOMClient.createRoot(mobileContainer);
    let triggerHomeNewConversation = null;

    function MobileShellHomeHarness() {
      return React.createElement(
        StoreProvider,
        { broadcastService: { onMessage: () => ({ dispose: () => {} }), send: async () => {} } },
        React.createElement(
          ZCodeIntlProvider,
          null,
          React.createElement(WebRemoteControlMobileShell, {
            isMobileViewport: true,
            activeWorkspacePath: projDir,
            activeTaskId: null,
            renderTaskHome: ({ navigateToChat }) => {
              triggerHomeNewConversation = async () => {
                await harness.latest.actions.handleCreateConversationTask({
                  projectId: null,
                  onComplete: () => {
                    navigateToChat();
                  },
                });
              };
              return React.createElement(
                "div",
                { "data-testid": "mobile-home-stub" },
                "home",
              );
            },
            renderChatHeader: () => null,
            chatContent: React.createElement("div", { "data-testid": "mobile-chat-stub" }, "chat"),
          }),
        ),
      );
    }

    await React.act(async () => {
      mobileRoot.render(React.createElement(MobileShellHomeHarness));
    });

    try {
      assert.ok(
        mobileContainer.querySelector('[data-mobile-page="home"]'),
        "初始应停留在手机 Home",
      );
      await React.act(async () => {
        await triggerHomeNewConversation();
      });
      assert.ok(
        mobileContainer.querySelector('[data-mobile-page="home"]'),
        "prepareSession 失败必须留在 Home，不能进入空白 Chat",
      );
      assert.equal(mobileContainer.querySelector('[data-mobile-page="chat"]'), null);

      failPrepare = false;
      await React.act(async () => {
        await triggerHomeNewConversation();
      });
      assert.ok(
        mobileContainer.querySelector('[data-mobile-page="chat"]'),
        "prepareSession 成功并触发 onComplete 后应切入 Chat",
      );
      passes.push("9 手机 Home 新建等待目录准备 onComplete，失败留在 Home");
    } finally {
      await React.act(async () => {
        mobileRoot.unmount();
      });
      mobileContainer.remove();
      await harness.unmount();
    }
  }

  for (const line of passes) console.log(`PASS ${line}`);
  console.log(`\n${passes.length} 组回归全部通过（临时目录 ${root}）`);
} finally {
  dom.window.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(0);
