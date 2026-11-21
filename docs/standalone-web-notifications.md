# 独立 Web 浏览器通知与后台推送（Web Push）

## 背景与上游缺口

上游桌面端通知依赖 Electron 主进程系统通知与窗口焦点管理，而 Web 端（`packages/web`）原先存在以下缺口：

1. **缺少权限请求入口**：仅在 `Notification.permission === "granted"` 时尝试弹窗，未调用 `Notification.requestPermission()`，用户在浏览器默认（`default`）状态下无法开启通知。
2. **点击跳转为空实现**：`onTaskNotificationClick` 为 no-op，点击通知无法聚焦窗口或定位到对应工作区会话。
3. **Android 浏览器不兼容与多标签重复提示**：页面线程直接调用 `new Notification()` 在 Android Chrome/Firefox 上会抛出 `TypeError`（移动端要求经 `ServiceWorkerRegistration.showNotification()` 发送），且多标签页或双通道下缺少统一的 `tag` 去重窗口。
4. **关页与锁屏断连后无后台提醒**：网页关闭、手机锁屏或 WebSocket 挂起后，长耗时任务完成、报错、待审批交互（工具权限、`AskUserQuestion`、`ExitPlanMode`）及定时任务运行结果无法触达用户。

本规格在不引入外部推送中转服务的前提下，为独立 Web 补齐页内浏览器通知与标准 Web Push（RFC 8030 / RFC 8291 / RFC 8292）后台推送。

## 架构与模块边界

```text
packages/shared/src/web-push/
  ├── contract.ts            共享路径常量、权限与错误码类型、请求/载荷 Zod Schema
  └── index.ts               统一通知 tag 构造（task / interaction / automation / feedback）与中英文文案格式化

packages/services/src/web-push/
  ├── contract.ts            IWebPushService 接口与事件输入契约
  ├── crypto.ts              Node 原生 crypto 实现 VAPID（RFC 8292 ES256）密钥管理、
  │                          aes128gcm（RFC 8291）加密与 <=3600B 明文预算裁剪
  ├── subscriptionStore.ts   <appConfigDir>/web-push/subscriptions.json 原子读写（上限 64 条）
  ├── endpointPolicy.ts      HTTPS 域名校验与私网/环回/保留 IP 段拦截策略
  ├── outboundTransport.ts   带自定义 DNS 校验、禁重定向与超时的出站 HTTPS 传输层
  └── webPushService.ts      会话/交互/定时任务推送编排、幂等去重、回合接管去重与 404/410 自动清理

消费与入口：
  - packages/server/src/entry-http.ts & http.ts
      -> 启用 webPushEnabled: true，暴露同源 /api/web-push/* 接口，托管 /zcode-push-sw.js 与 /manifest.webmanifest
  - packages/web/public/{manifest.webmanifest,zcode-push-sw.js}
      -> PWA 安装清单与通知统一裁决 Service Worker（推送展示、页内通知代展示与跨标签去重、点击目标标签页路由，不拦截 fetch）
  - packages/web/src/platform/webNotifications.ts
      -> 权限状态机、Service Worker 注册与订阅对账、本页活动任务与工作区标签同步（syncActiveTaskSession / syncWindowTabs）、页内通知交由 SW 裁决、4s 去重窗口与深链消费
  - packages/ui/src/lib/taskNotificationOrchestrator.ts
      -> 页内终态与待处理交互通知载荷收集（仅 completedSuccess 弹完成、error 弹失败，用户主动停止或发新消息打断产生的 completedInterrupted 保持静默）
  - packages/ui/src/settingsPageHelpers.tsx & root/useRootPlatformEffects.ts & app-shell/{useWorkspaceTaskNavigation.ts,WorkspaceShellLayout.tsx}
      -> 设置页「常规」通知权限提示与后台推送开关、点击通知跨工作区会话定位与窄屏进入 Chat
```

## 页内浏览器通知与后台推送协同

### 1. 职责分工、多标签协同与按任务精确防打扰

