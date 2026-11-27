/* ZCode Web Push Service Worker
 *
 * 只负责通知的统一裁决：推送展示、页内通知代展示（跨标签去重）与通知点击路由。不拦截 fetch、不做静态缓存：
 * 服务端静态资源依赖 Cache-Control: no-store，断线重连恢复也需要始终拿到最新页面。
 *
 * 多个工作台标签页各自知道自己正在查看的任务与工作区；需要决策时，Service Worker 通过
 * MessageChannel 向每个标签页发 zcode:query-client-state 取快照，超时的标签页按“未知”处理。
 *
 * 同一事实（会话某一回合的终态、某个待处理交互、某次定时任务结算）带共享的 eventKey。
 * 页内代展示请求与 push 事件串行裁决，已展示事件写入有界的持久记录（Cache Storage），
 * 双通道先后到达、多标签并发、Service Worker 重启或晚到投递都合并为一次提醒，并保留发起页来源。
 * 没有 eventKey 的旧载荷沿用按 tag 的 4 秒内存窗口。
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
/** 与页面侧 WEB_NOTIFICATION_DEDUPE_WINDOW_MS 一致：没有 eventKey 的旧载荷按 tag 在该窗口内只提示一次。 */
const DEDUPE_WINDOW_MS = 4_000;
/** 等待单个标签页回报状态的上限，避免挂起的标签页拖住通知。 */
const CLIENT_STATE_QUERY_TIMEOUT_MS = 120;
/** 已展示事件的持久记录：容量与寿命都有上限，寿命覆盖服务端终态推送 TTL（24h）加投递余量。 */
const EVENT_STORE_CACHE = "zcode-notification-events-v1";
const EVENT_STORE_PATH = "/__zcode/notification-events.json";
const EVENT_RECORD_LIMIT = 256;
const EVENT_RECORD_TTL_MS = 25 * 60 * 60 * 1000;

/** 旧载荷（无 eventKey）的跨标签内存去重表：推送与页内代展示共用。 */
const recentTags = new Map();
/** eventKey → 记录；首次使用时从 Cache Storage 载入，之后以内存为准并写回。 */
let eventRecords = null;
/** 页内请求与 push 共用的串行队列，保证“查记录 → 展示 → 写记录”不被并发打断。 */
let decisionQueue = Promise.resolve();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readString(value) {
  return typeof value === "string" && value ? value : undefined;
}

function serial(task) {
  const run = decisionQueue.then(task);
  // 单个任务失败不能卡住后续裁决。
  decisionQueue = run.catch(() => undefined);
  return run;
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
    eventKey: readString(payload.eventKey),
    silent: Boolean(payload.silent),
    taskId: readString(payload.taskId),
    workspacePath: readString(payload.workspacePath),
    workspaceIdentity: readString(payload.workspaceIdentity),
  };
}

function eventStoreUrl() {
  return new URL(EVENT_STORE_PATH, self.location.origin).href;
}

function sanitizeRecord(value) {
  if (!value || typeof value !== "object") return null;
  const key = readString(value.key);
  const tag = readString(value.tag);
  if (!key || !tag || typeof value.at !== "number") return null;
  const originClientId = readString(value.originClientId);
  return {
    key,
    tag,
    at: value.at,
    ...(originClientId ? { originClientId } : {}),
    ...(value.suppressed === true ? { suppressed: true } : {}),
  };
}

async function loadEventRecords() {
  if (eventRecords) return eventRecords;
  const records = new Map();
  try {
    const cache = await self.caches.open(EVENT_STORE_CACHE);
    const response = await cache.match(eventStoreUrl());
    const stored = response ? await response.json() : null;
    const list = stored && Array.isArray(stored.records) ? stored.records : [];
    for (const item of list) {
      const record = sanitizeRecord(item);
      if (record) records.set(record.key, record);
    }
  } catch {
    // Cache Storage 不可用或数据损坏时只退化为本次生命周期内的内存记录。
  }
  // 并发的首次载入以先完成者为准，避免互相覆盖。
  if (!eventRecords) eventRecords = records;
  return eventRecords;
}

function pruneEventRecords(records) {
  const current = Date.now();
  for (const [key, record] of records) {
    if (current - record.at >= EVENT_RECORD_TTL_MS) records.delete(key);
  }
  // Map 按插入顺序迭代，新记录总在末尾，超出容量时从最旧的开始淘汰。
  for (const key of records.keys()) {
    if (records.size <= EVENT_RECORD_LIMIT) break;
    records.delete(key);
  }
}

