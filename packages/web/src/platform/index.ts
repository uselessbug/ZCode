import {
  mobilePluginDiscoveryTelemetrySchema,
  resolveLocaleFromLanguageTag,
  toZhOrEnLocale,
  sessionCreateTelemetrySchema,
  type IPlatformService,
  type RemoteTarget,
  type WebRemoteControlStatus,
} from "@zcode/shared";
import {
  isTaskNotificationEnabled,
  isTaskNotificationSoundEnabled,
  playTaskNotificationSound,
} from "@zcode/ui";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "#src/communityUrl.js";
import type { WebRemoteControlPlatformProxy } from "#src/platform/contract.js";
import { saveBrowserFile } from "#src/platform/saveBrowserFile.js";
import {
  createWebNotificationController,
  type NotificationClickTarget,
} from "#src/platform/webNotifications.js";
export type { WebRemoteControlPlatformProxy } from "#src/platform/contract.js";
export { consumeNotificationDeepLink } from "#src/platform/webNotifications.js";
export type { NotificationClickTarget } from "#src/platform/webNotifications.js";

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

export function createWebPlatform(options?: {
  externalWebRemoteControlProxy?: WebRemoteControlPlatformProxy;
  /** 通知深链带来的冷启动目标，Root 注册点击监听后派发。 */
  initialNotificationTarget?: NotificationClickTarget | null;
  /** 独立 Web 把 Agent 回复语言写回当前服务器；手机远控代理页不挂载，设置页保持“请在本机设置”。 */
  setReplyLanguage?: (language: string) => Promise<void>;
}): IPlatformService {
  const platformProxy = options?.externalWebRemoteControlProxy;
  const settingsChangedListeners = new Set<() => void>();
  // 远控页没有独立 Server 的 /api/web-push，只保留页内通知；独立 Web 由 /api/web-push/config 判断是否可用。
  const notifications = createWebNotificationController({
    pushEnabled: !platformProxy,
    playSound: playTaskNotificationSound,
    isEnabled: isTaskNotificationEnabled,
    isSoundEnabled: isTaskNotificationSoundEnabled,
    initialTarget: options?.initialNotificationTarget,
  });

  return {
    canSelectFilePath: false,
    canOpenLocalFiles: false,
    saveFile: saveBrowserFile,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("createTempTextAttachment", payload)
        : Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // Bugfix: Web 远程控制模式虽然复用了 web UI，但它背后其实挂着 desktop。
    // 之前这里仍然走普通 web 的 `/api/connect-remote`，既不能命中 desktop main，
    // 也拿不到 remote session 的 MessagePort，结果看起来像“支持”，实际必然失败。
    // 先显式拒绝，避免用户沿着错误链路继续排查；后续如果要支持，需要单独补 remote session 注入协议。
    async connectRemote(
      options: RemoteTarget,
      _requestId?: string,
      _context?: {
        workspacePath: string;
        workspaceIdentity?: string;
        connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      },
    ) {
      if (platformProxy) {
        return {
          success: false,
          error: `Remote connect is not supported in Web remote control mode yet: ${options.kind}`,
        };
      }

      // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
      // 之前这里虽然能打开 ?remote=<id> 新标签页，但远程 WebSocket 只暴露部分 service，
      // 与 Root/RemoteServiceAccess 需要的完整 accessor 不匹配，最终会在项目向导或首屏卡住。
      return {
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      };
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    // Web 端不作为 Web 远程控制的发起端，保留空实现以兼容统一接口。
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () =>
      Promise.resolve<WebRemoteControlStatus>({
        status: "idle",
      }),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("isDockerAvailable")
        : Promise.resolve(false),
    listWSLDistros: () =>
      platformProxy ? platformProxy.requestPlatformMethod("listWSLDistros") : Promise.resolve([]),
    listDockerContainers: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listDockerContainers")
        : Promise.resolve([]),
    listSSHConfigAliases: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listSSHConfigAliases")
        : Promise.resolve([]),
    loadMcpFromUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("loadMcpFromUserDirectory", payload)
        : Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("saveMcpToUserDirectory", payload)
        : Promise.resolve({
            success: false,
            error: "MCP native directory management requires a desktop attachment",
          }),
    migrateLegacyCommonMcp: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("migrateLegacyCommonMcp", payload)
        : Promise.resolve({
            servers: {},
            totalCount: 0,
            importedCount: 0,
            skippedCount: 0,
          }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      // openCommunity() 不带参数；ZCodeIntlProvider 会把当前界面语言同步到 <html lang>，
      // 这里按界面语言解析，再收敛成中/英（社群链接只配了中英）。以前要求 lang 精确等于 "en-US"，
      // Web+Server 的 index.html 是 lang="en"，英/日/俄/韩都会被当成中文。
      const locale = toZhOrEnLocale(resolveLocaleFromLanguageTag(document.documentElement.lang));
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: notifications.notifyRendererReady,
    reportTelemetryEvent: async (event) => {
      // 手机只开放 session_create 和插件发现事件；管理结果仍由 Desktop Host 唯一上报。
      const parsed = sessionCreateTelemetrySchema
        .or(mobilePluginDiscoveryTelemetrySchema)
        .safeParse(event);
      if (parsed.success) platformProxy?.reportTelemetryEvent?.(parsed.data);
    },
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: notifications.showTaskNotification,
    getWebNotificationState: notifications.getWebNotificationState,
    onWebNotificationStateChanged: notifications.onWebNotificationStateChanged,
    requestWebNotificationPermission: notifications.requestWebNotificationPermission,
    ...(platformProxy ? {} : { setWebPushSubscribed: notifications.setWebPushSubscribed }),
    // 未传回调（或远控代理页）时保持 undefined，设置页据此显示“请在本机设置”。
    // 保存成功后通知 onSettingsChanged 监听者刷新设置页快照，对齐桌面端 applyReplyLanguage 行为。
    ...(!platformProxy && options?.setReplyLanguage
      ? {
          setReplyLanguage: async (language: string) => {
            await options.setReplyLanguage!(language);
            for (const listener of settingsChangedListeners) listener();
          },
          onSettingsChanged: (callback: () => void) => {
            settingsChangedListeners.add(callback);
            return () => {
              settingsChangedListeners.delete(callback);
            };
          },
        }
      : {}),
    // Web 端没有跨窗口 tab 管理；这里只把本页的工作区快照交给通知控制器，用于通知点击路由
    syncWindowTabs: notifications.syncWindowTabs,
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    // 本页正在查看的任务，用于按任务精确判断是否需要打扰
    syncActiveTaskSession: notifications.syncActiveTaskSession,
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: notifications.onTaskNotificationClick,
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    getFileApplications: () => Promise.resolve([]),
    openFileWithApplication: () => Promise.resolve({ success: false, error: "not_supported" }),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}