- **本页查看状态同步（`syncActiveTaskSession` / `syncWindowTabs`）**：
  - `syncActiveTaskSession(taskId | null)`：记录当前标签页正在查看的会话 ID；当用户处于设置页、新任务草稿页或手机窄屏 `WebRemoteControlMobileShell` 的 `Home` 列表页时上报 `null`，仅在实际进入具体会话 `Chat` 视图时上报该 `taskId`。
  - `syncWindowTabs(paths)`：Web 端约定 `paths[0]` 为当前激活的工作区路径（无激活工作区如设置页时为空字符串 `""`），其后为本标签页所有已打开的工作区路径列表。
- **按任务精确防打扰**：无论页内通知还是后台推送，仅当某个同源工作台标签页（路径为 `/` 或 `/index.html`）处于前台聚焦状态（`visibilityState !== "hidden" && document.hasFocus()`）且正在查看该 `taskId`（`activeTaskId === payload.taskId`）时才抑制通知；若前台标签页正在查看任务 A、停留在设置页或停留在手机 `Home` 列表，后台任务 B 的通知照常弹出。
- **页内浏览器通知与 Service Worker 统一裁决（`showTaskNotification`）**：
  - 当「任务通知」总开关开启且本页正在查看目标 `taskId` 时，跳过本地展示与响铃；若携带 `eventKey` 且存在已激活的 `/zcode-push-sw.js`，同步发送 `zcode:mark-task-notification-handled` 记为已由前台处理，防止失焦后晚到的同事件推送再次响铃。
  - 当「任务通知」总开关开启且本页未在查看目标 `taskId` 时触发。
  - 若当前已激活 `/zcode-push-sw.js`，页面不再自行弹窗或各自播放提示音，而是通过 `MessageChannel` 向 Service Worker 发送 `{ type: "zcode:show-task-notification", payload, tag }`（`300ms` 裁决上限）。仅在消息未投递（无激活 Service Worker、`redundant` 或 `postMessage` 抛错）或 Service Worker 明确回复 `{ error: true }` 时才回退本页 `registration.showNotification()` / `new Notification()`；`postMessage` 成功交接后的等待超时不再触发本页重复展示。
  - Service Worker 按 `tag` / `eventKey` 串行裁决：先通过 `MessageChannel` 并发采集工作台标签页的 `{ focused, activeTaskId, activeWorkspacePath, openWorkspacePaths }`（每个标签页最多等 `120ms`）。若已有事件记录，或 4 秒内存窗口内已提示，或前台聚焦标签页正在查看该任务（带 `eventKey` 时同步标记为已抑制处理），则返回 `{ shown: false, playSound: false }`。展示成功后记录 `"page"` 来源（同时将 `originClientId` 写入通知 `data` 与事件/标签记录），并仅让发起展示的标签页播放自定义提示音。
- **主动停止或发新消息抢占打断静默**：`taskNotificationOrchestrator.ts` 的 `terminalStatusForPhase` 与后端 Web Push 保持一致，仅对 `completedSuccess` 生成完成通知、对 `error` 生成失败通知；用户主动点击停止或运行中发送新消息打断旧回合产生的 `completedInterrupted` 一律保持静默，不弹「任务已完成」。
- **后台推送（Web Push）**：由服务端 `IWebPushService` 直接向浏览器推送服务端点投递 `aes128gcm` 加密载荷，`zcode-push-sw.js` 在 `push` 事件中调用 `self.registration.showNotification()` 展示系统通知，覆盖浏览器后台、标签页关闭与手机锁屏场景。
- **远控代理页边界**：手机远控代理页（`externalWebRemoteControlProxy`）不挂载独立 Server 的 `/api/web-push/*`，`pushAvailable` 固定为 `false`，不借用根作用域 Service Worker，设置页隐藏「后台推送」开关，仅保留页内 `new Notification()` 通知。

### 2. 事件 ID 去重与显示替换 `tag` 分离