async function saveEventRecords(records) {
  pruneEventRecords(records);
  try {
    const cache = await self.caches.open(EVENT_STORE_CACHE);
    await cache.put(
      eventStoreUrl(),
      new Response(JSON.stringify({ version: 1, records: Array.from(records.values()) }), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    // 写入失败只影响 Service Worker 重启后的去重。
  }
}

async function readEventRecord(eventKey) {
  const records = await loadEventRecords();
  pruneEventRecords(records);
  return records.get(eventKey);
}

async function writeEventRecord(record) {
  const records = await loadEventRecords();
  records.delete(record.key);
  records.set(record.key, record);
  await saveEventRecords(records);
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

/** 是否为 Android 浏览器；Android 后台或非当前标签页上 focus() 可能 resolve 不可见客户端且不实际切页。 */
function isAndroidBrowser() {
  return /android/i.test(self.navigator?.userAgent || "");
}

function readStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [];
}

/** 去重窗口内是否记录过该 tag；传 source 时只认该来源（"page" 页内代展示 / "push" 推送）。 */
function getRecentTagEntry(tag) {
  const current = Date.now();
  for (const [key, entry] of recentTags) {
    if (current - entry.at >= DEDUPE_WINDOW_MS) recentTags.delete(key);
  }
  return recentTags.get(tag);
}

function isRecentTag(tag, source) {
  const entry = getRecentTagEntry(tag);
  return Boolean(entry) && (!source || entry.source === source);
}

function markTags(source, tags, originClientId) {
  const current = Date.now();
  for (const tag of tags) {
    if (!tag) continue;
    recentTags.set(tag, {
      at: current,
      source,
      ...(originClientId ? { originClientId } : {}),
    });
  }
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

function broadcastPushShown(workbenches, payload, tag) {
  // 告知工作台标签页：这条通知已由推送展示，页内通知不要再响一次；
  // 页面据 taskId 判断自己是不是正看着该任务，决定要不要立即收回（Apple WebKit 无法跳过展示）。
  for (const client of workbenches) {
    client.postMessage({
      type: "zcode:web-push-shown",
      tag,
      secondaryTag: tag === payload.tag ? payload.secondaryTag : payload.tag,
      eventId: payload.eventId,
      eventKey: payload.eventKey,
      taskId: payload.taskId,
    });
  }
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
    if (payload.eventKey) {
      const existing = await readEventRecord(payload.eventKey);
      if (!existing) {
        await writeEventRecord({
          key: payload.eventKey,
          tag: payload.tag,
          at: Date.now(),
          suppressed: true,
        });
      }
    }
    return;
  }
  if (payload.eventKey) {
    await showKeyedPushNotification(payload, workbenches, canSkipDisplay);
    return;
  }

  const tags = [payload.tag, payload.secondaryTag].filter(Boolean);
  const shownPageTag = tags.find((tag) => isRecentTag(tag, "page"));
  if (shownPageTag && canSkipDisplay) return;

  const preservedOriginClientId = tags
    .map((candidate) => getRecentTagEntry(candidate)?.originClientId)
    .find(Boolean);
  const tag = shownPageTag ?? payload.tag;
  markTags("push", tags, preservedOriginClientId);
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag,
    icon: ICON_PATH,
    // 已由页内展示时沿用原标签（也可能是定时任务的 secondaryTag），静默替换。
    silent: payload.silent || Boolean(shownPageTag),
    renotify: false,
    data: {
      ...clickTargetData(payload),
      tag,
      ...(preservedOriginClientId ? { originClientId: preservedOriginClientId } : {}),
    },
  });
  broadcastPushShown(workbenches, payload, tag);
}

/**
 * 带 eventKey 的推送：同一事件已展示或被前台抑制过时，可跳过就跳过，
 * 必须履行 userVisibleOnly 时以原 tag 静默替换，记录里的发起页来源保持不变。
 * 新事件以 renotify 提醒，即使通知栏里还留着同一会话上一轮回合的通知。
 */
