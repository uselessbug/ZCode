// 远控 / 分享网页运行在用户自己的浏览器里，版本不受我们控制。
// ZCT-2118215639243444224：Chrome 109 没有 Array.prototype.toSorted，Hook 详情组件渲染时抛
// TypeError，区域错误边界显示“这块界面出了点问题”。Vite 只降级语法、不补运行时 API，
// 这里只补产物实际用到、且高于构建语法基线的 API；core-js 会先检测原生实现，不覆盖新版浏览器。
// 必须放在最前面：ES module 按 import 顺序求值，其他模块执行前 API 需已就绪。
// 范围与新增规则见 docs/web-remote-control/web-browser-support.md。
import "core-js/stable/array/to-sorted";
import "core-js/stable/array/to-reversed";
import "core-js/stable/object/group-by";
import { consumeNotificationDeepLink, createWebPlatform } from "#src/platform/index.js";
import { mobilePluginDiscoveryTelemetrySchema } from "@zcode/shared";
import {
  sessionCreateTelemetrySchema,
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  createWebRemoteControlConnectionRecoveryTimeoutFailure,
  resolveWebRemoteControlRelayWsUrl,
  matchesWebRemoteControlRoutePath,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制启动、错误页和 web 平台桥接暂时集中在入口编排。 */
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  ensurePendingTaskDraft,
  readPendingTaskDraft,
  readComposerWorkspaceScope,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type Theme,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import "./styles.css";
import {
  connectViaProtocol,
  connectViaWebSocket,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zcode/client";

import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { WebLoginPage } from "./auth/WebLoginPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import type {
  WebRemoteControlFailure,
  WebRemoteControlFailureReason,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  WebRemoteControlPlatformRequestPayload,
  WebRemoteControlPlatformResponsePayload,
  WebRemoteControlWindowBootstrapResult,
  WebRemoteControlWorkspaceBridge,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceSwitchOptions,
  WebRemoteControlAppPayload,
  WebRemoteControlExternalWorkspaceBridge,
  ServerRemoteInfo,
  IPlatformService,
} from "@zcode/shared";

import {
  WebRemoteControlEntry,
  isWebRemoteControlOAuthCallback,
  type WebRemoteControlEntryConnection,
  createWebRemoteControlV2TokenClient,
  readKnownDevices,
  createWebRemoteControlDeviceClient,
  createWebRemoteControlBridgeRecoveryRunner,
  acceptWebRemoteControlBridgeInvalidation,
  resolveWebRemoteControlRecoveryTarget,
  getWebRemoteControlBridgeRecoveryRetryDelay,
  WebRemoteControlTerminalTransport,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlTerminalTransportState,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
  createWebRemoteControlLifecycleRecovery,
  WEB_REMOTE_CONTROL_DEFAULT_THEME,
  resolveWebRemoteControlInitialTheme,
  collectWebRemoteControlMobileDeviceInfo,
  createWebRemoteControlVersionGuard,
  resolveWebRemoteControlRoutePath,
  registerWebRemoteControlWorkspaceBridgeServices,
  connectWebRemoteControlWorkspaceBridgeServices,
  replayWebRemoteControlWorkspaceBridgeFrames,
  createWebRemoteControlTaskViewPublisher,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "#src/web-remote-control/index.js";

import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlLoadingScreen,
  type WebRemoteControlConnectingDevice,
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
  showWebRemoteControlVersionNotice,
} from "#src/web-remote-control/views.js";

type RootServices = Parameters<typeof Root>[0]["services"];
type ServiceMethod = (...args: any[]) => unknown;

function logWebRemoteControlTaskReadFailure(
  error: unknown,
  context: { taskId: string; workspaceKey: string },
): void {
  console.warn("[web-remote-control] 标记手机端 task 已读失败", {
    error: error instanceof Error ? error.message : String(error),
    taskId: context.taskId,
    workspaceKey: context.workspaceKey,
  });
}

async function markCurrentWebRemoteControlBridgeTaskRead({
  bridge,
  services,
  task,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  services: RootServices;
  task: WebRemoteControlTaskTarget;
}): Promise<void> {
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  if (taskWorkspaceKey !== bridge.workspaceKey) {
    // 修复原因：同路径 remote workspace 可能属于不同 identity，禁止误用当前 bridge 写另一条连接。
    console.warn("[web-remote-control] 跳过跨 workspace 的 task 已读写入", {
      taskId: task.taskId,
      taskWorkspaceKey,
      bridgeWorkspaceKey: bridge.workspaceKey,
    });
    return;
  }
  if (typeof task.unreadAt !== "number") {
    return;
  }

  const result = await markWebRemoteControlTaskRead({
    service: services.zcodeTaskService,
    target: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      expectedUnreadAt: task.unreadAt,
    },
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
  }
}

async function markOpenedWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  services,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  expectedUnreadAt?: number;
  services: RootServices;
}): Promise<void> {
  const result = await markWebRemoteControlBridgeTaskRead({
    bridge,
    expectedUnreadAt,
    service: services.zcodeTaskService,
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: bridge.initialTaskId ?? "unknown",
      workspaceKey: bridge.workspaceKey,
    });
  }
}

function resolveWebThemePreference(defaultTheme: Theme = WEB_REMOTE_CONTROL_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const saved = resolveWebThemePreference(
    isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
  );
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();
let isPageUnloading = false;

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

window.addEventListener("beforeunload", () => {
  isPageUnloading = true;
});

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
  /** 仅 /api/server-info 声明 capabilities.managedWorktrees 时为 true；`?remote=` 跨机代理与失败回退均不开启。 */
  managedWorktrees?: boolean;
  /** 首屏 /api/server-info 的访问结果：ok 表示已确认登录态有效，首连可直接握手。 */
  initialAccessState: "ok" | "auth-required" | "unknown";
}

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;

function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
  root.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      primaryActionLabel={
        failure.reason === "device-not-owned"
          ? isZhLocale()
            ? "切换账号"
            : "Switch account"
          : undefined
      }
      secondaryAction={
        isWebRemoteControlRoute()
          ? {
              label: isZhLocale() ? "选择其他设备" : "Choose another device",
              onClick: () => {
                void remoteEntry.chooseOtherDevice();
              },
            }
          : undefined
      }
      onReload={() => {
        if (failure.reason === "device-not-owned") void remoteEntry.switchAccount();
        else window.location.reload();
      }}
    />,
  );
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    isWebRemoteControlOAuthCallback(new URL(window.location.href)) ||
    (["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
      params.has("state") &&
      // BigModel 的 authCode 要先进入回调页，才能由 provider 归一化为 code。
      (params.has("code") || params.has("authCode") || params.has("error")))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/remote/v4");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/remote/v4");
      }}
    />,
  );
}

async function renderConversationSharePage(): Promise<void> {
  // 页面语言跟随路径前缀：/cn/share 中文，裸 /share 英文。
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
  document.documentElement.lang = routeLocale;
  // 分享页必须设置 title：否则浏览器标签只显示 index.html 的通用标题。
  // 会话标题要等 preview 加载完，先给一个语言正确的兜底。
  document.title = routeLocale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // Share 加载失败不能只有通用 network 文案：需要区分 mock、endpoint 配置或跨域 fetch。
  // 这里只记录运行时路由与 endpoint，不记录完整 pathname，避免把 share code 写入日志。
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider, signal) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        return webAuthService.startLogin({
          signal,
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG, "share"),
        });
      }}
      onLogout={onLogout}
      locale={routeLocale}
      theme={resolveWebThemePreference("zai-light")}
    />,
  );
}

function renderWebLoginPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  root.render(
    <WebLoginPage onLogin={(provider, signal) => remoteEntry.startLogin(provider, signal)} />,
  );
}

// 访问 window.localStorage 本身在部分浏览器会抛错，统一包在方法里交给调用方兜底。
const webRemoteControlStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

const remoteEntry = new WebRemoteControlEntry({
  auth: webAuthService,
  getHref: () => window.location.href,
  replaceHref: (href) => window.history.replaceState(window.history.state, "", href),
  storage: webRemoteControlStorage,
  locale: resolveWebRemoteControlScreenLocale(navigator.language),
  devices: createWebRemoteControlDeviceClient(window.location.origin),
  subscribeVisible: (listener) => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  },
  loginOptions: { devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG) },
  token: createWebRemoteControlV2TokenClient(window.location.origin),
  connect: (connection) => {
    void bootstrapExternalRelayWebRemoteControl(connection);
  },
  onView: (view) => {
    if (view.kind === "callback") renderWebAuthCallbackPage();
    else if (view.kind === "login") renderWebLoginPage();
    else if (view.kind === "devices") {
      document.title = "ZCode - Web Remote Control";
      root.render(
        <WebRemoteControlDeviceListPage
          view={view}
          onSelect={(sid) => remoteEntry.selectDevice(sid)}
          onRefresh={() => {
            void remoteEntry.refreshDevices();
          }}
          onSwitchAccount={() => {
            void remoteEntry.switchAccount();
          }}
          locale={resolveWebRemoteControlScreenLocale(navigator.language)}
        />,
      );
    } else if (view.kind === "failure") renderWebRemoteControlFailure(view.failure);
  },
});

function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl, initialAccessState: "unknown" };
  }

  // 受管 worktree 频道只在 Host 经 /api/server-info 声明 capabilities.managedWorktrees 时开启；
  // 响应失败、解析异常或旧 Server 缺省一律关闭（fail-closed），`?remote=` 跨机代理也不携带。
  // 同一次请求顺带确认登录态：redirect: "manual" 能识别网关把请求 302 到登录页，
  // 首连据此省掉一次重复的访问检查。
  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
      redirect: "manual",
      credentials: "same-origin",
    });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { wsUrl, initialAccessState: "auth-required" };
    }
    if (
      !response.ok ||
      response.headers.get("content-type")?.includes("application/json") !== true
    ) {
      return { wsUrl, initialAccessState: "unknown" };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      initialAccessState: "ok",
      ...(serverInfo.capabilities?.managedWorktrees === true ? { managedWorktrees: true } : {}),
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl, initialAccessState: "unknown" };
  }
}

function isWebRemoteControlRoute(): boolean {
  return (
    matchesWebRemoteControlRoutePath(window.location.pathname, "/remote/v4") ||
    matchesWebRemoteControlRoutePath(
      window.location.pathname,
      resolveWebRemoteControlRoutePath(import.meta.env),
    )
  );
}

function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

function createUnsupportedHomeOnlyService<T extends object>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        throw new Error(
          `${serviceName}.${String(property)} is not available before a Web remote control workspace bridge is connected.`,
        );
      },
    },
  ) as T;
}

const emptyHomeOnlyEvent = () => ({ dispose() {} });

function createEmptyHomeOnlyService<T extends object>(handlers: Record<string, ServiceMethod>): T {
  return new Proxy(handlers, {
    get: (target, property) => {
      if (typeof property !== "string") {
        return undefined;
      }
      if (target[property]) return target[property];
      // Bug 原因：bridge 服务由 ProxyChannel 生成，onDynamicXxx(arg) 同步返回 Event，onXxx 本身是 Event；
      // 这里曾把所有未列出成员都当 RPC 方法返回 Promise，手机 home 侧栏订阅任务事件时直接崩溃。
      // 按同一命名契约返回永不触发的空 Event，不再逐个补订阅兜底。
      if (/^onDynamic[A-Z]/.test(property)) return () => emptyHomeOnlyEvent;
      if (/^on[A-Z]/.test(property)) return emptyHomeOnlyEvent;
      return async () => undefined;
    },
  }) as T;
}