- **两类标识职责分离**：
  - **显示替换 `tag`（与 `secondaryTag`）**：用于系统通知栏同一任务/交互槽位的展示归并与替换，页内通知与后台推送共用 `packages/shared/src/web-push/index.ts` 的 `tag` 规则：
    - 会话终态：`zcode:task:<taskId>:terminal`
    - 待处理交互（权限审批 / 提问 / 计划确认）：`zcode:interaction:<interactionId>`
    - 定时任务终态：`zcode:automation:<runId>`（同时携带 `secondaryTag = zcode:task:<sessionId>:terminal`）
    - 反馈更新：`zcode:feedback:<taskId>`
  - **事件键（`eventKey` / `eventId`）与稳定终态标识 `terminalAt`**：标识单次具体通知事件。`SessionSummary` 在协议层携带仅在离开终态再进入下一轮终态时更新的稳定 `terminalAt`（优先取权威错误/回合结束时间，不随后续标题或后台任务刷新 `lastActivityAt` 而漂移）。页内 `taskNotificationOrchestrator`、服务端 `zcodeTaskIndexSyncer` 与定时任务结算共用 `buildTerminalTurnEventKey(sessionId, summary.terminalAt ?? summary.lastActivityAt)`（待处理交互共用 `buildInteractionEventKey(interactionId)`，无会话终态的定时任务失败共用 `buildAutomationRunEventKey(runId)`），确保合并投影与双通道下同一事实拥有完全一致的事件键；同一任务进入新一轮回合则拥有新的事件标识，仍正常通知。
- **Service Worker 串行裁决与有界持久化已处理事件**：
  - `zcode-push-sw.js` 对页内代展示请求、前台抑制登记与 `push` 事件串行化裁决，并将已处理事件记录在有界持久化存储中（容量受控、TTL 至少覆盖推送与重连投递寿命）。
  - 相同事件无论因多标签并发、页内与 Web Push 双通道先后到达、前台查看抑制后失焦晚到、Service Worker 重启，还是离线/锁屏后晚到投递，均按已处理事件去重，避免重复提醒或二次自定义提示音。
  - 推送展示后向同源工作台窗口广播 `postMessage({ type: "zcode:web-push-shown", tag, secondaryTag, eventId, eventKey, taskId })`，无 `eventKey` 的旧载荷同步记入本页去重；带 `eventKey` 的页内请求仍交由 Service Worker 补记非抑制通知的发起页来源且不再响铃。

### 3. 总开关与通知声音联动

- **「任务通知」总开关（`notificationEnabled`）**：在 `permission === "default"` 时开启总开关会在同一点击手势内触发 `requestWebNotificationPermission()`。关闭总开关时，前端立即拒绝页内通知并调用 `setWebPushSubscribed(false)` 退订本设备后台推送；启动静默对账（`reconcileSubscription`）若检测到总开关处于关闭状态，也会自动清理本机与服务端残留订阅。
- **「通知声音」开关（`notificationSoundEnabled`）与语言同步**：设备订阅记录保存 `locale`（`zh-CN` / `en-US`）与 `soundEnabled`。用户在设置页切换「通知声音」或界面语言时，已订阅设备静默调用 `setWebPushSubscribed(true, { locale, soundEnabled })` 更新服务端记录；服务端在 `soundEnabled === false` 时向推送载荷写入 `silent: true`。

### 4. `userVisibleOnly: true` 约束、最小化静音合并与按任务前台清理

- 浏览器标准要求 `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` 的每次推送都必须展示可见通知，否则 iOS WebKit 会吊销订阅，Chromium 会弹出「此网站已在后台更新」警告。因此服务端只发送 `action: "show"` 可见推送，不下发静默撤回包。
- **同事件晚到推送在 `userVisibleOnly` 下的保留/静默合并**：
  - 当后台推送到达但该 `eventId` / `eventKey` 已由页内通知展示或在前台查看时被抑制过（或属于同一事件重复投递）：若当前存在可见同源窗口且浏览器豁免 `userVisibleOnly` 检查，直接跳过弹窗；若必须履行 `userVisibleOnly` 可见通知义务，则以原 `tag` / `secondaryTag` 并设置 `silent: true`、`renotify: false` 静默合并替换同一槽位，合并时保留原通知记录的发起标签页来源信息，且绝不触发第二次自定义提示音。
