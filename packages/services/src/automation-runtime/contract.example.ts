import type { AutomationRuntimeHandle } from "./contract.js";

export async function automationRuntimeExample(runtime: AutomationRuntimeHandle): Promise<void> {
  await runtime.start();
  runtime.wake();
  if (runtime.canAcceptManualRun()) {
    await runtime.dispose();
  }
}
