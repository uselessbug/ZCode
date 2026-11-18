/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { resolveServerOsUser } from "@zcode/shared/node";
import * as nodePath from "node:path";
import { basename, extname, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  Event,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import type { TopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IBotsService,
  IManagedWorktreeService,
  IProviderProvisioningTargetService,
  IProjectService,
  IWebPushService,
  WebPushValidationError,
} from "@zcode/services";
import {
  WEB_PUSH_API_CONFIG_PATH,
  WEB_PUSH_API_SUBSCRIPTIONS_PATH,
  WEB_PUSH_API_UNSUBSCRIBE_PATH,
  WEB_PUSH_MANIFEST_PATH,
  WEB_PUSH_SERVICE_WORKER_PATH,
  webPushSubscribeRequestSchema,
  webPushUnsubscribeRequestSchema,
} from "@zcode/shared/web-push";
import {
  botProviders,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  formatLogPrefix,
  serverRemoteInfoOutputSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_COMPATIBILITY_MANIFEST,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import {
  SourceServerWorkspaceIdentityChannelServer,
  type SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import { createHostCapabilityStore } from "./hostCapability.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

// Adapt only the standalone browser's "local" project label to this server.
// Storage remains owned by the canonical remote host; other hosts still fail closed.
function projectHost(value: unknown, from: string, to: string): any {
  if (Array.isArray(value)) return value.map((item) => projectHost(item, from, to));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "hostId" && item === from ? to : projectHost(item, from, to),
    ]),
  );
}

