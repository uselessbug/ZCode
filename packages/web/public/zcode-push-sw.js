/* ZCode Web Push Service Worker
 *
 * 只负责通知的统一裁决：推送展示、页内通知代展示（跨标签去重）与通知点击路由。不拦截 fetch、不做静态缓存：
 * 服务端静态资源依赖 Cache-Control: no-store，断线重连恢复也需要始终拿到最新页面。
 *
 * 多个工作台标签页各自知道自己正在查看的任务与工作区；需要决策时，Service Worker 通过
 * MessageChannel 向每个标签页发 zcode:query-client-state 取快照，超时的标签页按“未知”处理。
 *
 * 订阅使用 userVisibleOnly: true，每条 push 都必须对应一次可见通知，
 * 否则 iOS WebKit 会吊销订阅，Chrome 会弹出“此网站已在后台更新”。
 */

const ICON_PATH = "/icon-192.png";
const GENERIC_TITLE = "ZCode";
const GENERIC_TAG = "zcode:generic";
const WORKBENCH_PATHNAMES = new Set(["/", "/index.html"]);
const QUERY_TASK_KEY = "zcodeTask";
const QUERY_WORKSPACE_KEY = "zcodeWorkspace";
const QUERY_WORKSPACE_IDENTITY_KEY = "zcodeWorkspaceIdentity";
/** 与页面侧 WEB_NOTIFICATION_DEDUPE_WINDOW_MS 一致：同一个 tag 在该窗口内只提示一次。 */
const DEDUPE_WINDOW_MS = 4_000;
/** 等待单个标签页回报状态的上限，避免挂起的标签页拖住通知。 */
const CLIENT_STATE_QUERY_TIMEOUT_MS = 120;

/** 跨标签共享：推送与页内通知代展示都记入同一张表。 */
const recentTags = new Map();
const pendingPageNotifications = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readString(value) {
  return typeof value === "string" && value ? value : undefined;
}

/** 解析失败或缺字段时回落为通用通知，保证每条 push 都有可见通知。 */
function normalizePushPayload(event) {
  let raw = null;
  try {
    raw = event.data ? event.data.json() : null;
  } catch {
    raw = null;
  }
  const payload = raw && typeof raw === "object" ? raw : {};
  return {
    title: readString(payload.title) || GENERIC_TITLE,
    body: typeof payload.body === "string" ? payload.body : "",
    tag: readString(payload.tag) || GENERIC_TAG,
    secondaryTag: readString(payload.secondaryTag),
    eventId: readString(payload.eventId),
    silent: Boolean(payload.silent),
    taskId: readString(payload.taskId),
    workspacePath: readString(payload.workspacePath),
    workspaceIdentity: readString(payload.workspaceIdentity),
  };
}

function listWindowClients() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

/** 只有根路径的工作台页面算数；/remote/*、/share/*、/cn/share/* 等页面都不是。 */
function isWorkbenchClient(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === self.location.origin && WORKBENCH_PATHNAMES.has(parsed.pathname);
  } catch {
    return false;
  }
}

/** Chromium 与 Firefox 系非 iOS 浏览器；iPhone/iPad 所有浏览器（含 CriOS/FxiOS/EdgiOS）与 macOS Safari 均走 Apple WebKit。 */
function isNonAppleWebKit() {
  const userAgent = self.navigator?.userAgent || "";
  if (/iphone|ipad|ipod/i.test(userAgent)) {
    return false;
  }
  return !/safari/i.test(userAgent) || /chrome|chromium|edg|android/i.test(userAgent);
}

function readStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

/** 去重窗口内是否记录过该 tag；传 source 时只认该来源（"page" 页内代展示 / "push" 推送）。 */
function isRecentTag(tag, source) {
  const current = Date.now();
  for (const [key, entry] of recentTags) {
    if (current - entry.at >= DEDUPE_WINDOW_MS) recentTags.delete(key);
  }
  const entry = recentTags.get(tag);
  return Boolean(entry) && (!source || entry.source === source);
}

function markTags(source, ...tags) {
  const current = Date.now();
  for (const tag of tags) if (tag) recentTags.set(tag, { at: current, source });
}

