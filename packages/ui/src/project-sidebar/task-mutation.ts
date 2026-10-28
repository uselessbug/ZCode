import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type {
  ProjectTaskRef,
  IZCodeTaskService,
  IWindowControllerService,
  WindowHostControllerMutation,
  WindowHostTaskAddress,
} from "@/project-sidebar/contract.js";
export type ProjectTaskMutation = Exclude<
  WindowHostControllerMutation,
  { kind: "open" | "resume" }
>;
interface ProjectTaskPorts {
  service: IZCodeTaskService;
  controller?: IWindowControllerService;
}
function taskAddress(task: ProjectTaskRef, remoteSessionId?: string | null): WindowHostTaskAddress {
  const identity = parseRemoteWorkspaceIdentity(task.workspaceIdentity ?? "");
  return {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    ...(identity?.kind === "server" ? { sourceServerId: identity.sourceServerId } : {}),
  };
}
/** 已查看事件读取唯一 owner 的 marker；不借用 UI 行缓存，也不跨 Source 使用本机服务。 */
export function readProjectTaskMeta(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  remoteSessionId?: string,
) {
  return ports.controller
    ? ports.controller.getTaskMeta({ address: taskAddress(task, remoteSessionId) })
    : ports.service.getTaskMeta(task);
}
/** 两个列表入口共用完整地址与命令路由；组织态和 CLI 事实仍各自只由原 owner 写入。 */
export async function mutateProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  mutation: ProjectTaskMutation,
  remoteSessionId?: string | null,
) {
  const target = {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  if (ports.controller)
    return ports.controller.mutateTask({
      address: taskAddress(task, remoteSessionId),
      mutation,
    });
  switch (mutation.kind) {
    case "archive":
      return mutation.archived
        ? ports.service.archiveTask(target)
        : ports.service.unarchiveTask(target);
    case "delete":
      await ports.service.deleteTask(target);
      return null;
    case "delete-archived":
      // 归档管理删除必须复用带归档条件检查的接口；普通 deleteTask 会绕过归档 guard。
      await ports.service.deleteArchivedTask(target);
      return null;
    case "rename":
      return ports.service.renameTask({ ...target, title: mutation.title });
    case "pin":
      return ports.service.setTaskPinned({ ...target, pinned: mutation.pinned });
    case "mark-read":
      return ports.service.setTaskUnread({
        ...target,
        unread: false,
        expectedUnreadAt: mutation.expectedUnreadAt,
      });
    case "mark-unread":
      return ports.service.setTaskUnread({ ...target, unread: true });
  }
}

/**
 * 归档条件删除的单条入口。Controller 存在时下发 owner 的 deleteArchivedTask（带归档 guard，
 * 返回 boolean）；无 Controller（独立 Web）时直接调用 service.deleteArchivedTask。
 * 返回 true 表示删除事实已成立，false 表示调用前已不再归档/已删除/不存在（跳过）。
 * 不采用"先读 meta.archived 再写"的两步：controller.getTaskMeta 的 ZCodeTaskMeta 不含
 * archived，且两步会引入确认框停留期间的 TOCTOU 竞态，owner 侧单次调用已原子判定。
 */
export async function deleteArchivedProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  remoteSessionId?: string | null,
): Promise<boolean> {
  const target = {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  if (!ports.controller) return ports.service.deleteArchivedTask(target);
  return ports.controller.deleteArchivedTask({
    address: taskAddress(task, remoteSessionId),
  });
}
