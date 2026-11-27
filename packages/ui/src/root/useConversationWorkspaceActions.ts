import { useCallback, useEffect, useRef } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { logger } from "@/logger.js";
import type { TabStore, TabStoreState } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  bindPendingTaskDraft,
  ensurePendingTaskDraft,
  readPendingTaskDraft,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
  rotateMissingPendingTaskDraft,
} from "@/v4/composer/composerDraftStore.js";

const NAVIGATION_CANCELLED_ERROR_CODE = "project.navigation-cancelled";

function createNavigationCancelledError(): Error {
  return new Error(NAVIGATION_CANCELLED_ERROR_CODE);
}

function getErrorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : String(error);
}

export function useConversationWorkspaceActions({
  services,
  addTab,
  createTask,
  setWorkspaceActionError,
  composerClientNamespace,
  navigationSequenceRef,
  tabStoreApi,
  activeWorkspacePath,
  activeWorkspaceIdentity,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  createTask: (source: string, request?: CreateTaskRequest) => Promise<void>;
  setWorkspaceActionError: (error: string | null) => void;
  composerClientNamespace?: string;
  navigationSequenceRef?: { current: number };
  tabStoreApi?: TabStore;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
}) {
  const localNavigationSequence = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      localNavigationSequence.current += 1;
    };
  }, []);

  const handleSelectConversationWorkspace = useCallback(
    (path: string) => {
      // 对话工作区是 app 管理的独立 cwd，不属于用户项目：不走跨窗口项目激活，
      // 也不写 recentProjects，只用 purpose 让展示层把它归到“对话”。
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation" });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    const sequenceRef = navigationSequenceRef ?? localNavigationSequence;
    const sequence = ++sequenceRef.current;
    const originTab = tabStoreApi ? tabStoreApi.getState().activeTabId : undefined;
    const originWorkspace = activeWorkspacePath
      ? useZCodeSessionStore
          .getState()
          .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined)
      : null;
    const isCurrent = () =>
      mountedRef.current &&
      sequence === sequenceRef.current &&
      (!tabStoreApi || tabStoreApi.getState().activeTabId === originTab) &&
      (!activeWorkspacePath ||
        (() => {
          const state = useZCodeSessionStore
            .getState()
            .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined);
          return (
            state.activeTaskId === originWorkspace?.activeTaskId &&
            state.draftFocusVersion === originWorkspace?.draftFocusVersion
          );
        })());
    try {
      if (!services.projectService) throw new Error("project.service-unavailable");
      // 非项目工作区必须绑定稳定 draftId：prepareSession 按 draftId 分配目录，
      // 重复点击、回包丢失与刷新重连都命中同一目录，不会另建空目录。
      const scope = resolveComposerScope(null, undefined, composerClientNamespace);
      let pendingDraft = ensurePendingTaskDraft(scope);
      let result: Awaited<
        ReturnType<NonNullable<typeof services.projectService>["prepareSession"]>
      >;
      try {
        result = await services.projectService.prepareSession({
          draftId: pendingDraft.draftId,
          reuseDraft: Boolean(pendingDraft.workspacePath),
        });
      } catch (error) {
        if (!isCurrent()) throw createNavigationCancelledError();
        // 已绑定的草稿目录被移走：换绑新 draftId 重建目录，正文草稿按 scope 保存，不会丢失。
        // 有在途首发命令时 rotate 返回 null，保持原错误，绝不覆盖在途命令。
        const message = getErrorMessage(error);
        if (!pendingDraft.workspacePath || !message.includes("project.draft-workspace-missing"))
          throw error;
        const rotatedDraft = rotateMissingPendingTaskDraft(scope, pendingDraft.draftId);
        if (!rotatedDraft) throw error;
        pendingDraft = rotatedDraft;
        // 若已被其他入口换绑并绑定了目录，沿用当前 workspacePath 的 reuseDraft 状态做幂等校验，
        // 不得强行传 false 重建已被删除的目录。
        result = await services.projectService.prepareSession({
          draftId: rotatedDraft.draftId,
          reuseDraft: Boolean(rotatedDraft.workspacePath),
        });
      }
      if (!isCurrent()) throw createNavigationCancelledError();
      const currentDraft = readPendingTaskDraft(scope);
      if (!currentDraft || currentDraft.draftId !== pendingDraft.draftId) {
        throw createNavigationCancelledError();
      }
      // 目录就绪后写回草稿绑定与 workspace scope，供编辑器按同一归属读取草稿。
      bindPendingTaskDraft(scope, pendingDraft.draftId, result.workspacePath);
      rememberComposerWorkspaceScope(result.workspacePath, result.workspaceIdentity, scope);
      setWorkspaceActionError(null);
      return result.workspacePath;
    } catch (error) {
      const message = getErrorMessage(error);
      if (message === NAVIGATION_CANCELLED_ERROR_CODE || !isCurrent()) {
        logger.debug("[Root] conversation workspace resolution cancelled", { error });
        throw error;
      }
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    composerClientNamespace,
    navigationSequenceRef,
    services.projectService,
    setWorkspaceActionError,
    tabStoreApi,
  ]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(
    (request?: CreateTaskRequest) => createTask("task section new task", request),
    [createTask],
  );

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