/** 向单个工作台标签页查询其状态；超时、不支持或出错返回 null。 */
function queryClientState(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (state) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(state);
    };
    const timer = setTimeout(() => finish(null), CLIENT_STATE_QUERY_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      const data = event.data;
      finish(
        data && typeof data === "object"
          ? {
              focused: data.focused === true,
              activeTaskId: readString(data.activeTaskId),
              activeWorkspacePath: readString(data.activeWorkspacePath),
              openWorkspacePaths: readStringList(data.openWorkspacePaths),
            }
          : null,
      );
    };
    try {
      client.postMessage({ type: "zcode:query-client-state" }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

function queryWorkbenchStates(workbenches) {
  return Promise.all(
    workbenches.map(async (client) => ({ client, state: await queryClientState(client) })),
  );
}

/**
 * 是否有前台聚焦的标签页正在查看该任务。有 taskId 时只认标签页自己回报的精确匹配；
 * 没有 taskId 时，回报了状态就看它是否聚焦，没回报则退回浏览器给出的前台信息。
 */
function hasForegroundViewer(entries, taskId) {
  return entries.some(({ client, state }) => {
    if (taskId) return state !== null && state.focused && state.activeTaskId === taskId;
    return state ? state.focused : client.visibilityState === "visible" && client.focused === true;
  });
}

function clickTargetData({ taskId, workspacePath, workspaceIdentity }) {
  return { taskId, workspacePath, workspaceIdentity };
}

async function showPushNotification(payload) {
  const workbenches = (await listWindowClients()).filter((client) => isWorkbenchClient(client.url));
  const hasVisibleWorkbench = workbenches.some((client) => client.visibilityState === "visible");
  // Chromium 仅对有可见同源窗口的站点豁免 userVisibleOnly；Apple WebKit 仍需展示。
  const canSkipDisplay = hasVisibleWorkbench && isNonAppleWebKit();
  if (
    canSkipDisplay &&
    hasForegroundViewer(await queryWorkbenchStates(workbenches), payload.taskId)
  ) {
    return;
  }

  const tags = [payload.tag, payload.secondaryTag].filter(Boolean);
  // 页内请求可能还在查询标签页或展示。等实际结果，避免把未展示成功的占位当作重复推送。
  for (;;) {
    const pending = tags.map((tag) => pendingPageNotifications.get(tag)).filter(Boolean);
    if (pending.length === 0) break;
    await Promise.all(pending);
  }
  const shownPageTag = tags.find((tag) => isRecentTag(tag, "page"));
  if (shownPageTag && canSkipDisplay) return;

  const tag = shownPageTag ?? payload.tag;
  markTags("push", ...tags);
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag,
    icon: ICON_PATH,
    // 已由页内展示时沿用原标签（也可能是定时任务的 secondaryTag），静默替换。
    silent: payload.silent || Boolean(shownPageTag),
    renotify: false,
    data: { ...clickTargetData(payload), tag },
  });

  // 告知工作台标签页：这条通知已由推送展示，页内通知不要再响一次；
  // 页面据 taskId 判断自己是不是正看着该任务，决定要不要立即收回（Apple WebKit 无法跳过展示）。
  for (const client of workbenches) {
    client.postMessage({
      type: "zcode:web-push-shown",
      tag,
      secondaryTag: tag === payload.tag ? payload.secondaryTag : payload.tag,
      eventId: payload.eventId,
      taskId: payload.taskId,
    });
  }
}

/**
 * 页内通知由页面请求 Service Worker 代展示。回复 { shown, playSound }：
 * 同一 tag 在去重窗口内已提示过，或另一个前台标签页正看着该任务时不展示、不响铃；
 * 否则由这里展示（silent），并只让发起请求的这一个标签页响铃。error 表示请求页应回退本地展示。
 */
async function decideTaskNotification(request) {
  const payload = request.payload;
  const tag = readString(request.tag);
  if (
    !tag ||
    !payload ||
    typeof payload !== "object" ||
    !readString(payload.taskId) ||
    typeof payload.title !== "string" ||
    typeof payload.body !== "string"
  ) {
    return { shown: false, playSound: false, error: true };
  }
  if (isRecentTag(tag)) return { shown: false, playSound: false };
  if (pendingPageNotifications.has(tag)) {
    const decision = await pendingPageNotifications.get(tag);
    return { ...decision, shown: false, playSound: false };
  }
  const pending = displayPageNotification(payload, tag);
  pendingPageNotifications.set(tag, pending);
  try {
    return await pending;
  } finally {
    pendingPageNotifications.delete(tag);
  }
}

