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

/**
 * 本页防抖窗口：同一事件键（没有事件键时为 tag）在该窗口内只交给 Service Worker 裁决一次。
 * 跨标签、跨通道与 Service Worker 重启后的去重由 Service Worker 的持久事件记录负责。
 */
export const WEB_NOTIFICATION_DEDUPE_WINDOW_MS = 4_000;
/** 页内通知交给 Service Worker 统一裁决时的等待上限，超时回退到本页直接展示。 */
const SERVICE_WORKER_DECISION_TIMEOUT_MS = 300;
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
  /** 同一事实的稳定事件键；有它时 Service Worker 按它与 Web Push 合并并持久去重，否则退回按 tag 的 4 秒窗口。 */
  eventKey?: string;
  /** 通知点击后用来定位会话所属工作区。 */
  workspacePath?: string;
  workspaceIdentity?: string;
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

type ServiceWorkerNotificationDecision =
  | { status: "decided"; shown: boolean; playSound: boolean }
  | { status: "error" }
  | { status: "undelivered" }
  | { status: "timeout" };

function parseSwDecision(data: unknown): ServiceWorkerNotificationDecision {
  if (!data || typeof data !== "object") return { status: "error" };
  const record = data as { shown?: unknown; playSound?: unknown; error?: unknown };
  if (record.error === true) return { status: "error" };
  return { status: "decided", shown: record.shown === true, playSound: record.playSound === true };
}

function clickTargetOf(payload: {
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}): NotificationClickTarget {
  return {
    taskId: payload.taskId,
    ...(payload.workspacePath ? { workspacePath: payload.workspacePath } : {}),
    ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
  };
}