- **非 Apple WebKit 浏览器**（桌面与 Android 的 Chromium / Firefox）对已有可见同源窗口（`hasVisibleOriginWindow`）的站点豁免 `userVisibleOnly` 检查：
  - 当存在可见的工作台窗口时，若该事件已展示过，或经 `zcode:query-client-state` 确认有前台聚焦标签页正在查看该 `payload.taskId`，`zcode-push-sw.js` 直接跳过弹窗。
  - 当所有工作台窗口均不可见时，Service Worker 仍调用 `showNotification()`。若页内已展示同一事件或同槽位通知，推送复用该标签并设置 `silent: true`、`renotify: false`（保留已有来源页记录），在系统通知栏静默替换原通知。
- **Apple WebKit 环境**（iPhone / iPad 所有浏览器及 macOS Safari）无前台豁免，`zcode-push-sw.js` 始终调用 `showNotification()`。`webNotifications.ts` 仅按任务精确收回通知：
  - 收到 `zcode:web-push-shown` 时，仅当本页处于前台且正在查看该 `taskId`（`isViewingTask(data.taskId)`）时才立即关闭对应 `tag` 的系统通知，不会在查看任务 A 时误关后台任务 B 的推送通知；
  - 窗口通过 `focus` / `visibilitychange` 回到前台时，仅关闭无 `taskId` 或归属当前 `activeTaskId` 的 `zcode:*` 通知，保留其他未查看后台任务的通知。

## 服务端事件范围、持久化与安全边界

### 1. 服务端推送事件覆盖范围

- **会话终态（正常完成 / 失败 / 主动停止静默）**：`zcodeTaskIndexSyncer` 监听 `sessions-index` 的会话 `phase` 终态迁移（仅对基线中已处于非终态的活动会话生效，冷启动 snapshot 初始化不回放历史终态）。`completedSuccess` 触发 `task_completed`；`error` 在回源读取 `snapshot.projection.lastError.message` 后触发 `task_failed`；用户主动停止或打断（`completedInterrupted`）保持静默，不发推送。
- **全局会话待处理交互（`approval` / `question` / `plan`）**：`zcodeTaskIndexSyncer` 与 `zcodeAgentService` 协同覆盖所有工作区会话的待处理交互：
  - 工具权限请求映射为 `approval`，`ExitPlanMode` 映射为 `plan`，`AskUserQuestion` 等用户提问映射为 `question`，并附带工具命令或问题摘要详情。
  - 当交互带有 `autoResolution` 且状态不为 `"snoozed"`（即正在自动处理）时不发送推送；若自动处理后来转为需要人工介入（或变为 `"snoozed"`），则立即补发推送。
  - 若交互在排队等待详情（50ms 窗口）或网络投递前已被用户在任一客户端处理（`permission.resolved`、`userInput.resolved`）或会话已进入终态，服务端调用 `cancelPendingInteractionNotification(interactionId)` 取消尚未发出的推送任务。
- **定时任务终态结算与回合去重**：`automation-runtime` 在派发定时任务回合时调用 `markAutomationOwnedSessionTurn(sessionId, runId)`（2 小时 TTL），若派发中断则调用 `clearAutomationOwnedSessionTurn`。当定时任务回合以 `succeeded`（且未 `interrupted`）或 `failed` 收口时，触发 `automation_completed` 或 `automation_failed` 推送，同时通过 `consumeAutomationOwnedSessionTurn(sessionId)` 消费该回合标记，防止 `zcodeTaskIndexSyncer` 对同一会话回合重复发送普通 `task_completed` / `task_failed` 通知。

### 2. VAPID（RFC 8292）与 `aes128gcm`（RFC 8291）持久化