async function showKeyedPushNotification(payload, workbenches, canSkipDisplay) {
  const existing = await readEventRecord(payload.eventKey);
  if (existing && canSkipDisplay) return;
  const tag = existing ? existing.tag : payload.tag;
  const silent = payload.silent || Boolean(existing);
  const originClientId = existing?.originClientId;
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag,
    icon: ICON_PATH,
    silent,
    renotify: !silent,
    data: {
      ...clickTargetData(payload),
      tag,
      eventKey: payload.eventKey,
      ...(originClientId ? { originClientId } : {}),
    },
  });
  if (!existing) {
    await writeEventRecord({ key: payload.eventKey, tag, at: Date.now() });
  }
  broadcastPushShown(workbenches, payload, tag);
}

/**
 * 页内通知由页面请求 Service Worker 代展示。回复 { shown, playSound }：
 * 同一事件已提示或被前台抑制过（有 eventKey 时查持久记录，否则看 4 秒内的 tag），或另一个前台标签页正看着该任务时
 * 不展示、不响铃；否则由这里展示（silent），并只让发起请求的这一个标签页响铃。
 * error 表示请求页应回退本地展示。
 */
async function decideTaskNotification(request, originClientId) {
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
  const eventKey = readString(payload.eventKey);
  if (eventKey) {
    const existing = await readEventRecord(eventKey);
    if (existing) {
      // 推送先到或别的标签页已展示：不再提醒，只补记第一个发起页，供点击回到原页。
      // 若原记录是前台查看抑制（suppressed），不把无关后台请求页绑定成发起页。
      if (originClientId && !existing.originClientId && !existing.suppressed) {
        await writeEventRecord({ ...existing, originClientId });
      }
      return { shown: false, playSound: false };
    }
  } else {
    const recent = getRecentTagEntry(tag);
    if (recent) {
      if (originClientId && !recent.originClientId) {
        recentTags.set(tag, { ...recent, originClientId });
      }
      return { shown: false, playSound: false };
    }
  }
  return displayPageNotification(payload, tag, eventKey, originClientId);
}

async function displayPageNotification(payload, tag, eventKey, originClientId) {
  try {
    const workbenches = (await listWindowClients()).filter((client) =>
      isWorkbenchClient(client.url),
    );
    if (hasForegroundViewer(await queryWorkbenchStates(workbenches), payload.taskId)) {
      if (eventKey) {
        const existing = await readEventRecord(eventKey);
        if (!existing) {
          await writeEventRecord({ key: eventKey, tag, at: Date.now(), suppressed: true });
        }
      }
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
        ...(eventKey ? { eventKey } : {}),
        ...(originClientId ? { originClientId } : {}),
      },
    });
    if (eventKey) {
      await writeEventRecord({
        key: eventKey,
        tag,
        at: Date.now(),
        ...(originClientId ? { originClientId } : {}),
      });
    } else {
      markTags("page", [tag], originClientId);
    }
    return { shown: true, playSound: true };
  } catch {
    return { shown: false, playSound: false, error: true };
  }
}

/** 只信任浏览器给出的 event.source：同源工作台窗口的 client id。 */
function trustedSourceClientId(source) {
  if (!source || typeof source.id !== "string" || !source.id) return undefined;
  return isWorkbenchClient(source.url) ? source.id : undefined;
}

self.addEventListener("message", (event) => {
  const request = event.data;
  if (!request || typeof request !== "object") return;
  if (request.type === "zcode:mark-task-notification-handled") {
    if (event.source && !isWorkbenchClient(event.source.url)) return;
    const eventKey = readString(request.eventKey);
    const tag = readString(request.tag);
    if (!eventKey || !tag) return;
    event.waitUntil(
      serial(async () => {
        const existing = await readEventRecord(eventKey);
        if (!existing) {
          await writeEventRecord({ key: eventKey, tag, at: Date.now(), suppressed: true });
        }
      }),
    );
    return;
  }
  if (request.type !== "zcode:show-task-notification") return;
  const port = event.ports && event.ports[0];
  const originClientId = trustedSourceClientId(event.source);
  event.waitUntil(
    serial(() => decideTaskNotification(request, originClientId)).then(
      (decision) => {
        if (port) port.postMessage(decision);
      },
      () => {
        if (port) port.postMessage({ shown: false, playSound: false, error: true });
      },
    ),
  );
});

self.addEventListener("push", (event) => {
  const payload = normalizePushPayload(event);
  event.waitUntil(serial(() => showPushNotification(payload)));
});