export function createHomeOnlyWebRemoteControlServices(): RootServices {
  const unsupported = (channel: string) => async () => {
    throw new Error(
      `${channel} is not available before a Web remote control workspace bridge is connected.`,
    );
  };
  const settingService: RootServices["settingService"] = {
    get: async () => ({
      recentProjects: [],
      locale: resolveWebRemoteControlScreenLocale(navigator.language),
    }),
    update: async () => {},
    updateDataBaseDir: async () => {},
    // 个性化指令编辑的是桌面 Host 的 ~/.zcode/AGENTS.md；未连接 bridge 前没有本机 Host，明确报错。
    getUserInstructions: unsupported("settingService.getUserInstructions"),
    saveUserInstructions: unsupported("settingService.saveUserInstructions"),
  };

  const emptyGitSummary = (workspacePath: string) => ({
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch" as const,
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  });
  // Bugfix: 手机端只有断开的远程 workspace 时，不能为了进入任务首页强行创建 bridge。
  // 这里提供只读/空结果服务，吸收 Root 首屏 OAuth、模型供应商、Git、技能等后台初始化，
  // 避免断连这种预期状态被误报成未处理异常；真正聊天能力仍需重连成功后切到 bridge services。
  const homeOnlyZCodeTaskService = createEmptyHomeOnlyService<RootServices["zcodeTaskService"]>({
    initialize: async () => ({ available: false }),
    releaseWorkspacePreparation: async () => {},
    checkCodexConnectivity: async () => ({ ok: true }),
    listTasks: async () => [],
    listPinnedTaskIds: async () => [],
    listPinnedTasks: async () => [],
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskTokenUsage: async (params: { taskId: string }) => ({
      sessionId: params.taskId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    listArchivedTasks: async () => [],
    getTaskSnapshot: async () => null,
    getTaskSnapshotWithEtag: async () => ({ snapshot: null }),
    getTaskSnapshotBody: async () => null,
    getTaskSnapshotRef: async () => null,
    getTaskSnapshotToolCallsSlice: async () => null,
    getTaskMeta: async () => null,
  });
  return {
    fileService: {
      readdir: unsupported("fileService.readdir"),
      stat: unsupported("fileService.stat"),
      checkFilesExist: unsupported("fileService.checkFilesExist"),
      resolvePath: unsupported("fileService.resolvePath"),
      createDefaultWorkspace: unsupported("fileService.createDefaultWorkspace"),
      ensureConversationWorkspace: unsupported("fileService.ensureConversationWorkspace"),
      createScratchWorkspace: unsupported("fileService.createScratchWorkspace"),
      readTextFile: unsupported("fileService.readTextFile"),
      readMediaPreview: unsupported("fileService.readMediaPreview"),
      readFileRange: unsupported("fileService.readFileRange"),
      readBinaryPreview: unsupported("fileService.readBinaryPreview"),
      searchWorkspaceFiles: unsupported("fileService.searchWorkspaceFiles"),
      listWorkspaceFilesLength: unsupported("fileService.listWorkspaceFilesLength"),
      listWorkspaceFilesRange: unsupported("fileService.listWorkspaceFilesRange"),
      readWorkspaceFileSearchIgnore: unsupported("fileService.readWorkspaceFileSearchIgnore"),
      applyWorkspaceFileSearchIgnoreTransform: unsupported(
        "fileService.applyWorkspaceFileSearchIgnoreTransform",
      ),
      writeWorkspaceFileSearchIgnore: unsupported("fileService.writeWorkspaceFileSearchIgnore"),
      readDesignSourceFile: unsupported("fileService.readDesignSourceFile"),
      writeDesignSourceFile: unsupported("fileService.writeDesignSourceFile"),
    },
    mediaPreviewService:
      createUnsupportedHomeOnlyService<NonNullable<RootServices["mediaPreviewService"]>>(
        "mediaPreviewService",
      ),
    gitService: createEmptyHomeOnlyService<RootServices["gitService"]>({
      getRepositorySummary: async (params: { workspacePath: string }) =>
        emptyGitSummary(params.workspacePath),
      getWorkspaceRepositoryInfo: async () => ({ repositories: [] }),
      getLocalBranches: async () => ({ branches: [], currentBranch: null }),
      getChanges: async () => [],
      getIgnoredPaths: async () => [],
      getDiff: async () => ({ sections: [], files: [] }),
      getBranchComparison: async () => ({
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      }),
      getIdentity: async () => ({
        userName: null,
        userEmail: null,
        nameSource: null,
        emailSource: null,
        scopeLabel: null,
      }),
      refresh: async () => ({ ok: true }),
    }),
    gitCheckpointService:
      createUnsupportedHomeOnlyService<RootServices["gitCheckpointService"]>(
        "gitCheckpointService",
      ),
    systemService: createUnsupportedHomeOnlyService<RootServices["systemService"]>("systemService"),
    terminalService:
      createUnsupportedHomeOnlyService<RootServices["terminalService"]>("terminalService"),
    settingService,
    credentialService: createEmptyHomeOnlyService<RootServices["credentialService"]>({
      load: async () => null,
    }),
    broadcastService: createEmptyHomeOnlyService<RootServices["broadcastService"]>({
      send: async () => {},
    }),
    zcodeTaskService: homeOnlyZCodeTaskService,
    zcodeAgentService: createEmptyHomeOnlyService<RootServices["zcodeAgentService"]>({
      initialize: async (params: { workspacePath: string; workspaceIdentity?: string }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode agent service is not available before workspace bridge is connected.",
      }),
      disposeAll: () => {},
    }),
    zcodeSessionService: createEmptyHomeOnlyService<RootServices["zcodeSessionService"]>({
      initializeWorkspace: async (params: {
        workspacePath: string;
        workspaceIdentity?: string;
      }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode session service is not available before workspace bridge is connected.",
      }),
    }),
    // 分享发布首期只属于 desktop local host；Web 首页和 /remote 不建立独立发布权威。
    conversationShareService: createUnsupportedHomeOnlyService<
      RootServices["conversationShareService"]
    >("conversationShareService"),
    promptAttachmentTransferService: createEmptyHomeOnlyService<
      RootServices["promptAttachmentTransferService"]
    >({
      stage: unsupported("promptAttachmentTransferService.stage"),
      adopt: async () => {},
      cancel: async () => {},
      cleanup: async () => {},
    }),
    botsService: createUnsupportedHomeOnlyService<RootServices["botsService"]>("botsService"),
    fileWatcherService: createEmptyHomeOnlyService<RootServices["fileWatcherService"]>({
      watch: async () => ({ dispose: () => {} }),
    }),
    oauthService: createEmptyHomeOnlyService<RootServices["oauthService"]>({
      getProviders: async () => [],
      getActiveProvider: async () => null,
      restoreCachedSession: async () => null,
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
      restoreSession: async () => null,
      refreshToken: async () => {},
      logout: async () => {},
      logoutAll: async () => {},
      cancelPending: async () => {},
    }),
    providerSettingsService: createEmptyHomeOnlyService<RootServices["providerSettingsService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      refresh: async () => ({ revision: 0, providers: [] }),
      testModelConnectivity: async () => ({ results: [] }),
    }),
    modelSelectionService: createEmptyHomeOnlyService<RootServices["modelSelectionService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
    }),
    sourceServerWorkspaceService: createUnsupportedHomeOnlyService<
      RootServices["sourceServerWorkspaceService"]
    >("sourceServerWorkspaceService"),
    usageStatsService:
      createUnsupportedHomeOnlyService<RootServices["usageStatsService"]>("usageStatsService"),
    codingPlanSubscriptionService: createUnsupportedHomeOnlyService<
      RootServices["codingPlanSubscriptionService"]
    >("codingPlanSubscriptionService"),
    clientConfigService: createEmptyHomeOnlyService<RootServices["clientConfigService"]>({
      getSnapshot: async () => ({
        pluginStoreOrder: null,
        zsrcUrl: null,
        uiPluginRecommendations: [],
      }),
    }),
    // 手机 Web 未连接 shared-host attachment 时禁止直连 scenes HTTP；返回空配置保持首页可用。
    clientScenesService: createEmptyHomeOnlyService<RootServices["clientScenesService"]>({
      list: async () => ({ code: 0, msg: "", data: [] }),
    }),
    // 闲时任务仅桌面本地（D13）；web home-only 环境按不支持处理。
    offPeakTaskService:
      createUnsupportedHomeOnlyService<RootServices["offPeakTaskService"]>("offPeakTaskService"),
    highspeedCardService:
      createUnsupportedHomeOnlyService<RootServices["highspeedCardService"]>(
        "highspeedCardService",
      ),
    skillsService: createEmptyHomeOnlyService<RootServices["skillsService"]>({
      list: async () => ({
        skills: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
        diagnostics: [],
      }),
      buildPromptContext: async ({ prompt }: { prompt: string }) => ({
        prompt,
        activatedSkillNames: [],
      }),
    }),
    skillSyncService:
      createUnsupportedHomeOnlyService<RootServices["skillSyncService"]>("skillSyncService"),
    mcpSyncService:
      createUnsupportedHomeOnlyService<RootServices["mcpSyncService"]>("mcpSyncService"),
    pluginSyncService:
      createUnsupportedHomeOnlyService<RootServices["pluginSyncService"]>("pluginSyncService"),
    userConfigSyncService:
      createUnsupportedHomeOnlyService<RootServices["userConfigSyncService"]>(
        "userConfigSyncService",
      ),
    pluginsService: createEmptyHomeOnlyService<RootServices["pluginsService"]>({
      list: async () => [],
    }),
    // M5 ③-3：设置页插件管理仅桌面/远控 bridge 可用，Web 首页 fallback 明确报不可用。
    pluginManagementService:
      createUnsupportedHomeOnlyService<RootServices["pluginManagementService"]>(
        "pluginManagementService",
      ),
    subagentsService: createEmptyHomeOnlyService<RootServices["subagentsService"]>({
      list: async () => ({ agents: [], capability: { supported: false } }),
    }),
    commandsService: createEmptyHomeOnlyService<RootServices["commandsService"]>({
      list: async () => ({
        commands: [],
        userCommands: [],
        pluginCommands: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
      }),
      setCommandEnabled: async () => undefined,
    }),
    hooksService: createEmptyHomeOnlyService<RootServices["hooksService"]>({
      loadHooks: async () => ({ hooks: [], hooksEnabled: false }),
      saveHooks: async () => undefined,
    }),
    memoryService: createEmptyHomeOnlyService<RootServices["memoryService"]>({
      loadMemory: async () => ({ memory: null }),
      listProjectMemories: async () => [],
      // 未连 bridge 前没有本机 Host，页内项目记忆查看/保存明确报不可用，避免返回假成功。
      readProjectMemoryFile: unsupported("memoryService.readProjectMemoryFile"),
      saveProjectMemoryFile: unsupported("memoryService.saveProjectMemoryFile"),
    }),
    outputStyleService: createEmptyHomeOnlyService<RootServices["outputStyleService"]>({
      listStyles: async () => ({ styles: [] }),
      getUserStylesDirectory: async () => ({ path: "" }),
    }),
    // Bugfix: feedbackService 成为统一服务接口后，Web 远控首页 fallback 也必须补齐。
    // 断开 bridge 时这里明确报不可用，避免类型通过但运行时误以为空反馈数据。
    feedbackService:
      createUnsupportedHomeOnlyService<RootServices["feedbackService"]>("feedbackService"),
    settingsSyncService:
      createUnsupportedHomeOnlyService<RootServices["settingsSyncService"]>("settingsSyncService"),
  };
}

