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
