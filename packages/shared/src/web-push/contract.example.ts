import {
  buildInteractionNotificationTag,
  formatWebPushNotificationCopy,
  webPushNotificationMessageSchema,
} from "./index.js";

export function exampleBuildApprovalPushMessage(sessionId: string, interactionId: string) {
  const copy = formatWebPushNotificationCopy({
    kind: "approval",
    locale: "zh-CN",
    sessionTitle: "重构通知模块",
    detail: "允许运行测试命令",
  });
  return webPushNotificationMessageSchema.parse({
    version: 1,
    action: "show",
    eventId: `${interactionId}:open`,
    tag: buildInteractionNotificationTag(interactionId),
    kind: "approval",
    title: copy.title,
    body: copy.body,
    taskId: sessionId,
    occurredAt: Date.now(),
  });
}
