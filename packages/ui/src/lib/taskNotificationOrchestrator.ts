import type { TaskNotificationPayload } from "@zcode/shared";
import { buildInteractionEventKey, buildTerminalTurnEventKey } from "@zcode/shared/web-push";
import type {
  ConversationSnapshot,
  PendingInteraction,
  SessionPhase,
  SessionSummary,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/index.js";

type FormatMessage = IntlInstance["formatMessage"];

export interface TaskNotificationWorkspaceContext {
  workspacePath?: string;
  workspaceIdentity?: string;
}

function withWorkspaceContext(
  payload: TaskNotificationPayload,
  workspace: TaskNotificationWorkspaceContext | undefined,
): TaskNotificationPayload {
  return {
    ...payload,
    ...(workspace?.workspacePath ? { workspacePath: workspace.workspacePath } : {}),
    ...(workspace?.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
  };
}

function terminalStatusForPhase(
  phase: SessionPhase,
): Extract<TaskNotificationPayload["status"], "completed" | "failed"> | null {
  // 用户主动停止或运行中发新消息抢占会产生 completedInterrupted，保持静默不弹“任务已完成”。
  if (phase === "completedSuccess") {
    return "completed";
  }
  if (phase === "error") {
    return "failed";
  }
  return null;
}

function taskTitleBody(
  title: string,
  fallbackMessageId: string,
  formatMessage: FormatMessage,
): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    return formatMessage({ id: "notification.taskWithTitle" }, { title: trimmedTitle });
  }
  return formatMessage({ id: fallbackMessageId });
}

/**
 * 终态事件键优先取稳定终态时间戳 terminalAt（缺失时回退 lastActivityAt），与服务端 syncer 及
 * 定时任务结算的 Web Push 一致；即使后续活动推进了 lastActivityAt，Service Worker 仍能合并为同一回合。
 */
function terminalEventKeyFor(session: SessionSummary): { eventKey?: string } {
  const terminalAt = session.terminalAt ?? session.lastActivityAt;
  return Number.isFinite(terminalAt)
    ? { eventKey: buildTerminalTurnEventKey(session.sessionId, terminalAt) }
    : {};
}

function terminalPayloadForSession(
  session: SessionSummary,
  status: Extract<TaskNotificationPayload["status"], "completed" | "failed">,
  formatMessage: FormatMessage,
): TaskNotificationPayload {
  if (status === "completed") {
    return {
      taskId: session.sessionId,
      status,
      ...terminalEventKeyFor(session),
      title: formatMessage({ id: "notification.completed" }),
      body: taskTitleBody(session.title, "notification.completedBody", formatMessage),
    };
  }

  return {
    taskId: session.sessionId,
    status,
    ...terminalEventKeyFor(session),
    title: formatMessage({ id: "notification.error" }),
    body: taskTitleBody(session.title, "notification.error", formatMessage),
  };
}

export function collectTerminalTaskNotificationPayloads(params: {
  previousBySessionId: ReadonlyMap<string, SessionSummary>;
  sessions: readonly SessionSummary[];
  formatMessage: FormatMessage;
  workspace?: TaskNotificationWorkspaceContext;
}): TaskNotificationPayload[] {
  const payloads: TaskNotificationPayload[] = [];
  for (const session of params.sessions) {
    const status = terminalStatusForPhase(session.phase);
    if (!status) continue;

    const previous = params.previousBySessionId.get(session.sessionId);
    if (!previous) continue;

    const previousStatus = terminalStatusForPhase(previous.phase);
    const sameTurnTerminal =
      previous.terminalAt === undefined ||
      session.terminalAt === undefined ||
      previous.terminalAt === session.terminalAt;
    if (previousStatus === status && sameTurnTerminal) continue;

    payloads.push(
      withWorkspaceContext(
        terminalPayloadForSession(session, status, params.formatMessage),
        params.workspace,
      ),
    );
  }
  return payloads;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanApprovalInteraction(payload: UserInputRequestPayload): boolean {
  if (payload.toolName === "ExitPlanMode") {
    return true;
  }
  if (!isPlainRecord(payload.schema)) {
    return false;
  }
  return (
    payload.schema.interaction === "plan_approval" || payload.schema.toolName === "ExitPlanMode"
  );
}

function pendingInteractionPayload(params: {
  snapshot: ConversationSnapshot;
  interaction: PendingInteraction;
  formatMessage: FormatMessage;
}): TaskNotificationPayload | null {
  const { snapshot, interaction, formatMessage } = params;
  const requestId = interaction.interactionId;
  // 与服务端交互推送同一事件键：同一个 interactionId 只提醒一次。
  const eventKey = buildInteractionEventKey(requestId);
  const taskId = snapshot.sessionId;
  const taskTitle = snapshot.meta.title;

  // workspace Hook review 的唯一入口是 Settings；不得把它伪装成
  // permission/elicitation 系统通知。
  if (interaction.payload.kind === "workspaceHookReview") {
    return null;
  }
  if (interaction.payload.kind === "pluginInstall") {
    return {
      taskId,
      status: "elicitation_request",
      requestId,
      eventKey,
      title: formatMessage({ id: "plugin.discovery.confirmTitle" }),
      body: interaction.payload.reason,
    };
  }

  if (interaction.payload.kind === "permission") {
    return {
      taskId,
      status: "permission_request",
      requestId,
      eventKey,
      title: formatMessage({ id: "notification.permissionRequired" }),
      body:
        interaction.payload.summary.trim() ||
        taskTitleBody(taskTitle, "notification.permissionRequired", formatMessage),
    };
  }

  if (isPlanApprovalInteraction(interaction.payload)) {
    return {
      taskId,
      status: "elicitation_request",
      requestId,
      eventKey,
      title: formatMessage({ id: "notification.planApprovalRequired" }),
      body: formatMessage({ id: "notification.planApprovalBody" }),
    };
  }

  return {
    taskId,
    status: "elicitation_request",
    requestId,
    eventKey,
    title: formatMessage({ id: "notification.inputRequired" }),
    body:
      interaction.payload.prompt.trim() ||
      taskTitleBody(taskTitle, "notification.inputRequired", formatMessage),
  };
}

export function collectPendingInteractionNotificationPayloads(params: {
  snapshot: ConversationSnapshot;
  seenRequestIds: ReadonlySet<string>;
  formatMessage: FormatMessage;
  workspace?: TaskNotificationWorkspaceContext;
}): TaskNotificationPayload[] {
  return params.snapshot.pendingInteractions
    .filter((interaction) => !params.seenRequestIds.has(interaction.interactionId))
    .flatMap((interaction) => {
      const payload = pendingInteractionPayload({
        snapshot: params.snapshot,
        interaction,
        formatMessage: params.formatMessage,
      });
      return payload ? [withWorkspaceContext(payload, params.workspace)] : [];
    });
}
