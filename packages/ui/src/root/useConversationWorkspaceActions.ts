import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";
import {
  bindPendingTaskDraft,
  ensurePendingTaskDraft,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
} from "@/v4/composer/composerDraftStore.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  createTask,
  setWorkspaceActionError,
  composerClientNamespace,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  createTask: (source: string) => Promise<void>;
  setWorkspaceActionError: (error: string | null) => void;
  composerClientNamespace?: string;
}) {
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
    try {
      if (!services.projectService) throw new Error("project.service-unavailable");
      // 非项目工作区必须绑定稳定 draftId：prepareSession 按 draftId 分配目录，
      // 重复点击、回包丢失与刷新重连都命中同一目录，不会另建空目录。
      const scope = resolveComposerScope(null, undefined, composerClientNamespace);
      const pendingDraft = ensurePendingTaskDraft(scope);
      const result = await services.projectService.prepareSession({
        draftId: pendingDraft.draftId,
        reuseDraft: Boolean(pendingDraft.workspacePath),
      });
      // 目录就绪后写回草稿绑定与 workspace scope，供编辑器按同一归属读取草稿。
      bindPendingTaskDraft(scope, pendingDraft.draftId, result.workspacePath);
      rememberComposerWorkspaceScope(result.workspacePath, result.workspaceIdentity, scope);
      setWorkspaceActionError(null);
      return result.workspacePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [composerClientNamespace, services.projectService, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(
    () => createTask("task section new task"),
    [createTask],
  );

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