async function displayPageNotification(payload, tag) {
  try {
    const workbenches = (await listWindowClients()).filter((client) =>
      isWorkbenchClient(client.url),
    );
    if (hasForegroundViewer(await queryWorkbenchStates(workbenches), payload.taskId)) {
      return { shown: false, playSound: false };
    }
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      tag,
      silent: true,
      icon: ICON_PATH,
      data: {
        ...clickTargetData({
          taskId: payload.taskId,
          workspacePath: readString(payload.workspacePath),
          workspaceIdentity: readString(payload.workspaceIdentity),
        }),
        tag,
      },
    });
    markTags("page", tag);
    return { shown: true, playSound: true };
  } catch {
    return { shown: false, playSound: false, error: true };
  }
}

self.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || request.type !== "zcode:show-task-notification") return;
  const port = event.ports && event.ports[0];
  event.waitUntil(
    decideTaskNotification(request).then((decision) => {
      if (port) port.postMessage(decision);
    }),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotification(normalizePushPayload(event)));
});

function buildTargetUrl({ taskId, workspacePath, workspaceIdentity }) {
  const url = new URL("/", self.location.origin);
  if (!taskId) return url.href;
  url.searchParams.set(QUERY_TASK_KEY, taskId);
  if (workspacePath) url.searchParams.set(QUERY_WORKSPACE_KEY, workspacePath);
  if (workspaceIdentity) url.searchParams.set(QUERY_WORKSPACE_IDENTITY_KEY, workspaceIdentity);
  return url.href;
}

/** focus() 成功且页面确实在前台才算拉起；Android 浏览器在后台或其他标签页时可能 resolve 一个仍不可见的 client。 */
function isForegroundClient(client) {
  return Boolean(client) && (client.focused === true || client.visibilityState === "visible");
}

/** 多个候选里优先聚焦的，其次可见的，最后取第一个。 */
function pickPreferredClient(entries) {
  const preferred =
    entries.find(({ client }) => client.focused === true) ||
    entries.find(({ client }) => client.visibilityState === "visible") ||
    entries[0];
  return preferred && preferred.client;
}

/**
 * 点击通知后挑选最合适的工作台标签页：已经打开着该任务的 > 当前停在该工作区的 >
 * 已打开该工作区 tab 的 > 任意聚焦/可见的。这样看着别的任务的标签页不会被冲掉。
 */
async function pickTargetWorkbench(workbenches, { taskId, workspacePath }) {
  if (workbenches.length === 1) return workbenches[0];
  const entries = await queryWorkbenchStates(workbenches);
  const tiers = [
    taskId && ((state) => state.activeTaskId === taskId),
    workspacePath && ((state) => state.activeWorkspacePath === workspacePath),
    workspacePath && ((state) => state.openWorkspacePaths.includes(workspacePath)),
  ];
  for (const matches of tiers) {
    if (!matches) continue;
    const candidates = entries.filter(({ state }) => state !== null && matches(state));
    if (candidates.length > 0) return pickPreferredClient(candidates);
  }
  return pickPreferredClient(entries);
}

async function openOrFocusTarget(data) {
  const { taskId, workspacePath, workspaceIdentity } = data;
  const targetUrl = buildTargetUrl(data);
  const workbenches = (await listWindowClients()).filter((client) => isWorkbenchClient(client.url));
  if (workbenches.length === 0) {
    await self.clients.openWindow(targetUrl);
    return;
  }
  const client = await pickTargetWorkbench(workbenches, data);
  const message = {
    type: "zcode:notification-click",
    taskId,
    workspacePath,
    workspaceIdentity,
  };
  let focusedClient = null;
  try {
    focusedClient = await client.focus();
  } catch {
    // 部分浏览器在无用户手势或后台时拒绝 focus，下面同步保底 postMessage 并尝试打开新窗口。
  }
  if (isForegroundClient(focusedClient)) {
    focusedClient.postMessage(message);
    return;
  }
  // Chromium 在调用 focus() 时会消耗单次窗口交互令牌，后续 openWindow 可能抛 InvalidAccessError；
  // 先向已有窗口发跳转消息保底，再在 Firefox Android 等环境尝试 openWindow 拉起前台。
  client.postMessage(message);
  try {
    await self.clients.openWindow(targetUrl);
  } catch {
    // 窗口交互令牌已被 focus() 消耗时保留上面的 postMessage 导航结果。
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openOrFocusTarget(data));
});