- **加密与载荷预算**：`packages/services/src/web-push/crypto.ts` 使用 Node 内置 `node:crypto` 生成 P-256（`prime256v1`）VAPID 密钥对并签发 ES256 JWT（有效期 12 小时，默认 `sub` 为 `mailto:noreply@zcode.local`，可通过环境变量 `ZCODE_WEB_PUSH_SUBJECT` 覆盖），按 RFC 8291 使用 ECDH + HKDF-SHA256 + `aes-128-gcm`（记录大小 4096 字节）加密推送载荷。`encodeWebPushMessageWithBudget` 将单条 JSON 明文严格控制在 `<= 3600` 字节内，超长时按二分法依次裁剪 `body`、`title` 并按需移除可选字段，保证密文总长度恒不超过 4096 字节。
- **持久化目录 `<appConfigDir>/web-push/`**（容器环境默认位于 `/home/agent/.zcode/v2/web-push/`，目录权限 `0700`）：
  - `vapid.json`：保存未压缩 P-256 公钥（base64url）与私钥 JWK，文件权限 `0600`，通过进程内锁与跨进程原子文件锁创建，加载时执行签名/验签自检。若服务端更换过 VAPID 密钥，前端在 `subscribe()` 捕获 `InvalidStateError` 后会自动退订旧订阅并用新公钥重新订阅。
  - `subscriptions.json`：按 `endpoint` 幂等保存设备订阅（含 `p256dh`、`auth`、`locale`、`soundEnabled`、`revision` 与时间戳），文件权限 `0600`，最多保留最近更新的 64 条订阅。当推送服务返回 HTTP `404` 或 `410`（订阅已失效）时，按 `expectedRevision` 原子移除失效记录，不误删并发刷新过的新订阅。

### 3. 同源 `/api/web-push/*` 接口与出站防私网边界

- **HTTP 路由与同源校验**：`packages/server/src/http.ts` 提供三个接口，均受 `/api/*` 鉴权中间件（Bearer Token 或 `zcode_lite_token` Cookie）保护：
  - `GET /api/web-push/config`：返回 `{ enabled: boolean, vapidPublicKey: string | null }`。
  - `POST /api/web-push/subscriptions`：校验并持久化设备订阅，要求同源请求（`isSameOriginRequest` 核对 `Origin` 与 `Host` / `X-Forwarded-Proto`，跨源返回 `403`）。
  - `POST /api/web-push/subscriptions/unsubscribe`：按 `endpoint` 移除订阅，同样强制同源校验。
- **出站 DNS / IP 防私网策略（SSRF 防护）**：`endpointPolicy.ts` 与 `outboundTransport.ts` 在订阅入库与实际出站请求两个阶段双重校验 `endpoint`：
  - 生产环境仅允许 `https:` 协议且主机名必须为合法公网域名（禁止携带用户名密码、禁止 IPv4/IPv6 字面量地址、禁止 `localhost` / `.local` / `.internal` / `.localdomain` 及无点主机名）。
  - 出站 HTTPS 请求禁用连接池复用、禁止 `3xx` 重定向（收到重定向直接按校验失败拒绝），并通过自定义 `lookup` 对 DNS 解析出的全部 IPv4 / IPv6 地址执行黑名单拦截，拒绝 `0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.168.0.0/16`、`224.0.0.0/4` 以及 `::1`、`fc00::/7`、`fe80::/10`、IPv4-mapped IPv6（`::ffff:0:0/96`）、NAT64（`64:ff9b::/96`）、6to4（`2002::/16`）、Teredo（`2001::/32`）等内网与保留地址（仅本地测试显式注入 `allowLoopbackEndpoint: true` 时允许环回地址）。

## PWA Manifest、iOS 16.4+ 主屏幕指引与通知点击定位

### 1. PWA Manifest 与反向代理鉴权兼容

- `packages/web/public/manifest.webmanifest` 提供独立应用清单（`display: "standalone"`、`start_url: "/"`、`scope: "/"` 及 192/512/maskable 图标）。
- `packages/web/index.html` 使用 `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />` 声明清单：显式指定 `crossorigin="use-credentials"` 使浏览器在拉取 Manifest 时携带当前域名的鉴权 Cookie（如 `zcode_lite_token` 或 Cloudflare Access 会话 Cookie），避免无凭据请求被网关拦截或 302 重定向。
- `packages/server/src/http.ts` 将 `/manifest.webmanifest`（`application/manifest+json; charset=utf-8`）与 `/zcode-push-sw.js` 列入 `Cache-Control: no-cache` 且禁止 SPA `index.html` fallback。
- `packages/web/public/zcode-push-sw.js` 处理安装、激活、推送、通知点击和页面消息。它不注册 `fetch` 处理器。