function resolveExternalRelayWsUrl(): string {
  return resolveWebRemoteControlRelayWsUrl({ endpointOrigin: window.location.origin });
}

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function renderWebRemoteControlLoading(
  state: WebRemoteControlTerminalTransportState,
  device: WebRemoteControlConnectingDevice,
): void {
  document.title = "ZCode - Web Remote Control";
  root.render(
    <WebRemoteControlLoadingScreen
      state={state}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      device={device}
    />,
  );
}

async function bootstrapExternalRelayWebRemoteControl(
  connection: WebRemoteControlEntryConnection,
): Promise<void> {
  if (connection.signal.aborted) return;
  const { params: relayParams, getToken } = connection;
  const terminalClientSessionId = createWebRemoteControlRequestId("terminal-page");
  seedStableWebRemoteControlClientId(relayParams.deviceSid);
  // 平台只是展示偏好：取本机按 MID 记住的记录，扫码直连的陌生设备显示通用电脑图标。
  const connectingDevice: WebRemoteControlConnectingDevice = {
    name: relayParams.deviceName,
    platform: relayParams.deviceMid
      ? readKnownDevices(webRemoteControlStorage).get(relayParams.deviceMid)?.platform
      : undefined,
  };
  // 只由入口 owner 负责取消连接并选设备；不能重启 start()，否则会自动连回最近设备。
  const deviceNavigation = {
    deviceName: relayParams.deviceName,
    devicePlatform: connectingDevice.platform,
    chooseOtherDevice: () => {
      if (!connection.signal.aborted) void remoteEntry.chooseOtherDevice();
    },
  };

  let bootstrapping = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let bridgeRecoveryRetryAttempt = 0;
  let bridgeRecoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextBridgeGeneration = 0;
  const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    onAccepted: (result) => {
      if (terminalTransportState === "paired") taskViewPublisher.seed(result.mobileTaskViewEpoch);
    },
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let pendingRelayProtocol: typeof activeRelayProtocol;
  let pendingBridgeAbort: AbortController | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
    | undefined;
  const workspaceListUpdateListeners = new Set<WebRemoteControlWorkspaceListUpdateListener>();

  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (diagnostic: WebRemoteControlTerminalTransportDiagnostic) => {
    if (diagnostic.type === "socket-extensions") {
      return;
    }
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: diagnostic.type,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      previousState: "previousState" in diagnostic ? diagnostic.previousState : undefined,
      pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
      closeCode: "code" in diagnostic ? diagnostic.code : undefined,
      closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
      wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
      wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    });
  };

  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    if (
      error instanceof Error &&
      error.message === "Web remote control relay did not recover before timeout."
    ) {
      // Bugfix: 桌面端长时间休眠导致“假连接”时，手机端 recoverConnection 超时会先落入 unknown，
      // 随后 waiting timer 又触发 invalid-mobile，用户会看到前后冲突的两张错误页。
      // 这里把 recover 超时直接映射为 desktop-disconnected，并在失败后立即终止 transport，
      // 保证错误语义单一且稳定。
      return toWebRemoteControlFailure(
        "desktop-disconnected",
        "Desktop did not recover the Web remote control session in time.",
      );
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  const disposeConnection = () => {
    if (terminated) return;
    terminated = true;
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    versionGuard.dispose();
    disposeVersionInputGuard();
    disposeVersionNotice?.();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    pendingBridgeAbort?.abort();
    pendingBridgeAbort = undefined;
    pendingRelayProtocol?.dispose();
    pendingRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    lifecycle.dispose();
    window.removeEventListener("beforeunload", disposeConnection);
    connection.signal.removeEventListener("abort", disposeConnection);
  };

  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) return;
    sendMobileFailureDiagnostic(failure);
    disposeConnection();
    connection.onFailure(failure);
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

  const clearBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    bridgeRecoveryRetryAttempt = 0;
  };

  const scheduleBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer || terminated || isPageUnloading || versionGuard.isBlocked())
      return;
    const delay = getWebRemoteControlBridgeRecoveryRetryDelay(bridgeRecoveryRetryAttempt);
    if (delay === null) {
      // Bug 原因：旧逻辑把有界重试的 null 当成静默停止，导致已 degraded 的 protocol
      // 和旧 React Root 永久残留。预算耗尽必须进入既有终态边界，统一释放 bridge 资源并提供手动重试。
      renderBootstrapFailure(
        createWebRemoteControlConnectionRecoveryTimeoutFailure(
          "Mobile connection did not rebuild the workspace bridge within the retry budget.",
        ),
      );
      return;
    }
    bridgeRecoveryRetryAttempt += 1;
    bridgeRecoveryRetryTimer = setTimeout(() => {
      bridgeRecoveryRetryTimer = undefined;
      void recoverVisibleSession("bridge-rebuild-retry");
    }, delay);
  };

  const recoverVisibleSession = createWebRemoteControlBridgeRecoveryRunner(async (reason) => {
    if (isPageUnloading || terminated || versionGuard.isBlocked()) {
      return;
    }
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    const isBridgeRebuildRetry = reason === "bridge-rebuild-retry";
    if (!isBridgeRebuildRetry) {
      bridgeRecoveryRetryAttempt = 0;
      currentRecoveryId = createWebRemoteControlRequestId("recovery");
    } else {
      // 同一 degraded recovery flight 的 bridge open 每次换 bridge generation，但 recoveryId
      // 保持不变；这样迟到 response 仍能按 recovery 边界拒绝。
      currentRecoveryId ??= createWebRemoteControlRequestId("recovery");
    }
    let requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
    if (requiresBridgeRebuild) {
      activeRelayProtocol?.markDegraded();
    }
    bootstrapping = true;
    let transportRecovered = false;
    try {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] recover terminal session", {
          reason,
          recoveryId: currentRecoveryId,
          currentWorkspaceKey: preferredWorkspaceKey,
          currentTaskId: preferredTaskId,
        });
      }
      await transport.recoverConnection();
      transportRecovered = true;
      if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
        if (checkVersionOnRecovery) {
          try {
            await checkDesktopVersion();
          } catch (error) {
            // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
            if (!activeRelayProtocol.isDegraded()) throw error;
          }
        }
        // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
        // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
        // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
        // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
        if (!activeRelayProtocol.isDegraded()) {
          currentRecoveryId = undefined;
          return;
        }
      }
      // 校验期间也可能收到失效通知；实际转入重建后，失败必须沿原预算重试，不能沿用起点的健康判断。
      requiresBridgeRebuild = true;
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
      clearBridgeRecoveryRetry();
    } catch (error) {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal recover timed out, keeping current page for retry",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!terminated && !isPageUnloading && transportRecovered && requiresBridgeRebuild) {
        // Bug 原因：transport 已恢复但单次 bridge-open 失败时，旧逻辑只调用 transport
        // background recovery；旧 bridge 已 degraded，之后没有事件会再次发起 open。
        scheduleBridgeRecoveryRetry();
      } else if (!terminated && !isPageUnloading) {
        // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
        // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
        // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
        transport.recoverInBackground();
      }
    } finally {
      bootstrapping = false;
    }
  });

  renderWebRemoteControlLoading("connecting", connectingDevice);

  const taskViewPublisher = createWebRemoteControlTaskViewPublisher(
    (payload) => !terminated && !versionGuard.isBlocked() && transport.sendPayload(payload),
  );
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: resolveExternalRelayWsUrl(),
    deviceSid: relayParams.deviceSid,
    deviceMid: relayParams.deviceMid,
    appVersion: relayParams.appVersion,
    getToken,
    onRawTransportPayload: (payload) =>
      pendingRelayProtocol?.acceptPayload(payload) ||
      activeRelayProtocol?.acceptPayload(payload) ||
      false,
    onRawTransportFault: (reasonCode) => {
      pendingRelayProtocol?.markDegraded(reasonCode);
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "mobile-task-view-request") {
        taskViewPublisher.request(payload.epoch);
        return;
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        if (!pendingRelayProtocol?.acceptPayload(payload))
          activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        acceptWebRemoteControlBridgeInvalidation(
          pendingRelayProtocol,
          payload.bridgeSessionId,
          payload.reason,
        );
        // 通知可能在后台丢失，桌面会重复补发；重复通知不能重置在途恢复与有界重试预算。
        acceptWebRemoteControlBridgeInvalidation(
          activeRelayProtocol,
          payload.bridgeSessionId,
          payload.reason,
        );
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (
          pendingRelayProtocol &&
          payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
        )
          pendingRelayProtocol.markDegraded(payload.reason);
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          // 失效通知不对应 pending request；先关闭 workspace RPC 门禁，让既有会话
          // 显示断线横幅并保留草稿，不能让旧 services 继续被当作 ready。
          activeBridgeServiceRegistration?.dispose();
          activeBridgeServiceRegistration = undefined;
          acceptWebRemoteControlBridgeInvalidation(
            activeRelayProtocol,
            payload.bridgeSessionId,
            payload.reason,
          );
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
      }
    },
    onStateChange: (state) => {
      if (terminated || versionGuard.isBlocked()) {
        return;
      }
      taskViewPublisher.transportStateChanged(state, terminalTransportState);
      terminalTransportState = state;
      if (state !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(state);
      if (!ready) {
        renderWebRemoteControlLoading(state, connectingDevice);
      }
      if (state !== "paired") {
        return;
      }
      connection.onPaired();
      // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
      if (bootstrapping && pendingVersionCheck) return;
      // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
      if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated && !versionGuard.isBlocked()) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] terminal transport error", error.message);
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    onSendReady: () => {
      if (versionGuard.isBlocked()) return;
      taskViewPublisher.flush();
      replayWebRemoteControlWorkspaceBridgeFrames({ activeRelayProtocol, pendingRelayProtocol });
    },
    reloadPage: () => {
      window.location.reload();
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
  });

  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
    transport.recoverConnection(),
  );

  const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
    const requestId = createWebRemoteControlRequestId("bootstrap");
    const response = await requestAppPayload(
      { zcode_type: "bootstrap-request", requestId, terminalClientSessionId },
      (
        payload,
      ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
    );
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await versionGuard.check();
      // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
      while (
        !result &&
        !terminated &&
        !versionGuard.isBlocked() &&
        terminalTransportState === "paired"
      ) {
        result = await versionGuard.check();
      }
      return result;
    };
    const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
      () => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      },
    );
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    const platformResponse = response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
    const requestWorkspaceList = async () => {
      const requestId = createWebRemoteControlRequestId("workspace-list");
      return requestAppPayload(
        { zcode_type: "workspace-list-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-list-response" }
        > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
      );
    };
    const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
      // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
      // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
      recoverTimeout: true,
    });
    return normalizeWorkspaceListResult(response.result);
  };

  const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: relayParams.appVersion,
      }),
    });
  };

  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
    if (workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded()) {
      await recoverVisibleSession(
        "workspace-reconnected",
        () => workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded() === true,
      );
    }
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions & {
      project?: Extract<
        WebRemoteControlAppPayload,
        { zcode_type: "workspace-bridge-open" }
      >["project"];
    },
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  }> => {
    const bridgeSessionId = createWebRemoteControlRequestId("bridge");
    const bridgeGeneration = ++nextBridgeGeneration;
    pendingBridgeAbort?.abort();
    const bridgeAbort = new AbortController();
    pendingBridgeAbort = bridgeAbort;
    const isCurrent = () =>
      !terminated && !versionGuard.isBlocked() && bridgeGeneration === nextBridgeGeneration;
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        {
          zcode_type: "workspace-bridge-open",
          terminalClientSessionId,
          requestId: createWebRemoteControlRequestId("workspace-bridge"),
          bridgeSessionId,
          bridgeGeneration,
          ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
          workspaceKey,
          ...(options?.taskId ? { taskId: options.taskId } : {}),
          ...(options?.taskHostId ? { taskHostId: options.taskHostId } : {}),
          ...(options?.fileTreeTaskId ? { fileTreeTaskId: options.fileTreeTaskId } : {}),
          ...(options?.project ? { project: options.project } : {}),
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-bridge-ready" }
        > =>
          payload.zcode_type === "workspace-bridge-ready" &&
          payload.bridgeSessionId === bridgeSessionId,
      ),
    );
    if (!isCurrent() || bridgeAbort.signal.aborted) {
      throw new Error("Web remote control version changed before the workspace bridge was ready.");
    }
    currentRecoveryId = undefined;
    const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: response.bridge.bridgeSessionId,
      bridgeGeneration: response.bridge.bridgeGeneration,
      recoveryId: response.bridge.recoveryId,
      measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
      sendFrame: (frame) => {
        if (versionGuard.isBlocked()) return false;
        const result = transport.sendPayloadResult(frame);
        if (result.kind === "oversize") {
          throw new Error("remote.rpcFrame.envelopeTooLarge");
        }
        return result.kind === "sent";
      },
    });
    relayProtocol.onDegraded((fault) => {
      if (activeRelayProtocol !== relayProtocol) return;
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] raw relay bridge degraded", {
          bridgeSessionId: relayProtocol.getBridgeSessionId(),
          reasonCode: fault.reasonCode,
        });
      }
      void recoverVisibleSession(fault.reasonCode);
    });
    const services = await connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol,
      windowProjectDirectory:
        response.bridge.kind === "remote" &&
        response.bridge.capabilities?.windowProjectDirectory === true,
      activateTransport: () => {
        // 能力 RPC 必须先有收帧目标；服务与 Root 仍等就绪后才切换。
        pendingRelayProtocol = relayProtocol;
        return () => {
          if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
        };
      },
      isCurrent,
      signal: bridgeAbort.signal,
    });
    const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: response.bridge,
      services,
    });
    // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
    void markOpenedWebRemoteControlBridgeTaskRead({
      bridge: response.bridge,
      expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
      services,
    });
    const previousRelayProtocol = activeRelayProtocol;
    const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
    activeRelayProtocol = relayProtocol;
    taskViewPublisher.setBridge(response.bridge);
    if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
    if (pendingBridgeAbort === bridgeAbort) pendingBridgeAbort = undefined;
    activeBridgeServiceRegistration = bridgeServiceRegistration;
    previousRelayProtocol?.dispose();
    previousBridgeServiceRegistration?.dispose();
    currentWorkspaceKey = response.bridge.workspaceKey;
    currentTaskId = response.bridge.initialTaskId;
    await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
    if (!isCurrent()) throw new Error("Workspace bridge request was superseded.");
    return { bridge: response.bridge, services, relayProtocol };
  };

  // 平台实例持有 Service Worker 与通知监听，整个远控会话只创建一次，避免每次 render 泄漏监听器。
  let remoteControlPlatform: IPlatformService | undefined;
  const getRemoteControlPlatform = (): IPlatformService => {
    remoteControlPlatform ??= createWebPlatform({
      externalWebRemoteControlProxy: {
        requestPlatformMethod,
        reportTelemetryEvent: (event) => {
          const parsed = sessionCreateTelemetrySchema
            .or(mobilePluginDiscoveryTelemetrySchema)
            .safeParse(event);
          if (parsed.success)
            transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
        },
      },
    });
    return remoteControlPlatform;
  };

  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
    initialTaskDraft?: ComponentProps<typeof Root>["initialTaskDraft"],
    initialSidebarFileTreeOpen = false,
  ) => {
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={getRemoteControlPlatform()}
            // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
            // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
            // 不进入 relay、Host 或 replayable 状态。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialTaskDraft={initialTaskDraft}
            composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
            terminalOwnerId={bridge.terminalOwnerId}
            initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={connectingDevice}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation,
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, options);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
              updateMobileTaskView: async (view) => {
                taskViewPublisher.update(bridge, view);
              },
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const openProjectDraft = async (
    request: NonNullable<ComponentProps<typeof Root>["initialTaskDraft"]>,
    navigation: "open" | "restore" = "open",
  ) => {
    const projectId = request.projectId ?? null;
    const pendingDraft =
      !projectId && (!request.hostId || request.hostId === "local")
        ? ensurePendingTaskDraft({
            clientNamespace: `mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`,
            hostId: "local",
            projectId: null,
          })
        : null;
    const result = await openWorkspaceBridge(currentWorkspaceKey ?? "project-navigation", {
      project: {
        projectId,
        ...(request.hostId ? { hostId: request.hostId } : {}),
        ...(pendingDraft
          ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
          : {}),
      },
    });
    renderExternalRelayRoot(
      result.services,
      result.bridge,
      navigation === "open" ? "chat" : undefined,
      {
        ...request,
        projectId,
        ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
      },
    );
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated || versionGuard.isBlocked()) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    if (terminated || versionGuard.isBlocked()) return;
    // Bug 原因：staging 合并 a861a83cbc 丢了这里的 ready 标记，home-only 挂载后每次配对状态抖动
    // 都会被 onStateChange 当成首屏重渲染加载页，配对恢复后再整页重挂，引导与本地状态全部丢失。
    // 与 bridge Root 一致：Root 挂载后由其自身横幅展示断线状态。
    ready = true;
    root.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
            services={createHomeOnlyWebRemoteControlServices()}
            platform={getRemoteControlPlatform()}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={connectingDevice}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation,
              listWorkspaces: async () => ({
                ...(await listWorkspaces()),
                activeWorkspaceKey: currentWorkspaceKey,
                activeTaskId: currentTaskId,
              }),
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
    const savedView = options?.preferredWorkspaceKey
      ? { activeWorkspaceKey: options.preferredWorkspaceKey, activeTaskId: options.preferredTaskId }
      : bootstrapResult.mobileViewState;
    const savedScope =
      savedView?.activeWorkspaceKey && !savedView.activeTaskId
        ? readComposerWorkspaceScope(
            savedView.activeWorkspaceKey,
            undefined,
            `mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`,
          )
        : undefined;
    const pendingDraft = savedScope?.projectId === null ? readPendingTaskDraft(savedScope) : null;
    if (
      savedView &&
      !savedView.activeTaskId &&
      pendingDraft?.workspacePath &&
      savedView.activeWorkspaceKey === pendingDraft.workspacePath
    ) {
      // 刷新会释放旧 bridge，手机独有的草稿目录随之退出 workspace 候选。
      // 同时核对当前设备的作用域与 draftId，由 Host 重新校验目录；同目录的项目草稿不能误认领。
      await openProjectDraft({ projectId: null, hostId: "local" }, "restore");
      return;
    }
    const selectedWorkspace = resolveWebRemoteControlRecoveryTarget(bootstrapResult, options);
    if (!selectedWorkspace) {
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
    }
    if (!selectedWorkspace.canBridge) {
      // Source 断开后的 bootstrap 只确认离线，不替换当前 Root；内容与草稿仍由
      // 原会话 owner 持有。冷启动没有已加载 bridge，继续使用原 home-only 边界。
      if (activeRelayProtocol && selectedWorkspace.workspaceKey === currentWorkspaceKey) {
        activeBridgeServiceRegistration?.dispose();
        activeBridgeServiceRegistration = undefined;
        return;
      }
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
      taskHostId: selectedWorkspace.taskHostId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
  };

  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // hidden/pagehide/freeze 后 JS 与 WebSocket 都可能暂停；先撤销查看，再关闭发送门。
      // 导航恢复位置保留，是否重建 bridge 仍由既有恢复流程决定。
      taskViewPublisher.suspend();
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });
  window.addEventListener("beforeunload", disposeConnection, { once: true });
  connection.signal.addEventListener("abort", disposeConnection, { once: true });
  transport.start();
}

