import type { FormatWebPushNotificationCopyInput, TaskNotificationStatusKind } from "./contract.js";

export * from "./contract.js";

export function buildInteractionNotificationTag(interactionId: string): string {
  return `zcode:interaction:${interactionId}`;
}

export function buildTerminalTaskNotificationTag(taskId: string): string {
  return `zcode:task:${taskId}:terminal`;
}

export function buildAutomationNotificationTag(runId: string): string {
  return `zcode:automation:${runId}`;
}

/**
 * 通知事件键：标识“同一个事实”，页内通知与 Web Push 共用，Service Worker 按它合并并持久去重。
 * 与显示替换 tag 分离：同一会话每轮回合的终态共用一个 tag 槽位，但事件键各不相同。
 * terminalAt 取会话进入当前终态的稳定时间戳（summary.terminalAt ?? 终态帧 lastActivityAt）：
 * 页面、服务端 syncer 与定时任务结算（同一次 syncer 终态迁移派生）观察到同一终态标识，
 * 即使后续 lastActivityAt 因其他活动推进也不漂移。
 */
export function buildTerminalTurnEventKey(sessionId: string, terminalAt: number): string {
  return `zcode:event:turn:${sessionId}:${terminalAt}`;
}

export function buildInteractionEventKey(interactionId: string): string {
  return `zcode:event:interaction:${interactionId}`;
}

/** 定时任务没有关联会话终态（如派发失败）时，以 runId 为事件归属。 */
export function buildAutomationRunEventKey(runId: string): string {
  return `zcode:event:automation:${runId}`;
}

export function buildTaskNotificationTag(input: {
  taskId: string;
  status: TaskNotificationStatusKind;
  requestId?: string;
}): string {
  if (
    input.requestId &&
    (input.status === "permission_request" || input.status === "elicitation_request")
  ) {
    return buildInteractionNotificationTag(input.requestId);
  }
  if (input.status === "feedback_update") {
    return `zcode:feedback:${input.taskId}`;
  }
  return buildTerminalTaskNotificationTag(input.taskId);
}

function truncateNotificationText(text: string | undefined, maxChars = 180): string {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return "";
  const chars = Array.from(trimmed);
  if (chars.length <= maxChars) return trimmed;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export function formatWebPushNotificationCopy(input: FormatWebPushNotificationCopyInput): {
  title: string;
  body: string;
} {
  const isEn = input.locale === "en-US";
  const cleanTitle = truncateNotificationText(input.sessionTitle, 96);
  const cleanDetail = truncateNotificationText(input.detail, 160);
  const taskLine = cleanTitle ? (isEn ? `Task: ${cleanTitle}` : `任务：${cleanTitle}`) : "";

  switch (input.kind) {
    case "task_completed":
      return {
        title: isEn ? "Task completed" : "任务已完成",
        body: taskLine || (isEn ? "Task completed" : "任务已完成"),
      };
    case "task_failed":
      return {
        title: isEn ? "Task error occurred" : "任务出错",
        body: cleanDetail
          ? taskLine
            ? `${taskLine} · ${cleanDetail}`
            : cleanDetail
          : taskLine || (isEn ? "Task error occurred" : "任务出错"),
      };
    case "approval":
      return {
        title: isEn ? "Your confirmation is needed" : "需要你的确认",
        body: cleanDetail
          ? taskLine
            ? `${taskLine} · ${cleanDetail}`
            : cleanDetail
          : taskLine || (isEn ? "Your confirmation is needed" : "需要你的确认"),
      };
    case "plan":
      return {
        title: isEn ? "Plan awaiting approval" : "计划等待确认",
        body: taskLine
          ? `${taskLine} · ${isEn ? "Review the plan to continue." : "请确认计划后继续执行"}`
          : isEn
            ? "Review the plan to continue."
            : "请确认计划后继续执行",
      };
    case "question":
      return {
        title: isEn ? "Your response is needed" : "需要你的回复",
        body: cleanDetail
          ? taskLine
            ? `${taskLine} · ${cleanDetail}`
            : cleanDetail
          : taskLine || (isEn ? "Your response is needed" : "需要你的回复"),
      };
    case "automation_completed":
      return {
        title: isEn ? "Scheduled task completed" : "定时任务已完成",
        body: taskLine || (isEn ? "Scheduled task completed" : "定时任务已完成"),
      };
    case "automation_failed":
      return {
        title: isEn ? "Scheduled task error occurred" : "定时任务出错",
        body: cleanDetail
          ? taskLine
            ? `${taskLine} · ${cleanDetail}`
            : cleanDetail
          : taskLine || (isEn ? "Scheduled task error occurred" : "定时任务出错"),
      };
  }
}
