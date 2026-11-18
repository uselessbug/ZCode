import {
  WEB_PUSH_API_CONFIG_PATH,
  WEB_PUSH_API_SUBSCRIPTIONS_PATH,
  WEB_PUSH_API_UNSUBSCRIBE_PATH,
  WEB_PUSH_QUERY_TASK_KEY,
  WEB_PUSH_QUERY_WORKSPACE_IDENTITY_KEY,
  WEB_PUSH_QUERY_WORKSPACE_KEY,
  WEB_PUSH_SERVICE_WORKER_PATH,
  buildTaskNotificationTag,
  webPushConfigResponseSchema,
  type WebNotificationErrorCode,
  type WebNotificationPermissionState,
  type WebNotificationStateSnapshot,
  type WebPushSupportedLocale,
} from "@zcode/shared/web-push";

/** 同一个 tag 在该窗口内只提示一次，避免页内通知与 Web Push 重复响。 */
export const WEB_NOTIFICATION_DEDUPE_WINDOW_MS = 4_000;
const NOTIFICATION_ICON_PATH = "/icon-192.png";
const PUSH_LOCALE_STORAGE_KEY = "zcode:web-push:locale";

export interface NotificationClickTarget {
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

type NotificationClickHandler = (
  taskId: string,
  context?: { workspacePath?: string; workspaceIdentity?: string },
) => void;

export interface WebNotificationTaskPayload {
  taskId: string;
  status: Parameters<typeof buildTaskNotificationTag>[0]["status"];
  requestId?: string;
  title: string;
  body: string;
}

/** 浏览器宿主能力；默认取 window，测试注入替身。 */
export interface WebNotificationHost {
  Notification?: typeof Notification;
  navigator: Navigator;
  location: Pick<Location, "search" | "pathname" | "hash">;
  history: Pick<History, "state" | "replaceState">;
  document: Pick<
    Document,
    "hasFocus" | "addEventListener" | "removeEventListener" | "documentElement"
  > &
    Partial<Pick<Document, "visibilityState">>;
  matchMedia?: Window["matchMedia"];
  fetch: typeof fetch;
  focus(): void;
  addEventListener: Window["addEventListener"];
  removeEventListener: Window["removeEventListener"];
  localStorage?: Pick<Storage, "getItem" | "setItem">;
}

export interface WebNotificationControllerOptions {
  /** 是否允许服务端离线推送；Web 远控模式没有独立 Server，传 false 只保留页内通知。 */
  pushEnabled: boolean;
  playSound?: () => void | Promise<void>;
  host?: WebNotificationHost;
  now?: () => number;
  /** 通知跳转的冷启动目标，在点击通道里缓存到 Root 注册监听后再派发。 */
  initialTarget?: NotificationClickTarget | null;
  /** 启动后静默对账已有订阅，默认开启。 */
  reconcileOnStart?: boolean;
  /** “任务通知”总开关；关闭时不展示通知，也不向服务端保留本设备订阅。默认视为开启。 */
  isEnabled?: () => boolean;
  /** “通知声音”开关的最终生效值，随订阅上报给服务端；默认视为开启。 */
  isSoundEnabled?: () => boolean;
}

/** 带共享错误码的失败，界面只展示错误码对应的固定文案，原始异常写入 console.warn。 */
class WebNotificationFailure extends Error {
  constructor(
    readonly code: WebNotificationErrorCode,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

function toErrorCode(error: unknown, fallback: WebNotificationErrorCode): WebNotificationErrorCode {
  if (error instanceof WebNotificationFailure) return error.code;
  if (error instanceof Error && error.name === "NotAllowedError") return "permission_denied";
  return fallback;
}

export function toWebPushLocale(locale: string | undefined): WebPushSupportedLocale | undefined {
  if (!locale) return undefined;
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/** 读取并清理通知深链参数，其余查询参数（token、remote 等）原样保留。 */
export function consumeNotificationDeepLink(
  host: Pick<WebNotificationHost, "location" | "history"> = window,
): NotificationClickTarget | null {
  const params = new URLSearchParams(host.location.search);
  const taskId = params.get(WEB_PUSH_QUERY_TASK_KEY)?.trim();
  const workspacePath = params.get(WEB_PUSH_QUERY_WORKSPACE_KEY)?.trim();
  const workspaceIdentity = params.get(WEB_PUSH_QUERY_WORKSPACE_IDENTITY_KEY)?.trim();
  const queryKeys = [
    WEB_PUSH_QUERY_TASK_KEY,
    WEB_PUSH_QUERY_WORKSPACE_KEY,
    WEB_PUSH_QUERY_WORKSPACE_IDENTITY_KEY,
  ];
  if (!queryKeys.some((key) => params.has(key))) return null;
  for (const key of queryKeys) params.delete(key);
  const search = params.toString();
  host.history.replaceState(
    host.history.state,
    "",
    `${host.location.pathname}${search ? `?${search}` : ""}${host.location.hash}`,
  );
  if (!taskId) return null;
  return {
    taskId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function createWebNotificationController(options: WebNotificationControllerOptions) {
  const host: WebNotificationHost = options.host ?? (window as unknown as WebNotificationHost);
  const now = options.now ?? (() => Date.now());
  const pushEnabled = options.pushEnabled;
  const isEnabled = options.isEnabled ?? (() => true);
  const isSoundEnabled = options.isSoundEnabled ?? (() => true);

  const stateHandlers = new Set<(state: WebNotificationStateSnapshot) => void>();
  const clickHandlers = new Set<NotificationClickHandler>();
  const pendingClicks: NotificationClickTarget[] = options.initialTarget
    ? [options.initialTarget]
    : [];
  const recentTags = new Map<string, number>();
  const local: { busy: boolean; error: WebNotificationErrorCode | null } = {
    busy: false,
    error: null,
  };
  let pushConfig: { enabled: boolean; vapidPublicKey: string | null } | null = null;
  let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
  let unwatchState: (() => void) | null = null;

  const serviceWorker = (): ServiceWorkerContainer | undefined =>
    "serviceWorker" in host.navigator ? host.navigator.serviceWorker : undefined;

  const hasPushApi = (): boolean =>
    Boolean(serviceWorker()) && "PushManager" in (host as unknown as object);

  function isIosBrowser(): boolean {
    const ua = host.navigator.userAgent ?? "";
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ 默认伪装成 Mac Safari，只能靠触控点数区分。
    return host.navigator.platform === "MacIntel" && (host.navigator.maxTouchPoints ?? 0) > 1;
  }

  function isStandaloneDisplay(): boolean {
    return (
      host.matchMedia?.("(display-mode: standalone)").matches === true ||
      (host.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  }

  function readPermission(): WebNotificationPermissionState {
    if (!("Notification" in host) || !host.Notification) {
      return isIosBrowser() && !isStandaloneDisplay() ? "ios-install-required" : "unsupported";
    }
    const permission = host.Notification.permission;
    return permission === "granted" || permission === "denied" ? permission : "default";
  }

  /** 读取服务端推送配置；请求失败抛 server_unavailable，供订阅流程区分“服务端不可用”。 */
  async function fetchPushConfig(): Promise<{ enabled: boolean; vapidPublicKey: string | null }> {
    if (pushConfig) return pushConfig;
    let parsed: ReturnType<typeof webPushConfigResponseSchema.safeParse>;
    try {
      const response = await host.fetch(WEB_PUSH_API_CONFIG_PATH, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      parsed = webPushConfigResponseSchema.safeParse(await response.json());
    } catch (error) {
      throw new WebNotificationFailure("server_unavailable", error);
    }
    if (!parsed.success) throw new WebNotificationFailure("server_unavailable", parsed.error);
    // 只缓存成功结果；网络抖动或登录过期时下次刷新还能重试。
    pushConfig = parsed.data;
    return pushConfig;
  }

  async function loadPushConfig(): Promise<{ enabled: boolean; vapidPublicKey: string | null }> {
    try {
      return await fetchPushConfig();
    } catch {
      return { enabled: false, vapidPublicKey: null };
    }
  }

  function ensureRegistration(): Promise<ServiceWorkerRegistration> {
    const container = serviceWorker();
    if (!container) return Promise.reject(new WebNotificationFailure("push_unsupported"));
    if (!registrationPromise) {
      registrationPromise = container
        .register(WEB_PUSH_SERVICE_WORKER_PATH, { scope: "/" })
        .then(() => container.ready)
        .catch((error: unknown) => {
          registrationPromise = null;
          throw error;
        });
    }
    return registrationPromise;
  }

  async function findRegistration(): Promise<ServiceWorkerRegistration | undefined> {
    try {
      return await serviceWorker()?.getRegistration("/");
    } catch {
      return undefined;
    }
  }

  async function readSubscription(): Promise<PushSubscription | null> {
    if (!hasPushApi()) return null;
    try {
      const registration = await findRegistration();
      return (await registration?.pushManager?.getSubscription()) ?? null;
    } catch {
      return null;
    }
  }

  async function readState(): Promise<WebNotificationStateSnapshot> {
    const permission = readPermission();
    // pushAvailable 只表达当前页面路由是否承载后台推送：远控代理页恒为 false。
    const base = { pushAvailable: pushEnabled, busy: local.busy, error: local.error };
    if (!pushEnabled || !hasPushApi()) {
      return { permission, pushSupported: false, pushSubscribed: false, ...base };
    }
    const pushSupported = (await loadPushConfig()).enabled;
    const pushSubscribed =
      pushSupported && permission === "granted" && (await readSubscription()) !== null;
    return { permission, pushSupported, pushSubscribed, ...base };
  }

  async function emitState(): Promise<WebNotificationStateSnapshot> {
    const state = await readState();
    for (const handler of Array.from(stateHandlers)) handler(state);
    return state;
  }

  function readStoredLocale(): WebPushSupportedLocale | undefined {
    try {
      const value = host.localStorage?.getItem(PUSH_LOCALE_STORAGE_KEY);
      return value === "zh-CN" || value === "en-US" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async function postJson(path: string, body: unknown): Promise<void> {
    const response = await host.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
  }

  function reportSubscription(
    subscription: PushSubscription,
    locale: string | undefined,
    soundEnabled: boolean = isSoundEnabled(),
  ) {
    return postJson(WEB_PUSH_API_SUBSCRIPTIONS_PATH, {
      subscription: subscription.toJSON(),
      locale: toWebPushLocale(locale),
      soundEnabled,
      userAgent: host.navigator.userAgent,
    });
  }

  async function requestPermissionNow(): Promise<NotificationPermission | null> {
    const NotificationCtor = host.Notification;
    if (!NotificationCtor) return null;
    try {
      // 必须在用户手势的同一同步调用链里触发；兼容只支持回调形式的旧浏览器。
      return await new Promise<NotificationPermission>((resolve, reject) => {
        const result = NotificationCtor.requestPermission(resolve);
        if (result && typeof result.then === "function") result.then(resolve, reject);
      });
    } catch {
      return NotificationCtor.permission;
    }
  }

  async function requestWebNotificationPermission(): Promise<WebNotificationStateSnapshot> {
    if (readPermission() === "default") {
      const permission = await requestPermissionNow();
      if (permission === "granted" && pushEnabled && hasPushApi()) {
        // Android Chrome 的页内通知也必须经过 Service Worker，授权后立即就绪。
        await ensureRegistration().catch(() => undefined);
      }
    }
    return emitState();
  }

  async function subscribe(
    locale: string | undefined,
    soundEnabled: boolean | undefined,
  ): Promise<void> {
    const config = await fetchPushConfig();
    if (!config.enabled || !config.vapidPublicKey)
      throw new WebNotificationFailure("push_unsupported");
    const registration = await ensureRegistration().catch((error: unknown) => {
      throw new WebNotificationFailure("subscribe_failed", error);
    });
    const applicationServerKey = urlBase64ToUint8Array(config.vapidPublicKey);
    let subscription: PushSubscription;
    try {
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch (error) {
        // 服务端换过 VAPID 密钥时，旧订阅会让 subscribe 抛 InvalidStateError，退订后重订一次。
        if (!(error instanceof Error) || error.name !== "InvalidStateError") throw error;
        await (await registration.pushManager.getSubscription())?.unsubscribe();
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }
    } catch (error) {
      throw new WebNotificationFailure(toErrorCode(error, "subscribe_failed"), error);
    }
    try {
      await reportSubscription(subscription, locale, soundEnabled);
    } catch (error) {
      // 服务端没记下这个订阅就不能显示为已开启，撤回本地订阅。
      await subscription.unsubscribe().catch(() => undefined);
      throw new WebNotificationFailure("server_unavailable", error);
    }
    const storedLocale = toWebPushLocale(locale);
    if (storedLocale) {
      try {
        host.localStorage?.setItem(PUSH_LOCALE_STORAGE_KEY, storedLocale);
      } catch {
        // 存储不可用时只影响下次启动对账的语言。
      }
    }
  }

  async function dropSubscription(subscription: PushSubscription): Promise<void> {
    try {
      await postJson(WEB_PUSH_API_UNSUBSCRIBE_PATH, { endpoint: subscription.endpoint });
    } catch {
      // 服务端不可达时仍要退掉本机订阅，服务端会在推送失败后自行清理。
    }
    try {
      await subscription.unsubscribe();
    } catch (error) {
      throw new WebNotificationFailure("unsubscribe_failed", error);
    }
  }

  async function unsubscribe(): Promise<void> {
    const subscription = await readSubscription();
    if (subscription) await dropSubscription(subscription);
  }

  async function setWebPushSubscribed(
    subscribed: boolean,
    setOptions?: { locale?: string; soundEnabled?: boolean },
  ): Promise<WebNotificationStateSnapshot> {
    if (!pushEnabled || !hasPushApi()) return emitState();
    if (subscribed) {
      // “任务通知”总开关关闭时不允许建立后台订阅。
      if (!isEnabled()) return emitState();
      // 本设备已订阅时，再次调用只是把最新的语言与声音偏好同步给服务端，不打断界面。
      if (readPermission() === "granted") {
        const existing = await readSubscription();
        if (existing) {
          try {
            await reportSubscription(existing, setOptions?.locale, setOptions?.soundEnabled);
          } catch (error) {
            console.warn("[web-push] failed to sync preferences", error);
          }
          return emitState();
        }
      }
    }
    local.busy = true;
    local.error = null;
    void emitState();
    try {
      if (subscribed) {
        if (readPermission() === "default") await requestPermissionNow();
        if (readPermission() !== "granted") return await finishToggle();
        await subscribe(setOptions?.locale, setOptions?.soundEnabled);
      } else {
        await unsubscribe();
      }
    } catch (error) {
      console.warn("[web-push] failed to update subscription", error);
      local.error = toErrorCode(error, subscribed ? "subscribe_failed" : "unsubscribe_failed");
    }
    return finishToggle();
  }

  function finishToggle(): Promise<WebNotificationStateSnapshot> {
    local.busy = false;
    return emitState();
  }

  async function reconcileSubscription(): Promise<void> {
    if (!pushEnabled || !hasPushApi() || readPermission() !== "granted") return;
    const subscription = await readSubscription();
    if (!subscription) return;
    if (!isEnabled()) {
      // 总开关已关闭：不向服务端补报订阅，并清掉本机与服务端残留的订阅。
      await dropSubscription(subscription);
      void emitState();
      return;
    }
    if (!(await loadPushConfig()).enabled) return;
    await reportSubscription(subscription, readStoredLocale());
  }

  function onWebNotificationStateChanged(
    handler: (state: WebNotificationStateSnapshot) => void,
  ): () => void {
    stateHandlers.add(handler);
    if (!unwatchState) unwatchState = watchBrowserState();
    return () => {
      stateHandlers.delete(handler);
      if (stateHandlers.size === 0) {
        unwatchState?.();
        unwatchState = null;
      }
    };
  }

  function watchBrowserState(): () => void {
    const refresh = () => void emitState();
    host.addEventListener("focus", refresh);
    host.document.addEventListener("visibilitychange", refresh);
    let disposed = false;
    let status: PermissionStatus | null = null;
    void host.navigator.permissions
      ?.query({ name: "notifications" })
      .then((result) => {
        if (disposed) return;
        status = result;
        status.addEventListener("change", refresh);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      host.removeEventListener("focus", refresh);
      host.document.removeEventListener("visibilitychange", refresh);
      status?.removeEventListener("change", refresh);
    };
  }

  /** 关闭本站已展示的系统通知；只处理 ZCode 自己的通知（tag 以 zcode: 开头）。 */
  async function closeDisplayedNotifications(
    shouldClose: (notification: Notification) => boolean,
  ): Promise<void> {
    if (!pushEnabled || !hasPushApi()) return;
    try {
      const registration = await findRegistration();
      const notifications = (await registration?.getNotifications?.()) ?? [];
      for (const notification of notifications) {
        if (notification.tag?.startsWith("zcode:") && shouldClose(notification)) {
          notification.close();
        }
      }
    } catch {
      // 清理只是体验优化，失败不影响主流程。
    }
  }

  function isPageForeground(): boolean {
    return host.document.visibilityState !== "hidden" && host.document.hasFocus();
  }

  function emitNotificationClick(
    taskId: string,
    context?: { workspacePath?: string; workspaceIdentity?: string },
  ): void {
    // 进入会话后，该会话遗留的系统通知（终态、待确认等）都已经处理过，一并清掉。
    void closeDisplayedNotifications(
      (notification) => (notification.data as { taskId?: unknown } | null)?.taskId === taskId,
    );
    if (clickHandlers.size === 0) {
      pendingClicks.push({ taskId, ...context });
      return;
    }
    for (const handler of Array.from(clickHandlers)) handler(taskId, context);
  }

  function flushPendingClicks(): void {
    if (clickHandlers.size === 0) return;
    for (const { taskId, ...context } of pendingClicks.splice(0)) {
      for (const handler of Array.from(clickHandlers)) handler(taskId, context);
    }
  }

  function onTaskNotificationClick(handler: NotificationClickHandler): () => void {
    clickHandlers.add(handler);
    flushPendingClicks();
    return () => {
      clickHandlers.delete(handler);
    };
  }

  /** 返回 true 表示该 tag 刚提示过，调用方应跳过。 */
  function isRecentTag(tag: string): boolean {
    const current = now();
    for (const [key, at] of recentTags) {
      if (current - at >= WEB_NOTIFICATION_DEDUPE_WINDOW_MS) recentTags.delete(key);
    }
    return recentTags.has(tag);
  }

  function markTag(tag: string): void {
    recentTags.set(tag, now());
  }

  async function deliverTaskNotification(
    payload: WebNotificationTaskPayload,
    tag: string,
  ): Promise<boolean> {
    // 远控页没有独立 Server，也不借用根作用域的 Service Worker，直接走 Notification。
    const registration = pushEnabled ? await findRegistration() : undefined;
    if (registration?.active) {
      try {
        await registration.showNotification(payload.title, {
          body: payload.body,
          tag,
          silent: true,
          icon: NOTIFICATION_ICON_PATH,
          data: { taskId: payload.taskId },
        });
        return true;
      } catch {
        // 继续尝试直接构造 Notification。
      }
    }
    const NotificationCtor = host.Notification;
    if (!NotificationCtor) return false;
    try {
      const notification = new NotificationCtor(payload.title, {
        body: payload.body,
        tag,
        silent: true,
      });
      notification.onclick = () => {
        host.focus();
        notification.close();
        emitNotificationClick(payload.taskId);
      };
      return true;
    } catch {
      return false;
    }
  }

  function showTaskNotification(payload: WebNotificationTaskPayload): void {
    if (!isEnabled()) return;
    if (host.document.hasFocus()) return;
    if (readPermission() !== "granted") return;
    const tag = buildTaskNotificationTag(payload);
    if (isRecentTag(tag)) return;
    // 先占位再异步发送，连续两次调用不会各弹一条。
    markTag(tag);
    void deliverTaskNotification(payload, tag).then((shown) => {
      if (shown) void options.playSound?.();
      else recentTags.delete(tag);
    });
  }

  function handleServiceWorkerMessage(event: MessageEvent): void {
    const data = event.data as
      | {
          type?: string;
          tag?: unknown;
          secondaryTag?: unknown;
          taskId?: unknown;
          workspacePath?: unknown;
          workspaceIdentity?: unknown;
        }
      | null
      | undefined;
    if (!data || typeof data !== "object") return;
    if (data.type === "zcode:web-push-shown") {
      // 主标签与次标签（如定时任务与会话终态）都记入去重窗口，避免页内通知再响一次。
      const tags = [data.tag, data.secondaryTag].filter(
        (tag): tag is string => typeof tag === "string" && tag.length > 0,
      );
      for (const tag of tags) markTag(tag);
      // iOS/Safari 下 Service Worker 无法在前台跳过展示；用户正看着页面时随即收回，避免残留。
      if (tags.length > 0 && isPageForeground()) {
        void closeDisplayedNotifications((notification) => tags.includes(notification.tag));
      }
      return;
    }
    if (
      data.type === "zcode:notification-click" &&
      typeof data.taskId === "string" &&
      data.taskId
    ) {
      emitNotificationClick(data.taskId, {
        ...(typeof data.workspacePath === "string" && data.workspacePath
          ? { workspacePath: data.workspacePath }
          : {}),
        ...(typeof data.workspaceIdentity === "string" && data.workspaceIdentity
          ? { workspaceIdentity: data.workspaceIdentity }
          : {}),
      });
    }
  }

  // 远控页不使用 Service Worker 推送，也就不监听它的消息。
  if (pushEnabled) serviceWorker()?.addEventListener("message", handleServiceWorkerMessage);

  if (pushEnabled && hasPushApi()) {
    // 回到前台说明用户已经在工作台里看到了任务状态，旧的系统通知不再需要保留。
    const clearWhenForeground = () => {
      if (isPageForeground()) void closeDisplayedNotifications(() => true);
    };
    host.addEventListener("focus", clearWhenForeground);
    host.document.addEventListener("visibilitychange", clearWhenForeground);
  }

  if (pushEnabled && hasPushApi() && readPermission() === "granted") {
    // 已授权的设备启动时补注册 Service Worker，并静默对账订阅，失败不影响主流程。
    void ensureRegistration()
      .then(() => (options.reconcileOnStart === false ? undefined : reconcileSubscription()))
      .catch(() => undefined);
  }

  return {
    getWebNotificationState: readState,
    onWebNotificationStateChanged,
    requestWebNotificationPermission,
    setWebPushSubscribed,
    showTaskNotification,
    onTaskNotificationClick,
    notifyRendererReady: flushPendingClicks,
  };
}
