import type { IWebPushService } from "./contract.js";

export async function exampleSubscribeAndNotify(service: IWebPushService) {
  const config = await service.getConfig();
  if (!config.enabled) return;
  service.notifySessionEvent({
    kind: "task_completed",
    eventId: "sess-1:turn-1:completed",
    sessionId: "sess-1",
    sessionTitle: "修复构建脚本",
  });
}