function buildTargetUrl({ taskId, workspacePath, workspaceIdentity }) {
  const url = new URL("/", self.location.origin);
  if (!taskId) return url.href;
  url.searchParams.set(QUERY_TASK_KEY, taskId);
  if (workspacePath) url.searchParams.set(QUERY_WORKSPACE_KEY, workspacePath);
  if (workspaceIdentity) url.searchParams.set(QUERY_WORKSPACE_IDENTITY_KEY, workspaceIdentity);
  return url.href;
}

/**
 * 判定 client.focus() 是否已生效：
 * 修复原因（2026-11-21）：桌面端多进程 Firefox 对后台标签调用 client.focus() 时，内容进程经 async RequestFocus
 * 异步通知父进程切标签（Tabbrowser.on_framefocusrequested），但 ClientSource::Focus 在发完 IPC 后立刻同步快照旧文档状态，
 * 返回 focused: false / visibilityState: "hidden"；原逻辑统一按前台态拦截导致误判失败并调 openWindow 多开新页。
 * 修复依据：非 Android 端只要 focus() 正常 resolve 出有效客户端即视为浏览器已接受切页，直接投递导航消息；
 * 仅在 Android 端保留 focused/visible 校验，继续兜底 Android 浏览器 resolve 隐藏客户端却不切页的场景。
 */
function didFocusClient(client) {
  if (!client) return false;
  if (isAndroidBrowser()) {
    return client.focused === true || client.visibilityState === "visible";
  }
  return true;
}

/** 多个候选里优先聚焦的，其次可见的，最后取第一个。 */
function pickPreferredClient(entries) {
  const preferred =
    entries.find(({ client }) => client.focused === true) ||
    entries.find(({ client }) => client.visibilityState === "visible") ||
    entries[0];
  return preferred && preferred.client;
}

/** 记录里的发起页仍然存活且仍是工作台时返回它（依次查事件持久记录、通知 data、近期 tag）。 */
async function findOriginClient(data) {
  if (!data || typeof self.clients.get !== "function") return null;
  try {
    const eventKey = readString(data.eventKey);
    let originClientId;
    if (eventKey) {
      const record = await readEventRecord(eventKey);
      originClientId = record?.originClientId;
    }
    originClientId = originClientId || readString(data.originClientId);
    if (!originClientId && !eventKey) {
      const tag = readString(data.tag);
      if (tag) originClientId = getRecentTagEntry(tag)?.originClientId;
    }
    if (!originClientId) return null;
    const client = await self.clients.get(originClientId);
    return client && isWorkbenchClient(client.url) ? client : null;
  } catch {
    return null;
  }
}

/**
 * 点击通知后挑选目标工作台标签页：发起该通知的原页（仍存活）> 已经打开着该任务的标签页。
 * 都没有时返回 null，由调用方打开深链新页，不切走正在看其他任务或设置的标签页。
 * 没有 taskId 的通用通知只需要拉起工作台，取聚焦/可见的标签页。
 */
async function pickTargetWorkbench(workbenches, data) {
  const { taskId } = data;
  const origin = await findOriginClient(data);
  if (origin) return origin;
  if (workbenches.length === 0) return null;
  const entries = await queryWorkbenchStates(workbenches);
  if (!taskId) return pickPreferredClient(entries);
  const candidates = entries.filter(({ state }) => state !== null && state.activeTaskId === taskId);
  return candidates.length > 0 ? pickPreferredClient(candidates) : null;
}

async function openOrFocusTarget(data) {
  const { taskId, workspacePath, workspaceIdentity } = data;
  const targetUrl = buildTargetUrl(data);
  const workbenches = (await listWindowClients()).filter((client) => isWorkbenchClient(client.url));
  const client = await pickTargetWorkbench(workbenches, data);
  if (!client) {
    await self.clients.openWindow(targetUrl);
    return;
  }
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
    // 部分浏览器在无用户手势或后台时拒绝 focus，下面先尝试打开新窗口，仅在无法打开时才回退发消息给已选客户端。
  }
  if (didFocusClient(focusedClient)) {
    focusedClient.postMessage(message);
    return;
  }
  // focus() 失败、返回空值，或 Android 端仍不可见时先尝试 openWindow 打开新窗口；
  // 只有 openWindow 被拒绝（如 Chromium 已消耗交互令牌）才回退让原目标客户端导航，避免新窗口打开同时误导航隐藏旧窗口。
  try {
    const opened = await self.clients.openWindow(targetUrl);
    if (opened === null) client.postMessage(message);
  } catch {
    client.postMessage(message);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(openOrFocusTarget(data));
});
