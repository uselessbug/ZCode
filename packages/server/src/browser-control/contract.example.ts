/**
 * server-browser-control 标准调用示例：仅独立 HTTP 入口按需创建与关闭，支持空闲驻留与任务生命周期回收。
 */
import { createServerHostServices, disposeServiceResourcesAndWait } from "@zcode/services/node";
import { createServerBrowserControl, isStandaloneBrowserControlEnabled } from "./index.js";

export async function exampleStandaloneServerBrowserControl(options: {
  sourceServerId: string;
  zcodeBuiltinProviderConfigFilePath: string;
}): Promise<void> {
  const browserControl = isStandaloneBrowserControlEnabled()
    ? createServerBrowserControl({ maxReleasedSessions: 16, releasedSessionIdleTtlMs: 30 * 60_000 })
    : undefined;
  try {
    const { services } = await createServerHostServices({
      sourceServerId: options.sourceServerId,
      zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
      browserControlExecutor: browserControl?.executor,
    });
    await browserControl?.executor.closeTaskSessions?.({
      workspacePath: "/workspace/example",
      sessionIds: ["sess_archived_1"],
    });
    await disposeServiceResourcesAndWait(services);
  } finally {
    await browserControl?.close();
  }
}