function createStandaloneProjectAlias<T extends object>(service: T, ownerHostId: string): T {
  if (!ownerHostId || ownerHostId === "local") throw new Error("Canonical remote owner required");
  // 恢复项目与本服务器项目数据估算/清理同样以第二个位置参数传 Host，遗漏转换会把 local 错路由到离线 Host。
  const positionalHostMethods = new Set([
    "deleteProject",
    "restoreProject",
    "reorderProjects",
    "resolveSessionDirectories",
    "measureProjectData",
    "deleteProjectData",
  ]);
  return new Proxy(service, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        const input = args.map((arg) => projectHost(arg, "local", ownerHostId));
        if (positionalHostMethods.has(String(property)) && input[1] === "local")
          input[1] = ownerHostId;
        const result = await method.apply(target, input);
        return projectHost(result, ownerHostId, "local");
      };
    },
  });
}

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const loggedServer = new LoggingChannelServer(rawServer, log);
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const peer = reverseClient
    ? resourcePeers?.attach(reverseClient.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL))
    : undefined;
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(peer ? peer.wrapAgent(agentService) : agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  // 受管 worktree 仅在受信 Desktop Host 或显式开启独立 Web 兼容的端上暴露；
  // 未开启独立 Web 兼容的远控终端客户端一律拒绝 worktree.local-only。
  if (
    clientMode !== "desktop-continuous" &&
    process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS !== "1" &&
    services.getOptional(IManagedWorktreeService)
  ) {
    const rejectLocalOnly = async (): Promise<never> => {
      throw new Error("worktree.local-only");
    };
    const disabledManagedWorktreeService: IManagedWorktreeService = {
      startNewTask: rejectLocalOnly,
      forkToWorktree: rejectLocalOnly,
      retryCreation: rejectLocalOnly,
      continueWithoutWorktree: rejectLocalOnly,
      dismissCreation: rejectLocalOnly,
      listCreations: rejectLocalOnly,
      onDidChangeCreations: Event.None,
      onDidSettleCreation: Event.None,
      listWorktrees: rejectLocalOnly,
      removeWorktree: rejectLocalOnly,
      pruneWorktrees: rejectLocalOnly,
      listStartRefs: rejectLocalOnly,
      isWorktreeAvailable: rejectLocalOnly,
      supportsWorktreeCwd: rejectLocalOnly,
    };
    overrides.set(IManagedWorktreeService.channelName, disabledManagedWorktreeService);
  }
  if (
    clientMode === "web-remote-replayable" &&
    process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS === "1"
  ) {
    const ownerHostId = remoteHostIdFromWorkspaceIdentity(
      buildServerRemoteWorkspaceIdentity({
        serverId: resolveHttpServerId(),
        workspacePath: "/",
      }),
    );
    const projectService = services.getOptional(IProjectService);
    if (!ownerHostId || !projectService)
      throw new Error("Standalone Web project authority unavailable");
    overrides.set(
      IProjectService.channelName,
      createStandaloneProjectAlias(projectService, ownerHostId),
    );
  }
  if (services.getOptional(IWebPushService)) {
    // Web Push 管理只走同源鉴权 HTTP API，不允许 WebSocket RPC 触发内部推送或关闭服务。
    overrides.set(IWebPushService.channelName, {});
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    peer?.dispose();
    reverseClient?.dispose();
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

export interface HttpServerOptions {
  topicResourcePeers?: TopicResourcePeers;
  serverId?: string;
  virtualProjects?: boolean;
  migrationFailedPathCount?: number;
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveHttpServerId(options: HttpServerOptions = {}): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return serverRemoteInfoOutputSchema.parse({
    serverId: resolveHttpServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: resolveServerOsUser(), hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      ...(options.virtualProjects ? { virtualProjects: true } : {}),
      ...(process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS === "1"
        ? { managedWorktrees: true }
        : {}),
      processResourceTelemetry: true,
      remoteConversationTelemetry: true,
    },
  });
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const authorization = c.req.header("authorization");
  if (
    authorization?.startsWith("Bearer ") &&
    authorization.slice("Bearer ".length).trim() === token
  ) {
    return true;
  }
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  if (pathname === WEB_PUSH_SERVICE_WORKER_PATH || pathname === WEB_PUSH_MANIFEST_PATH) {
    return false;
  }
  return !isTokenProtectedPath(pathname);
}

function isNoCacheStaticAsset(filePath: string): boolean {
  const fileName = basename(filePath);
  return (
    fileName === "index.html" ||
    fileName === basename(WEB_PUSH_SERVICE_WORKER_PATH) ||
    fileName === basename(WEB_PUSH_MANIFEST_PATH)
  );
}

function isSameOriginRequest(c: Context): boolean {
  const originHeader = c.req.header("origin")?.trim();
  if (!originHeader) {
    return true;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }
  if (
    (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
    originUrl.username ||
    originUrl.password
  ) {
    return false;
  }
  const reqUrl = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  let effectiveProtocol: "http:" | "https:";
  if (forwardedProto) {
    if (forwardedProto !== "http" && forwardedProto !== "https") {
      return false;
    }
    effectiveProtocol = `${forwardedProto}:`;
  } else if (reqUrl.protocol === "http:" || reqUrl.protocol === "https:") {
    effectiveProtocol = reqUrl.protocol;
  } else {
    return false;
  }
  if (originUrl.protocol !== effectiveProtocol) {
    return false;
  }
  const rawHost = c.req.header("host")?.trim() || reqUrl.host;
  if (!rawHost || /[\s/@?#]/.test(rawHost)) {
    return false;
  }
  let hostUrl: URL;
  try {
    hostUrl = new URL(`${effectiveProtocol}//${rawHost}`);
  } catch {
    return false;
  }
  if (hostUrl.username || hostUrl.password) {
    return false;
  }
  return (
    originUrl.hostname.toLowerCase() === hostUrl.hostname.toLowerCase() &&
    originUrl.port === hostUrl.port
  );
}

// 盘符路径（"Z:/x"、"Z:\x"、"Z:x"）在 Windows 的 path.resolve 下会被当作绝对/盘符相对
// 路径解析到另一块盘（含 subst 虚拟盘与映射的网络盘），一律拒绝，不做静态资源解析。
const DRIVE_QUALIFIED_PATH_PATTERN = /^[a-zA-Z]:/;

export function isPathDriveQualified(pathname: string): boolean {
  return DRIVE_QUALIFIED_PATH_PATTERN.test(pathname);
}

// pathApi 可注入便于跨平台测试。Windows 跨盘时 path.relative 返回的是绝对路径（如
// "Z:\marker.txt"），不以 ".." 开头，曾因此被误判为「在静态根内」导致越盘读取；
// relative 结果为绝对路径的一律视为越界，posix 语义不受影响。
export function isInsideDirectory(
  root: string,
  candidate: string,
  pathApi: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const diff = pathApi.relative(root, candidate);
  if (pathApi.isAbsolute(diff)) return false;
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${pathApi.sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  // 盘符路径必须在 resolve 之前拦截（含 %3A 解码后的形式），否则 Windows 上会解析到
  // 静态根所在盘之外的路径；直接 404，也不进入 SPA fallback。
  if (isPathDriveQualified(relativePath)) {
    return null;
  }
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  const authToken = options.authToken?.trim();
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(
        ws.raw as WebSocket,
        services,
        "desktop-continuous",
        options.workspaceIdentityMapper,
        options.topicResourcePeers,
      );
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  app.get(WEB_PUSH_API_CONFIG_PATH, async (c) => {
    const webPushService = services.getOptional(IWebPushService);
    if (!webPushService) {
      return c.json({ enabled: false, vapidPublicKey: null }, 200);
    }
    return c.json(await webPushService.getConfig(), 200);
  });

  app.post(WEB_PUSH_API_SUBSCRIPTIONS_PATH, async (c) => {
    if (!isSameOriginRequest(c)) {
      return c.json({ error: "Forbidden cross-origin request" }, 403);
    }
    const webPushService = services.getOptional(IWebPushService);
    if (!webPushService) {
      return c.json({ error: "Web push service is not available." }, 503);
    }
    const rawBody = await c.req.json().catch(() => null);
    const parsed = webPushSubscribeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid push subscription request", issues: parsed.error.flatten() },
        400,
      );
    }
    try {
      const result = await webPushService.upsertSubscription(parsed.data);
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof WebPushValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.post(WEB_PUSH_API_UNSUBSCRIBE_PATH, async (c) => {
    if (!isSameOriginRequest(c)) {
      return c.json({ error: "Forbidden cross-origin request" }, 403);
    }
    const webPushService = services.getOptional(IWebPushService);
    if (!webPushService) {
      return c.json({ error: "Web push service is not available." }, 503);
    }
    const rawBody = await c.req.json().catch(() => null);
    const parsed = webPushUnsubscribeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid push unsubscribe request", issues: parsed.error.flatten() },
        400,
      );
    }
    return c.json(await webPushService.removeSubscription(parsed.data.endpoint), 200);
  });

  // Bug 原因：旧 `/api/connect-remote` + `/ws/remote/:id` 会在 Server 内另起临时 stdio
  // runtime，绕过 R3 的 Window Host → Source Server attachment 主链；两个入口必须一起不可达。

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": isNoCacheStaticAsset(filePath)
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
