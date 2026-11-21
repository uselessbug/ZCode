# Web 平台适配

`createWebPlatform` 是普通 Web 和手机远控共用的 IPlatformService 实现。平台代理仍只路由原有获准操作；文件保存始终发生在当前浏览器，不把远端文件路径传给桌面下载器。

- `saveFile` 接收原始 ArrayBuffer 或 URL 读取结果，最多 50 MiB，允许空文件。
- URL 内容按流读取并检查实际字节数；异常停止读取。只接受 HTTP、HTTPS、data、blob 来源。
- 下载文件名清理路径和非法字符；触发后移除临时链接并回收 Blob URL。
- success 只表示交付给浏览器下载，不能视为用户已确认或文件已落盘。取消下载无法被页面可靠观察。
- 此模块不持有工作区、任务、session 或 stream 状态；现有远控连接、事件和 owner 语义保持不变。

## 浏览器通知与 Web Push

`webNotifications.ts` 实现 `IPlatformService` 的 `getWebNotificationState`、`onWebNotificationStateChanged`、`requestWebNotificationPermission`、`setWebPushSubscribed`，以及页内 `showTaskNotification` 和 `onTaskNotificationClick`。

- 权限状态：无 `Notification` 的 iOS 浏览器标签页（未添加到主屏幕）返回 `ios-install-required`；其他无 API 环境返回 `unsupported`。
- 离线推送是否可用由 `GET /api/web-push/config` 的 `enabled` 决定。快照的 `pushAvailable` 恒等于 `pushEnabled`：独立 Web 工作台为 true，手机远控代理页（带 `externalWebRemoteControlProxy`）为 false。远控页没有独立 Server，只保留页内通知，不借用根作用域 Service Worker，直接用 `new Notification`，也不监听 Service Worker 消息。远控页的平台实例在入口只创建一次。
- 总开关联动：控制器接收 `isEnabled`（任务通知）与 `isSoundEnabled`（通知声音，已叠加总开关）。启动对账时总开关关闭则不向服务端补报，并退订本机与服务端残留订阅；上报 `/api/web-push/subscriptions` 始终携带 `soundEnabled`。设置页关闭总开关会立即退订；声音开关变化时，已订阅设备调用 `setWebPushSubscribed(true, { soundEnabled })` 静默同步，不改变 busy 状态。
- 订阅流程：权限为 `default` 时先在同一调用链申请；授权后注册根作用域 `/zcode-push-sw.js`，订阅并 `POST /api/web-push/subscriptions`。服务端拒绝时回滚本地订阅。退订先通知服务端，服务端失败也继续退本地订阅。
- 错误：快照的 `error` 只使用 `WebNotificationErrorCode`（`permission_denied`、`push_unsupported`、`server_unavailable`、`subscribe_failed`、`unsubscribe_failed`），界面按错误码展示固定文案，原始异常只写 `console.warn`。
- 本页状态：`syncActiveTaskSession(taskId | null)` 记录本页正在查看的任务（设置页、新任务草稿为 `null`）。`syncWindowTabs(paths)` 在 Web 端的约定是：`paths[0]` 是当前激活的工作区（没有激活工作区时为空串），其后是本页所有已打开的工作区。二者只给通知控制器使用，桌面端的 `syncWindowTabs` 语义不变。
- “正在查看某任务”指本页可见、拥有焦点，且 `activeTaskId` 等于该任务。页内通知在本页正在查看该任务时跳过展示与响铃；若携带 `payload.eventKey` 且存在已激活的 Service Worker，会向它发 `zcode:mark-task-notification-handled` 登记该事件已被前台消化，防止失焦后晚到的同事件推送再次响铃。本页聚焦但在看别的任务时，后台任务的通知照常展示。
- 页内通知有激活的 Service Worker 时，页面不再自己展示或响铃，而是经 `MessageChannel` 向它发 `{ type: "zcode:show-task-notification", payload, tag }`（300ms 超时）。仅当消息未投递给 Service Worker（如无激活 worker、`redundant` 或 `postMessage` 抛错）或 Service Worker 明确回复 `{ error: true }` 时才回退本页直接展示（`registration.showNotification()` 不可用时退回 `new Notification()`）；`postMessage` 已交接后的等待超时不再触发本页重复展示。`payload.eventKey` 是同一事实的稳定事件键（`@zcode/shared/web-push` 的 `buildTerminalTurnEventKey(sessionId, 稳定 terminalAt)`、`buildInteractionEventKey`、`buildAutomationRunEventKey`），与 Web Push 载荷的 `eventKey` 一致。Service Worker 回复 `{ shown, playSound }`：同一事件已展示或被前台抑制过（有 `eventKey` 时查持久事件记录，没有时看同一 `tag` 4 秒内存窗口），或另一个前台聚焦的标签页正在查看该任务，则 `shown: false`；否则由 Service Worker 以 `silent: true` 展示（并将 `originClientId` 写入通知 `data`），并只让发起请求的这个标签页播放一次提示音（`playSound: true`）。页面本地只按事件键（没有时按 `tag`）做 4 秒防抖；收到带 `eventKey` 的 `zcode:web-push-shown` 不在本地登记，随后的同事件请求照常交给 Service Worker 以登记发起页。无激活 Service Worker 的环境（如远控页）用本页 `recentTags` 去重后直接展示，只保证单页内不重复。
- 状态查询：Service Worker 需要决策时向每个工作台标签页发 `{ type: "zcode:query-client-state" }` 并附回复端口；页面回复 `{ focused, activeTaskId, activeWorkspacePath, openWorkspacePaths }`。Service Worker 对每个标签页最多等 120ms，超时按“状态未知”处理。
- 前台清理：页面获得焦点或变为可见时，关闭本站遗留的、属于本页当前任务或没有任务归属的 `zcode:` 系统通知，其他任务的通知保留。收到 `zcode:web-push-shown`（携带 `taskId`）时，只有本页正在查看该任务才立即收回对应通知（Apple WebKit 的 Service Worker 无法跳过展示）。点击通知进入会话时，同一 `taskId` 的其余通知一并关闭。
- 通知点击：Service Worker 通过 `zcode:notification-click` 消息或 `?zcodeTask=&zcodeWorkspace=&zcodeWorkspaceIdentity=` 冷启动参数回到会话。入口用 `consumeNotificationDeepLink` 读取并清理这三个参数，目标在 Root 注册点击监听前一直缓存。Service Worker 选目标窗口：事件持久记录、通知 `data` 或近期 `tag` 里登记的发起页（`clients.get(originClientId)` 仍存活且是工作台）优先；否则只复用回报 `activeTaskId` 等于该任务的工作台窗口（多个时优先聚焦、其次可见）；都没有就 `openWindow` 打开深链，不切走停在其他任务或设置页的窗口。没有任务归属的通用通知取聚焦或可见的工作台窗口。对选定目标窗口调用 `focus()`：非 Android 端（如桌面 Firefox 切后台标签时 `focus()` 会异步发 `RequestFocus` 切标签但同步返回旧的 `hidden` 快照）只要 `focus()` 正常 resolve 出有效客户端即视为已接受聚焦，直接向其发送 `zcode:notification-click` 而不另开新窗；Android 端仍要求返回的客户端已聚焦或可见。仅当 `focus()` 失败、返回空值，或 Android 端返回不可见客户端时，才先尝试 `openWindow` 打开深链新窗，仅当 `openWindow` 被拒绝（如 Chromium 交互令牌已被 `focus()` 消耗）或返回 `null` 时才回退向该目标窗口发送 `zcode:notification-click`，避免打开新窗同时在后台误导航隐藏窗口。
- `public/zcode-push-sw.js` 处理推送、通知点击与页面消息。页内请求与 push 串行裁决；带 `eventKey` 的已展示或被前台抑制事件写入 Cache Storage `zcode-notification-events-v1`（最多 256 条、保留 25 小时，记录 `tag`、时间、可信 `message` 事件 `event.source.id` 得到的发起页，以及是否仅为前台抑制 `suppressed`），Service Worker 重启或通知被关闭后仍按事件去重；推送先到、页内同事件后到时只补记发起页（对 `suppressed` 记录不补记），不再提醒。`userVisibleOnly: true` 要求推送有可见通知。非 Apple WebKit 有可见工作台窗口时，可跳过已展示或被前台抑制过的同事件推送，或当前前台正查看的任务通知。其余场景仍展示：同事件推送以原 `tag`、`silent: true`、`renotify: false` 静默替换并继承已有 `originClientId`；新事件 `renotify: true`，同一会话下一轮回合即使旧通知还在通知栏也会提醒。Apple WebKit 没有静默推送，同事件晚到推送一定会以静默替换的形式出现一次，是否完全无声由系统决定。推送载荷无法解析时展示通用通知；没有 `eventKey` 的旧载荷沿用按 `tag` 的 4 秒窗口（页内请求与静默替换同样保留 `originClientId`）。只有同源 `/` 和 `/index.html` 算作工作台。

