/**
 * server-browser-control 标准调用示例：仅独立 HTTP 入口按需创建与关闭。
 */
import { createServerHostServices, disposeServiceResourcesAndWait } from "@zcode/services/node";
import { createServerBrowserControl, isStandaloneBrowserControlEnabled } from "./index.js";

export async function exampleStandaloneServerBrowserControl(options: {
  sourceServerId: string;
  zcodeBuiltinProviderConfigFilePath: string;
}): Promise<void> {
  const browserControl = isStandaloneBrowserControlEnabled()
    ? createServerBrowserControl()
    : undefined;
  try {
    const { services } = await createServerHostServices({
      sourceServerId: options.sourceServerId,
      zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
      browserControlExecutor: browserControl?.executor,
    });
    await disposeServiceResourcesAndWait(services);
  } finally {
    await browserControl?.close();
  }
}