type StandaloneWebConnectionState = "connecting" | "reconnecting" | "connected" | "auth-required";

// 首次连接超过该时间仍未连上才显示连接提示；之前保留 index.html 的启动动画，避免先闪一下横幅。
const STANDALONE_INITIAL_CONNECT_HINT_DELAY_MS = 3_000;
// 曾成功加载过 services 后的重连提示延迟；页面一直可读可写，后台静默重连期间不打扰用户。
const STANDALONE_RECONNECT_HINT_DELAY_MS = 4_500;
// 空闲周期心跳的超时；后台恢复时探活要更快失败以便立即重连。
const STANDALONE_IDLE_PULSE_TIMEOUT_MS = 10_000;
const STANDALONE_RECOVER_PULSE_TIMEOUT_MS = 2_500;

interface StandaloneWebConnectionPorts {
  connect(options: { signal: AbortSignal; onClose(): void }): Promise<RootServices>;
  checkAccess(signal: AbortSignal): Promise<boolean>;
  /** 首屏已确认登录态有效时为 true，首次建连直接握手；握手失败后才用 checkAccess 区分鉴权失效。 */
  initialAccessVerified: boolean;
  onReady(services: RootServices): void;
  onState(state: StandaloneWebConnectionState): void;
  windowTarget: Pick<Window, "addEventListener" | "removeEventListener">;
  documentTarget: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
}

