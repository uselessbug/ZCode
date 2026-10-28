import { useRef, useState } from "react";
import type {
  IZCodeTaskService,
  IWindowControllerService,
  ProjectTask,
} from "@/project-sidebar/contract.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import {
  deleteArchivedProjectTask,
  mutateProjectTask,
} from "@/project-sidebar/task-mutation.js";
import { archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export type ArchiveOperation = "unarchive" | "delete";
export type ArchiveOperationCounts = {
  succeeded: number;
  failed: number;
  skipped: number;
};

/**
 * 归档删除的逐项裁决（独立 Web 与桌面共用）。
 *
 * - 删除事实成立（deleteArchivedTask 返回 true）：移除行并计 succeeded。
 * - 调用前已不再归档/已删除/不存在（返回 false）：从归档视图移除该行并计 skipped，
 *   因为它已经不属于归档集合。
 * - 抛错：**不**移除行，计 failed。失败项必须留在归档列表中供重试，
 *   不能因为"确认后就被取消归档"或"CLI 失败"而提前隐藏。
 */
export async function runArchivedDeletion(options: {
  tasks: ProjectTask[];
  ports: { service: IZCodeTaskService; controller?: IWindowControllerService };
  resolveRemoteSessionId(task: ProjectTask): string | null | undefined;
  isStillArchived(task: ProjectTask): boolean;
  removeTaskState(task: ProjectTask): void;
  onError?(task: ProjectTask, error: unknown): void;
}): Promise<ArchiveOperationCounts> {
  const counts: ArchiveOperationCounts = { succeeded: 0, failed: 0, skipped: 0 };
  for (const task of options.tasks) {
    if (!options.isStillArchived(task)) {
      counts.skipped++;
      continue;
    }
    try {
      const deleted = await deleteArchivedProjectTask(
        options.ports,
        task,
        options.resolveRemoteSessionId(task),
      );
      options.removeTaskState(task);
      if (deleted) counts.succeeded++;
      else counts.skipped++;
    } catch (error) {
      counts.failed++;
      options.onError?.(task, error);
    }
  }
  return counts;
}

export function useArchiveManagement() {
  const directory = useProjectDirectory();
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((s) => s.removeTaskState);
  const confirm = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ArchiveOperationCounts | null>(null);
  const locked = useRef(false);
  const latest = useRef(directory);
  latest.current = directory;
  const run = async (tasks: ProjectTask[], operation: ArchiveOperation) => {
    if (locked.current || !tasks.length) return;
    // 固定确认时的身份集合；搜索变化、新归档和重复点击不能扩充已经确认的批次。
    const candidates = [
      ...new Map(tasks.filter((t) => t.archived).map((t) => [archiveTaskKey(t), t])).values(),
    ];
    if (!candidates.length) return;
    locked.current = true;
    setBusy(true);
    setResult(null);
    const counts: ArchiveOperationCounts = { succeeded: 0, failed: 0, skipped: 0 };
    try {
      if (operation === "delete") {
        if (
          !(await confirm({
            intent: "archive-management-delete",
            title: intl.formatMessage({ id: "archives.deleteTitle" }, { count: candidates.length }),
            description: intl.formatMessage({ id: "archives.deleteDescription" }),
            confirmLabel: intl.formatMessage({ id: "archives.delete" }),
            confirmVariant: "destructive",
          }))
        )
          return;
        // 归档删除复用带归档条件检查的 deleteArchivedTask；成功、跳过、失败各自计数，
        // 失败项绝不移除行，避免刷新前"看起来删掉了"。
        Object.assign(
          counts,
          await runArchivedDeletion({
            tasks: candidates,
            ports: { service, controller },
            resolveRemoteSessionId: (task) =>
              resolveRemoteWorkspaceSessionIdForTarget({
                ...task,
                state: useRemoteWorkspaceSessionStore.getState(),
              }),
            isStillArchived: (task) =>
              latest.current.tree.tasks.some(
                (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
              ),
            removeTaskState: (task) =>
              removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity),
            onError: (task, error) =>
              logger.error("[archive-management] 任务删除失败", {
                taskId: task.taskId,
                workspaceIdentity: task.workspaceIdentity,
                operation,
                error,
              }),
          }),
        );
      } else {
        for (const task of candidates) {
          if (
            !latest.current.tree.tasks.some(
              (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
            )
          ) {
            counts.skipped++;
            continue;
          }
          try {
            const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
              ...task,
              state: useRemoteWorkspaceSessionStore.getState(),
            });
            await mutateProjectTask(
              { service, controller },
              task,
              { kind: "archive", archived: false },
              remoteSessionId,
            );
            counts.succeeded++;
          } catch (error) {
            counts.failed++;
            logger.error("[archive-management] 任务操作失败", {
              taskId: task.taskId,
              workspaceIdentity: task.workspaceIdentity,
              operation,
              error,
            });
          }
        }
      }
      await latest.current.refresh();
      setResult(counts);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { ...directory, busy, result, run };
}