/** 读取并清理通知深链参数，其余查询参数（token、remote 等）原样保留。 */
export function consumeNotificationDeepLink(
  host: Pick<WebNotificationHost, "location" | "history"> = window,
): NotificationClickTarget | null {
  const params = new URLSearchParams(host.location.search);
  const queryKeys = [
    WEB_PUSH_QUERY_TASK_KEY,
    WEB_PUSH_QUERY_WORKSPACE_KEY,
    WEB_PUSH_QUERY_WORKSPACE_IDENTITY_KEY,
  ];
  if (!queryKeys.some((key) => params.has(key))) return null;
  const taskId = params.get(WEB_PUSH_QUERY_TASK_KEY)?.trim();
  const workspacePath = params.get(WEB_PUSH_QUERY_WORKSPACE_KEY)?.trim();
  const workspaceIdentity = params.get(WEB_PUSH_QUERY_WORKSPACE_IDENTITY_KEY)?.trim();
  for (const key of queryKeys) params.delete(key);
  const search = params.toString();
  host.history.replaceState(
    host.history.state,
    "",
    `${host.location.pathname}${search ? `?${search}` : ""}${host.location.hash}`,
  );
  return taskId ? clickTargetOf({ taskId, workspacePath, workspaceIdentity }) : null;
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
  // 本页正在查看的任务与工作区，由 Root 通过平台接口同步；Service Worker 查询时原样回报。
  let activeTaskId: string | null = null;
  let activeWorkspacePath: string | null = null;
  let openWorkspacePaths: string[] = [];
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
    return (
      /iPad|iPhone|iPod/.test(ua) ||
      (host.navigator.platform === "MacIntel" && (host.navigator.maxTouchPoints ?? 0) > 1)
    );
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

  async function setWebPushSubscribed(
    subscribed: boolean,
    setOptions?: { locale?: string; soundEnabled?: boolean },
  ): Promise<WebNotificationStateSnapshot> {
    if (!pushEnabled || !hasPushApi()) return emitState();
    if (subscribed) {
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
        if (readPermission() === "granted") {
          await subscribe(setOptions?.locale, setOptions?.soundEnabled);
        }
      } else {
        const subscription = await readSubscription();
        if (subscription) await dropSubscription(subscription);
      }
    } catch (error) {
      console.warn("[web-push] failed to update subscription", error);
      local.error = toErrorCode(error, subscribed ? "subscribe_failed" : "unsubscribe_failed");
    }
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

  /** 本页处于前台且正显示该任务；没有 taskId 时只看前台状态。 */
  function isViewingTask(taskId: string | undefined): boolean {
    return isPageForeground() && (!taskId || activeTaskId === taskId);
  }

  function syncWindowTabs(paths: string[]): void {
    activeWorkspacePath = paths[0] || null;
    openWorkspacePaths = paths.filter(Boolean);
  }

  function syncActiveTaskSession(sessionId: string | null): void {
    activeTaskId = sessionId;
  }

  function emitNotificationClick(
    taskId: string,
    context?: { workspacePath?: string; workspaceIdentity?: string },
  ): void {
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
    return () => void clickHandlers.delete(handler);
  }

  function isRecentTag(tag: string): boolean {
    const current = now();
    for (const [key, at] of recentTags) {
      if (current - at >= WEB_NOTIFICATION_DEDUPE_WINDOW_MS) recentTags.delete(key);
    }
    return recentTags.has(tag);
  }

  const markTag = (tag: string): void => void recentTags.set(tag, now());

  /** 把页内通知交给 Service Worker 统一裁决（跨标签去重、同任务前台抑制）；区分未投递/报错与已交接超时。 */
  function askServiceWorker(
    worker: ServiceWorker,
    payload: WebNotificationTaskPayload,
    tag: string,
  ): Promise<ServiceWorkerNotificationDecision> {
    if (worker.state === "redundant") return Promise.resolve({ status: "undelivered" });
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (result: ServiceWorkerNotificationDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.close();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ status: "timeout" }),
        SERVICE_WORKER_DECISION_TIMEOUT_MS,
      );
      channel.port1.onmessage = (event: MessageEvent) => finish(parseSwDecision(event.data));
      try {
        worker.postMessage({ type: "zcode:show-task-notification", payload, tag }, [channel.port2]);
      } catch {
        finish({ status: "undelivered" });
      }
    });
  }

  /** 前台正查看该任务而抑制带事件键的页内通知时，同步告知 Service Worker 记为已处理，避免失焦后迟到推送再次响铃。 */
  async function markTaskNotificationHandled(eventKey: string, tag: string): Promise<void> {
    const registration = await findRegistration();
    if (!registration?.active || registration.active.state === "redundant") return;
    try {
      registration.active.postMessage({
        type: "zcode:mark-task-notification-handled",
        eventKey,
        tag,
      });
    } catch {
      // Service Worker 不可达时静默忽略，不影响前台抑制本身。
    }
  }

  /** 本页直接展示：优先 registration.showNotification，其次 new Notification。 */
  async function showTaskNotificationLocally(
    payload: WebNotificationTaskPayload,
    tag: string,
    registration: ServiceWorkerRegistration | undefined,
  ): Promise<boolean> {
    if (registration?.active) {
      try {
        await registration.showNotification(payload.title, {
          body: payload.body,
          tag,
          silent: true,
          icon: NOTIFICATION_ICON_PATH,
          data: clickTargetOf(payload),
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
        const { taskId, ...context } = clickTargetOf(payload);
        emitNotificationClick(taskId, Object.keys(context).length > 0 ? context : undefined);
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * played：已展示且由本页响铃；skipped：别处已展示、前台正在查看或已交接 Service Worker 等待裁决，本页什么都不做；
   * failed：没能展示，调用方释放去重占位。
   */
  async function deliverTaskNotification(
    payload: WebNotificationTaskPayload,
    tag: string,
  ): Promise<"played" | "skipped" | "failed"> {
    const registration = pushEnabled ? await findRegistration() : undefined;
    if (registration?.active) {
      const decision = await askServiceWorker(registration.active, payload, tag);
      if (decision.status === "decided") {
        return decision.shown && decision.playSound ? "played" : "skipped";
      }
      // postMessage 已成功交接给 Service Worker，超时只代表裁决尚未回包，不得再本页重复弹窗。
      if (decision.status === "timeout") return "skipped";
    }
    return (await showTaskNotificationLocally(payload, tag, registration)) ? "played" : "failed";
  }

  function showTaskNotification(payload: WebNotificationTaskPayload): void {
    if (!isEnabled()) return;
    const tag = buildTaskNotificationTag(payload);
    if (isViewingTask(payload.taskId)) {
      if (payload.eventKey && pushEnabled && readPermission() === "granted") {
        void markTaskNotificationHandled(payload.eventKey, tag);
      }
      return;
    }
    if (readPermission() !== "granted") return;
    const dedupeKey = payload.eventKey || tag;
    if (isRecentTag(dedupeKey)) return;
    markTag(dedupeKey);
    void deliverTaskNotification(payload, tag).then((outcome) => {
      if (outcome === "played") void options.playSound?.();
      else if (outcome === "failed") recentTags.delete(dedupeKey);
    });
  }

  function handleServiceWorkerMessage(event: MessageEvent): void {
    const data = event.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== "object") return;
    if (data.type === "zcode:query-client-state") {
      event.ports?.[0]?.postMessage({
        focused: isPageForeground(),
        activeTaskId,
        activeWorkspacePath,
        openWorkspacePaths,
      });
      return;
    }
    if (data.type === "zcode:web-push-shown") {
      const tags = [readString(data.tag), readString(data.secondaryTag)].filter(
        (tag): tag is string => Boolean(tag),
      );
      if (!readString(data.eventKey)) {
        for (const tag of tags) markTag(tag);
      }
      if (tags.length > 0 && isViewingTask(readString(data.taskId))) {
        void closeDisplayedNotifications((notification) => tags.includes(notification.tag));
      }
      return;
    }
    const taskId = readString(data.taskId);
    if (data.type === "zcode:notification-click" && taskId) {
      const workspacePath = readString(data.workspacePath);
      const workspaceIdentity = readString(data.workspaceIdentity);
      emitNotificationClick(taskId, {
        ...(workspacePath ? { workspacePath } : {}),
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
    }
  }

  // 远控页不使用 Service Worker 推送，也就不监听它的消息。
  if (pushEnabled) {
    const container = serviceWorker();
    container?.addEventListener("message", handleServiceWorkerMessage);
    // addEventListener 不会隐式启动消息队列；Android 等浏览器里页面刚被拉起时需要显式开始接收。
    container?.startMessages?.();
  }

  if (pushEnabled && hasPushApi()) {
    // 回到前台说明用户已经在工作台里看到了当前任务的状态，其通知不再需要保留；
    // 其他任务（如后台任务 B）的通知用户还没看过，保留。
    const clearWhenForeground = () => {
      if (!isPageForeground()) return;
      void closeDisplayedNotifications((notification) => {
        const taskId = (notification.data as { taskId?: unknown } | null)?.taskId;
        return typeof taskId !== "string" || taskId === activeTaskId;
      });
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
    syncWindowTabs,
    syncActiveTaskSession,
    onTaskNotificationClick,
    notifyRendererReady: flushPendingClicks,
  };
}