// 修复依据：独立 Web 只有首连，close 回调为空；后台恢复和旧 RPC 清理由此无人负责。
// 当前控制器只拥有连接代际，不保存任务事实，不自动重放任何业务写请求。
function createStandaloneWebConnection(ports: StandaloneWebConnectionPorts) {
  let stopped = false;
  let hadReady = false;
  let accessVerified = ports.initialAccessVerified;
  // 连续失败次数：0 表示这是一次意外断开后的第一次重连，立即重试。
  let failures = 0;
  let current: AbortController | undefined;
  let live: RootServices | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let pulseDeadline: ReturnType<typeof setTimeout> | undefined;
  let pulseDeadlineAt = 0;
  let broadcastSubscription: { dispose(): void } | undefined;
  const broadcastListeners = new Set<
    Parameters<RootServices["broadcastService"]["onMessage"]>[0]
  >();
  // 全局 Zustand Store 只在首次挂载捕获广播接口；保持这个引用，重连只替换它的真实目标。
  const broadcast = new Proxy({} as RootServices["broadcastService"], {
    get(_target, key) {
      if (key === "onMessage") {
        return (listener: Parameters<RootServices["broadcastService"]["onMessage"]>[0]) => {
          broadcastListeners.add(listener);
          return { dispose: () => broadcastListeners.delete(listener) };
        };
      }
      return (...args: unknown[]) => {
        if (!live) return Promise.reject(new Error("ConnectionClosed"));
        return Reflect.apply(Reflect.get(live.broadcastService, key), live.broadcastService, args);
      };
    },
  });
  // 修复原因：重连必然产生新的 RemoteServiceAccess，settingService 实例随之更换；
  // useSettings 的默认 cacheKey 按 settingService 实例身份分键（WeakMap），新实例会命中初始
  // { settings: null } 快照，使 OccupationOnboarding 在 !settings 时整块卸载 workspace 内容
  //（编辑器与草稿），表现为重连时闪一下刷新。这里与 broadcastService 同款：只包 settingService
  // 一个成员，保持稳定转发对象身份，每次调用路由到当前 live.settingService。
  // 未连接时明确拒绝 ConnectionClosed，不排队、不缓存、不重放任何设置写请求；
  // 官方 useSettings 缓存仍按同一 cacheKey 命中，快照继续由它唯一拥有，这里不保存设置。
  // 作用域仅限本 controller 的 Root 级 accessor，不修改全局 cacheKey，也不跨 Host 串味。
  const settingService = new Proxy({} as RootServices["settingService"], {
    get(_target, key) {
      return (...args: unknown[]) => {
        if (!live) return Promise.reject(new Error("ConnectionClosed"));
        return Reflect.apply(Reflect.get(live.settingService, key), live.settingService, args);
      };
    },
  });
  const publish = (state: StandaloneWebConnectionState) => {
    if (!stopped) ports.onState(state);
  };
  const clearTimers = () => {
    clearTimeout(retryTimer);
    clearTimeout(heartbeatTimer);
    retryTimer = heartbeatTimer = undefined;
  };
  const clearPulseDeadline = () => {
    clearTimeout(pulseDeadline);
    pulseDeadline = undefined;
    pulseDeadlineAt = 0;
  };
  const forget = () => {
    const old = current;
    current = undefined;
    live = undefined;
    clearPulseDeadline();
    broadcastSubscription?.dispose();
    broadcastSubscription = undefined;
    old?.abort();
  };
  const schedule = () => {
    if (stopped || retryTimer) return;
    publish("reconnecting");
    // 第一次重连不等待（后台回切时 visible 与 close 谁先到都不会多等 1 秒），
    // 再失败才按 1s、2s、4s、8s 退避；成功连上或主动恢复会把计数清零。
    const delay = failures === 0 ? 0 : Math.min(8_000, 1_000 * 2 ** Math.min(failures - 1, 3));
    failures += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attempt();
    }, delay);
  };
  const drop = (owner: AbortController) => {
    if (current !== owner || stopped) return;
    clearTimers();
    forget();
    schedule();
  };
  const setPulseDeadline = (owner: AbortController, timeoutMs: number) => {
    clearTimeout(pulseDeadline);
    pulseDeadlineAt = Date.now() + timeoutMs;
    pulseDeadline = setTimeout(() => drop(owner), timeoutMs);
  };
  const pulse = async (timeoutMs = STANDALONE_IDLE_PULSE_TIMEOUT_MS) => {
    const owner = current;
    const services = live;
    if (!owner || !services || stopped) return;
    if (pulseDeadline !== undefined) {
      // 切回前台时复用已经发出的心跳，只缩短仍在等待的截止时间。
      if (Date.now() + timeoutMs < pulseDeadlineAt) setPulseDeadline(owner, timeoutMs);
      return;
    }
    clearTimeout(heartbeatTimer);
    setPulseDeadline(owner, timeoutMs);
    try {
      await services.systemService.info();
      if (current !== owner || stopped) return;
      clearPulseDeadline();
      heartbeatTimer = setTimeout(() => void pulse(), 25_000);
    } catch {
      drop(owner);
    }
  };
  const attempt = async () => {
    if (stopped || current) return;
    clearTimers();
    const owner = new AbortController();
    current = owner;
    publish(hadReady ? "reconnecting" : "connecting");
    // 登录态已知有效（首屏确认过，或曾连上过）时直接握手，只需一次往返；
    // 握手失败后才检查是不是登录态过期，其余情况先检查再握手。
    const skippedAccessCheck = hadReady || accessVerified;
    accessVerified = false;
    try {
      if (!skippedAccessCheck && !(await ports.checkAccess(owner.signal))) {
        if (current !== owner || stopped) return;
        forget();
        publish("auth-required");
        return;
      }
      if (current !== owner || stopped) return;
      const services = await ports.connect({
        signal: owner.signal,
        // 握手失败时适配器也会回调 close。此时由下方 catch 检查鉴权，避免提前清掉代际。
        onClose: () => {
          if (live) drop(owner);
        },
      });
      if (current !== owner || stopped) return;
      live = services;
      broadcastSubscription = services.broadcastService.onMessage((message) => {
        if (current === owner) for (const listener of broadcastListeners) listener(message);
      });
      failures = 0;
      hadReady = true;
      // 只稳定 settingService/broadcastService 两个引用；其余 services 每次保持 fresh，
      // 让 Root 的 [services] effect 重新读取最新设置，而不是把设置快照搬进转发对象。
      ports.onReady({ ...services, broadcastService: broadcast, settingService });
      publish("connected");
      heartbeatTimer = setTimeout(() => void pulse(), 25_000);
    } catch {
      if (skippedAccessCheck && current === owner && !stopped) {
        try {
          if (!(await ports.checkAccess(owner.signal))) {
            if (current !== owner || stopped) return;
            forget();
            publish("auth-required");
            return;
          }
        } catch {
          // 探测本身失败说明服务端或网络不可达，按普通断线退避重试。
        }
      }
      drop(owner);
    }
  };
  const recover = () => {
    if (stopped) return;
    // 回到前台是新的恢复窗口：不论 close 与 visible 谁先到，第一次重连都不等待。
    failures = 0;
    if (live) {
      void pulse(STANDALONE_RECOVER_PULSE_TIMEOUT_MS);
    } else if (!current) {
      clearTimers();
      void attempt();
    }
  };
  // 复用官方远控生命周期恢复：只有真正经历过 hidden/pagehide/freeze 暂停后，
  // 恢复事件（visible/pageshow/online/resume）才触发重连，避免首屏 pageshow 或并发恢复事件重复建连。
  // onSuspend 保持最小接线：不主动关闭健康 WebSocket、不清空业务状态；
  // 当前代际和探活截止时间负责去重，保持最多一条连接和一次探活。
  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: ports.documentTarget,
    windowTarget: ports.windowTarget,
    onSuspend: () => {},
    onRecover: () => recover(),
  });
  void attempt();
  return {
    retry() {
      if (stopped) return;
      // 修复：自动恢复在握手/鉴权探测中会去重；手动重试必须立即替换卡住的旧代际。
      // 生命周期恢复仍沿用轻量探活，旧异步结果由 current owner 校验拦截。
      clearTimers();
      forget();
      failures = 0;
      void attempt();
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      clearTimers();
      forget();
      broadcastListeners.clear();
      lifecycle.dispose();
    },
  };
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebRemoteControlRoute() || isWebRemoteControlOAuthCallback(new URL(window.location.href))) {
    document.documentElement.lang = resolveWebRemoteControlScreenLocale(navigator.language);
  }
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  if (isWebRemoteControlRoute()) {
    await remoteEntry.start();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }

  // 通知点击冷启动：读取 zcodeTask/zcodeWorkspace 后立即清掉，刷新页面不会再次跳转。
  // 带 workspace 的深链直接作为 Root 的初始 workspace/任务，避免先落到服务器默认 workspace 的草稿，
  // 也不再放进点击队列重复执行；Root 在历史 tab 恢复完成后才注入初始目标，不会被 restoreTabs 覆盖。
  // 只带 taskId 的深链没有目标 workspace，仍走点击队列由 Root 遍历已打开的 workspace 定位。
  const coldLaunchTarget = consumeNotificationDeepLink();
  const coldLaunchWorkspace = coldLaunchTarget?.workspacePath ? coldLaunchTarget : null;
  const platform = createWebPlatform({
    initialNotificationTarget: coldLaunchWorkspace ? null : coldLaunchTarget,
  });
  document.title = "ZCode - Web + Server";
  let services: RootServices | undefined;
  const authRequiredAtStart = bootstrap.initialAccessState === "auth-required";
  let state: StandaloneWebConnectionState = authRequiredAtStart ? "auth-required" : "connecting";
  let connection: ReturnType<typeof createStandaloneWebConnection> | undefined;
  let hasLoadedServices = false;
  // 连接提示有宽限期：首连 3 秒、重连 4.5 秒内悄悄进行，不闪横幅；auth-required 立即提示。
  // 首连成功前提示不显示时不渲染，#root 保留 index.html 的启动动画，连上后一次渲染直出首页。
  let showConnectionHint = authRequiredAtStart;
  let connectionHintTimer: ReturnType<typeof setTimeout> | undefined;
  const zh = isZhLocale();
  const isPending = (value: StandaloneWebConnectionState) =>
    value === "connecting" || value === "reconnecting";
  const clearConnectionHintTimer = () => {
    if (connectionHintTimer) clearTimeout(connectionHintTimer);
    connectionHintTimer = undefined;
  };
  const render = () => {
    if (!services && !showConnectionHint) return;
    root.render(
      <>
        {/* 修复依据：保持同一组件树和 key，让重连更新服务，而不是卸载草稿和导航。
            重连期间不锁定页面：用户可继续滚动阅读、在输入框打字，软键盘也不会被收起。 */}
        <div className="contents">
          {services ? (
            <AppErrorBoundary>
              <ZCodeIntlProvider
                settingService={services.settingService}
                broadcastService={services.broadcastService}
              >
                <Root
                  services={services}
                  platform={platform}
                  // 独立 Web：入口显式声明本页 user/project MCP 归属当前服务器 base Host。
                  // 无 workspaceIdentity 时 store 必须走该 Host 的 mcpSyncService，
                  // 不得回退无桌面代理的 Web platform 空实现。
                  mcpBaseHostDirectoryService={services.mcpSyncService}
                  initialWorkspaceAbsPath={
                    coldLaunchWorkspace?.workspacePath ?? bootstrap.initialWorkspaceAbsPath
                  }
                  initialWorkspaceIdentity={
                    coldLaunchWorkspace
                      ? coldLaunchWorkspace.workspaceIdentity
                      : bootstrap.initialWorkspaceIdentity
                  }
                  initialTaskId={coldLaunchWorkspace?.taskId ?? bootstrap.initialTaskId}
                  initialWebRemoteControlMobileNavigationIntent={
                    coldLaunchWorkspace ? "chat" : undefined
                  }
                  restoreSession={bootstrap.restoreSession}
                  allowOpenWorkspace={bootstrap.allowOpenWorkspace}
                  preferDirectoryBrowser
                  // 修复原因：独立 Web 与桌面共享同一 Host 持久化的 Assistant row，Root 默认关闭
                  // code-comment 投影会暴露原始 directive；与桌面渲染端、手机远控保持一致显式开启。
                  assistantCodeCommentCardsEnabled
                  supportsEmbeddedBrowser={false}
                  allowRemoteWorkspace={false}
                />
              </ZCodeIntlProvider>
            </AppErrorBoundary>
          ) : null}
        </div>
        {showConnectionHint && state !== "connected" ? (
          <div
            role="status"
            data-testid="standalone-connection-status"
            className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-3 border-b border-border bg-background px-4 py-3 text-ui-base text-foreground shadow-sm"
          >
            <span>
              {state === "auth-required"
                ? zh
                  ? "登录验证已过期，请重新验证。当前页面已保留。"
                  : "Authentication required. Your page is preserved."
                : hasLoadedServices
                  ? zh
                    ? "连接已断开，正在重新连接。当前页面已保留。"
                    : "Reconnecting. Your page is preserved."
                  : zh
                    ? "正在连接服务器…"
                    : "Connecting to the server…"}
            </span>
            {state === "auth-required" ? (
              <a className="underline" href={window.location.pathname}>
                {zh ? "重新验证" : "Sign in again"}
              </a>
            ) : null}
            <button
              className="rounded-md border border-border px-3 py-1 hover:bg-hover"
              onClick={() => {
                if (connection) connection.retry();
                else startConnection();
              }}
            >
              {zh ? "重试连接" : "Retry"}
            </button>
          </div>
        ) : null}
      </>,
    );
  };
  const armConnectionHintTimer = () => {
    clearConnectionHintTimer();
    connectionHintTimer = setTimeout(
      () => {
        connectionHintTimer = undefined;
        if (!isPending(state)) return;
        showConnectionHint = true;
        render();
      },
      hasLoadedServices
        ? STANDALONE_RECONNECT_HINT_DELAY_MS
        : STANDALONE_INITIAL_CONNECT_HINT_DELAY_MS,
    );
  };
  const applyState = (next: StandaloneWebConnectionState) => {
    // controller 在 schedule 与每次 attempt 都会重复 publish connecting/reconnecting；
    // 同一次离线期间不能重置宽限计时，也不能收起已经显示的提示。
    const wasPending = isPending(state);
    state = next;
    if (isPending(next)) {
      // 从 connected 或 auth-required 进入新的待连接阶段；已显示的提示（如点击重试）保持不动。
      if (!wasPending && !showConnectionHint) armConnectionHintTimer();
    } else {
      clearConnectionHintTimer();
      showConnectionHint = next === "auth-required";
    }
    render();
  };
  const startConnection = () => {
    connection = createStandaloneWebConnection({
      initialAccessVerified: bootstrap.initialAccessState === "ok",
      connect: (options) =>
        connectViaWebSocket(bootstrap.wsUrl, {
          ...options,
          managedWorktreeService: bootstrap.managedWorktrees === true,
        }),
      async checkAccess(signal) {
        const response = await fetch("/api/server-info", {
          cache: "no-store",
          redirect: "manual",
          credentials: "same-origin",
          signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        });
        if (
          response.type === "opaqueredirect" ||
          response.status === 401 ||
          response.status === 403
        )
          return false;
        if (!response.ok) throw new Error("Server unavailable");
        return response.headers.get("content-type")?.includes("application/json") === true;
      },
      onReady(next) {
        services = next;
        hasLoadedServices = true;
        render();
      },
      onState(next) {
        applyState(next);
      },
      windowTarget: window,
      documentTarget: document,
    });
  };
  // 登录态已确认失效时只显示重新验证入口，由用户点“重试连接”再建连；否则立即建连并开始宽限计时。
  if (!authRequiredAtStart) {
    armConnectionHintTimer();
    startConnection();
  } else {
    render();
  }
  window.addEventListener("pagehide", (event) => {
    // BFCache 恢复（persisted）继续走既有 lifecycle 恢复路径，不做整页刷新；
    // 真实退出时释放连接并清理提示计时器。
    if (!event.persisted) {
      clearConnectionHintTimer();
      connection?.dispose();
    }
  });
}

void bootstrapWebApp();