## 独立 Web 连接恢复

`main.tsx` 的独立 Web 入口只拥有连接与提示状态，页面内容、草稿与导航始终由同一棵 `<Root>` 持有。

- 首屏：`/api/server-info` 用 `redirect: "manual"` 请求，`opaqueredirect`、401、403 记为 `auth-required`，200 且 JSON 记为 `ok`，其余为 `unknown`。`ok` 时首次建连跳过重复的访问检查，握手成功即渲染首页，不再等待额外的探活。首连 3 秒内不渲染任何连接提示，`#root` 保留 `index.html` 的启动动画；超过 3 秒才显示提示与“重试连接”。`auth-required` 立即显示重新验证入口。
- 重连：不再给页面加 `inert`，断线期间用户可继续阅读与输入。工作台已加载后的普通断线不再显示独立 Web 顶部通用重连横幅（打开的会话视图由上游会话订阅面板自行展示重连/反馈提示，其“重新连接”按钮只调用 `lease.store.retry()` 重试会话订阅；设置页或首页等未挂载该面板的视图不新增额外提示，底层 `/ws` 由入口控制器在后台独立自动恢复）。首连或重连遇到 `auth-required` 不延迟，立即显示重新验证横幅；点击其中重试后，同一可见横幅暂态显示“正在连接服务器…”，直至恢复连接或再次返回 `auth-required`。已连上过的重连直接握手（一次往返），握手失败后才检查是不是登录态过期。
- 退避：第一次重连延迟 0ms，再失败依次 1s、2s、4s，之后 8s；成功连上、手动重试或回到前台恢复都会清零。回到前台时若连接仍在，用 2.5 秒超时的探活，失败立即重连。
