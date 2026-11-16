import {
  createServerHostServices,
  createTopicResourcePeers,
  disposeServiceResourcesAndWait,
  getAppConfigDir,
} from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import {
  createServerBrowserControl,
  isStandaloneBrowserControlEnabled,
  type ServerBrowserControlHandle,
} from "./browser-control/index.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";

async function main(): Promise<void> {
  let browserControl: ServerBrowserControlHandle | undefined;
  let services: Awaited<ReturnType<typeof createServerHostServices>>["services"] | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      server?.close();
      try {
        if (services) await disposeServiceResourcesAndWait(services);
      } finally {
        // 浏览器属于 HTTP Host；启动失败或退出时也要关闭仅 discovery 启动的实例。
        await browserControl?.close();
      }
    })();
    return closing;
  };
  const onSignal = () => {
    void close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("[zcode-server:http] shutdown failed", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
      environmentConfigRoot: getAppConfigDir(),
      content: readBundledZCodeBuiltinProviderConfig(),
    });
    const port = Number(process.env["PORT"]) || 3030;
    const host =
      process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
    const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
    const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
    const topicResourcePeers = createTopicResourcePeers();
    const serverId = resolveHttpServerId();
    browserControl = isStandaloneBrowserControlEnabled() ? createServerBrowserControl() : undefined;
    const created = await createServerHostServices({
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
      sourceServerId: serverId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
      browserControlExecutor: browserControl?.executor,
      automationExecutionEnabled: true,
    });
    services = created.services;
    server = createHttpServer(services, port, {
      serverId,
      workspaceIdentityMapper: created.workspaceIdentityMapper,
      migrationFailedPathCount: created.migrationFailedPathCount,
      virtualProjects: true,
      topicResourcePeers,
      ...(host ? { host } : {}),
      ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
      ...(authToken ? { authToken, authRequired: true } : {}),
    });
    server.once("error", (error: Error) => {
      console.error("[zcode-server:http] server failed", error);
      void close().finally(() => process.exit(1));
    });
  } catch (error) {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
