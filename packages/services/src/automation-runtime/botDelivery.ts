import type { AutomationBotDeliveryPort, AutomationRepoPort } from "./contract.js";

/**
 * 在 prompt 派发前完成 Bot 终态订阅，避免快速任务先完成、后注册 listener 而漏回推。
 */
export async function watchCronRunBotDelivery(params: {
  automationId: string;
  runId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  repo: Pick<AutomationRepoPort, "getBotDeliveryTarget">;
  botsService: AutomationBotDeliveryPort;
}): Promise<boolean> {
  const target = await params.repo.getBotDeliveryTarget(params.automationId, params.workspaceKey);
  if (!target) return false;
  await params.botsService.watchAutomationRun({
    target,
    ...(params.runId ? { runId: params.runId } : {}),
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  });
  return true;
}
