/* ZCode Web Push Service Worker
 *
 * 只负责推送展示与通知点击。不拦截 fetch、不做静态缓存：
 * 服务端静态资源依赖 Cache-Control: no-store，断线重连恢复也需要始终拿到最新页面。
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

function pickWorkbenchClient(clients) {
  const workbenches = clients.filter((client) => isWorkbenchClient(client.url));
  return (
    workbenches.find((client) => client.focused === true) ||
    workbenches.find((client) => client.visibilityState === "visible") ||
    workbenches[0]
  );
}

async function showNotification(payload) {
  const workbenches = (await listWindowClients()).filter((client) => isWorkbenchClient(client.url));
  // Chromium 对“有可见窗口的 origin”豁免 userVisibleOnly；Apple WebKit 没有这条豁免，必须始终展示。
  const foregroundWorkbench = workbenches.some(
    (client) => client.visibilityState === "visible" && client.focused === true,
  );
  if (isNonAppleWebKit() && foregroundWorkbench) return;

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: ICON_PATH,
    silent: payload.silent,
    // 同 tag 平滑合并，不重复响铃。
    renotify: false,
    data: {
      taskId: payload.taskId,
      workspacePath: payload.workspacePath,
      workspaceIdentity: payload.workspaceIdentity,
      tag: payload.tag,
    },
  });

  // 告知工作台标签页：这条通知已由推送展示，页内通知不要再响一次。
  for (const client of workbenches) {
    client.postMessage({
      type: "zcode:web-push-shown",
      tag: payload.tag,
      secondaryTag: payload.secondaryTag,
      eventId: payload.eventId,
    });
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(showNotification(normalizePushPayload(event)));
});

function buildTargetUrl({ taskId, workspacePath, workspaceIdentity }) {
  const url = new URL("/", self.location.origin);
  if (!taskId) return url.href;
  url.searchParams.set(QUERY_TASK_KEY, taskId);
  if (workspacePath) url.searchParams.set(QUERY_WORKSPACE_KEY, workspacePath);
  if (workspaceIdentity) url.searchParams.set(QUERY_WORKSPACE_IDENTITY_KEY, workspaceIdentity);
  return url.href;
}

async function openOrFocusTarget(data) {
  const { taskId, workspacePath, workspaceIdentity } = data;
  const client = pickWorkbenchClient(await listWindowClients());
  if (client) {
    try {
      await client.focus();
    } catch {
      // 部分浏览器在无用户手势时拒绝 focus，仍然继续投递跳转消息。
    }
    client.postMessage({
      type: "zcode:notification-click",
      taskId,
      workspacePath,
      workspaceIdentity,
    });
    return;
  }
  await self.clients.openWindow(buildTargetUrl(data));
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openOrFocusTarget(data));
});