### 2. iOS / iPadOS 16.4+ 添加到主屏幕指引

- iOS / iPadOS 16.4+ 仅在从主屏幕启动的独立 Web App（`display-mode: standalone` 或 `navigator.standalone === true`）中暴露 `Notification` 与 `PushManager`。
- `webNotifications.ts` 通过 User-Agent 与 `MacIntel + maxTouchPoints > 1` 识别 iPhone / iPad 设备：当未处于独立显示模式且无 `Notification` API 时，权限状态返回 `"ios-install-required"`。
- 设置页「常规」分区在「任务通知」下方展示 `settings.notificationPermissionIosInstall` 提示（引导用户通过浏览器「分享 → 添加到主屏幕」并从主屏幕图标打开后再开启通知），同时将「后台推送」开关置为禁用态。

### 3. 点击通知聚焦与跨项目会话定位

- **页内通知与后台推送统一携带工作区坐标**：`TaskNotificationPayload`（`packages/shared/src/platform.ts`）与 `useWorkspaceTerminalTaskNotifications`、`usePendingInteractionTaskNotifications`、`V4InteractionDialogs` 均携带 `workspacePath` 与可选 `workspaceIdentity`，使页内通知与后台 Web Push 具有一致的目标工作区上下文。
- **点击路由：发起原页优先、纯 Push 仅复用同任务页，不冲掉其他页面（`zcode-push-sw.js`）**：
  - **有有效发起标签页的页内通知（及合并保留了来源页的通知）**：页内通过 Service Worker 代展示通知时将发起该通知的 `originClientId` 记录在通知 `data` 与事件/标签记录中；若随后后台 Web Push 静默合并替换同一槽位通知（包括推送先到、页内请求后到对非抑制事件的补记，以及无 `eventKey` 的 `tag` 合并），继承并保留该来源 client。用户点击通知时，若该发起标签页仍然存活有效，优先聚焦并路由回该原发起标签页。
  - **纯 Web Push 通知（或原发起标签页已关闭）**：查询当前同源工作台标签页状态（`zcode:query-client-state`），仅当存在**正在展示同一 `taskId`**（`state.activeTaskId === taskId`）的标签页时才复用并聚焦该页；否则直接调用 `clients.openWindow(targetUrl)` 打开目标深链新页面，**不复用**正在查看其他任务或停留在其他页面的已有标签页，避免冲掉用户在其他标签页中的上下文。
  - 选定复用的目标 `client` 后调用 `client.focus()`：非 Android 端（如桌面 Firefox 切后台标签页时 `focus()` 异步向主进程发切标签请求、同步 resolve 出的快照仍为 `hidden`）只要 `focus()` 正常 resolve 出有效客户端即发送 `postMessage({ type: "zcode:notification-click", taskId, workspacePath, workspaceIdentity })` 返回原页，避免重复开新标签；Android 端仍要求返回的客户端处于聚焦或可见态。仅当 `client.focus()` 失败、返回空值，或 Android 端仍不可见时，才优先尝试 `clients.openWindow(targetUrl)` 打开新窗口，仅当 `openWindow` 失败/返回 `null` 时才回退向原目标 `client` 发送导航消息，避免在打开新窗口的同时误导航隐藏旧窗口。前端在 `navigator.serviceWorker` 上显式调用 `startMessages()`，确保页面被拉起时立即消费消息队列。
- **无窗口冷启动深链直达（`packages/web/src/main.tsx`）**：若当前无已打开的工作台窗口，`zcode-push-sw.js` 调用 `clients.openWindow("/?zcodeTask=<taskId>&zcodeWorkspace=<workspacePath>&zcodeWorkspaceIdentity=<workspaceIdentity>")`。页面启动时 `main.tsx` 调用 `consumeNotificationDeepLink()` 提取目标参数并通过 `history.replaceState` 清理 `zcodeTask`、`zcodeWorkspace`、`zcodeWorkspaceIdentity`（原样保留 `token` 等其他查询参数）：
  - 当深链携带 `workspacePath` 时，直接覆盖 `<Root>` 的 `initialWorkspaceAbsPath`、`initialWorkspaceIdentity`、`initialTaskId` 并设置 `initialWebRemoteControlMobileNavigationIntent="chat"`，不再重复放入点击队列，避免冷启动先落入服务器默认 `/workspace` 的新任务草稿页；`useRootPlatformEffects` 在历史标签恢复后通过 `resolveBootstrapWorkspaceIdentity` 复用已恢复的同路径本地 path-only 标签并直接选中目标会话。
  - 仅携带 `taskId`（无 `workspacePath`）的深链才作为 `initialNotificationTarget` 注入 `createWebPlatform`，交由点击队列遍历已打开的工作区定位。
- **跨工作区校验、激活与窄屏切入 `Chat`（`useRootPlatformEffects.ts`、`useWorkspaceTaskNavigation.ts`、`WorkspaceShellLayout.tsx`、`WebRemoteControlMobileShell.tsx`）**：
  1. 等待初始工作区注入（`bootstrapSettledRef`）与历史标签恢复（`hasCompletedFullTabRestore`）完成（总超时预算 `12_000ms`），防止新建标签被随后的 `restoreTabs` 覆盖。
  2. 调用 `locateNotificationTask` 经 `zcodeTaskService.getTaskMeta` 向 Host 索引查询确认任务存在并获取真实工作区归属（不依赖 V4 下恒为 `null` 的旧 `workspaceState.taskListCache`）。独立 Web 本地标签在 canonical `workspaceIdentity` 未命中时自动回退按纯 `workspacePath` 再查一次；若断线重连期间服务暂不可用或 RPC 抛错，按 `400ms` 间隔等待恢复重试，直至命中或超时。
  3. 调用 `activateNotificationWorkspace` 激活或新建目标工作区标签页（独立 Web 在 `workspaceIdentity` 未命中本地 path-only 标签时回退按纯 `workspacePath` 激活或新建本地标签），随后发出 `requestNotificationTaskNavigation({ workspacePath, workspaceIdentity, taskId, revealChat: true })`（含单槽缓冲以兼容壳层尚未挂载的时刻）。
  4. `WorkspaceShellLayout` 通过 `subscribeNotificationTaskNavigation` 消费请求并执行 `handleSelectTaskInChat`（与侧栏点击任务共用同一条路径：同步分屏会话、退出自动化/插件页切回 `chat` 主视图、调用 `handleSelectTask` 选中会话并清除未读状态），同时递增 `revealChatRequestId` 使手机窄屏 `WebRemoteControlMobileShell` 从 `Home` 列表页切入目标会话 `Chat` 页（仅观察请求序号变化，用户随后点返回仍可回到 `Home`）。
  5. 点击通知进入目标会话时，`webNotifications.ts` 同步清理该 `taskId` 下所有仍留存在系统通知栏中的 `zcode:*` 通知；若超时仍未找到目标会话，则弹出 `automations.runs.openSessionFailed` 提示。
- **平台限制**：Firefox Android 若浏览器进程已被系统彻底杀死，GeckoView 存在上游已知问题（Mozilla [Bug 1762032](https://bugzilla.mozilla.org/show_bug.cgi?id=1762032)）会忽略系统通知点击；浏览器处于后台驻留或切换标签页场景通过 `openWindow` 回退拉起。

## 本地定向回归命令

在 `/workspace/maintenance/ZCode` 目录下运行（串行执行后端 Web Push 单测套件 `10/10`、前端平台与 Service Worker 单测套件 `77/77`、以及真实 UI 组件、通知点击导航、终态通知收集与独立 Web 连接恢复回归，共 47 项顶层检查）：

```sh
env -C /workspace/maintenance/ZCode GOMAXPROCS=2 node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-web-push.mjs
```
