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
      -> PWA 安装清单与纯推送/点击路由 Service Worker（不拦截 fetch）
  - packages/web/src/platform/webNotifications.ts
      -> 权限状态机、Service Worker 注册与订阅对账、页内通知发送、4s 去重窗口与深链消费
  - packages/ui/src/settingsPageHelpers.tsx & root/useRootPlatformEffects.ts
      -> 设置页「常规」通知权限提示与后台推送开关、点击通知跨工作区会话定位
```

## 页内浏览器通知与后台推送协同

### 1. 职责分工与展示通道

- **页内浏览器通知（`showTaskNotification`）**：当工作台标签页处于后台（`!document.hasFocus()`）且「任务通知」总开关开启时触发。若当前已注册激活的 Service Worker，优先调用 `registration.showNotification()` 以兼容 Android 浏览器；否则回退 `new Notification()`。
- **后台推送（Web Push）**：由服务端 `IWebPushService` 直接向浏览器推送服务端点投递 `aes128gcm` 加密载荷，`zcode-push-sw.js` 在 `push` 事件中调用 `self.registration.showNotification()` 展示系统通知，覆盖浏览器后台、标签页关闭与手机锁屏场景。
- **远控代理页边界**：手机远控代理页（`externalWebRemoteControlProxy`）不挂载独立 Server 的 `/api/web-push/*`，`pushAvailable` 固定为 `false`，设置页隐藏「后台推送」开关，仅保留页内通知。

### 2. 统一 `tag` 与 `secondaryTag` 去重

页内通知与后台推送共用 `packages/shared/src/web-push/index.ts` 的 `tag` 规则：

- 会话终态：`zcode:task:<taskId>:terminal`
- 待处理交互（权限审批 / 提问 / 计划确认）：`zcode:interaction:<interactionId>`
- 定时任务终态：`zcode:automation:<runId>`（同时携带 `secondaryTag = zcode:task:<sessionId>:terminal`）
- 反馈更新：`zcode:feedback:<taskId>`

`zcode-push-sw.js` 展示通知后向所有同源工作台窗口发送 `postMessage({ type: "zcode:web-push-shown", tag, secondaryTag, eventId })`。前端 `webNotifications.ts` 维护 `WEB_NOTIFICATION_DEDUPE_WINDOW_MS = 4000` 的最近标签窗口：收到 `zcode:web-push-shown` 时将 `tag` 与 `secondaryTag` 一并记入去重窗口，4 秒内相同标签的页内通知与提示音直接跳过，避免推送与 WebSocket 页内事件双响。

### 3. 总开关与通知声音联动

- **「任务通知」总开关（`notificationEnabled`）**：在 `permission === "default"` 时开启总开关会在同一点击手势内触发 `requestWebNotificationPermission()`。关闭总开关时，前端立即拒绝页内通知并调用 `setWebPushSubscribed(false)` 退订本设备后台推送；启动静默对账（`reconcileSubscription`）若检测到总开关处于关闭状态，也会自动清理本机与服务端残留订阅。
- **「通知声音」开关（`notificationSoundEnabled`）与语言同步**：设备订阅记录保存 `locale`（`zh-CN` / `en-US`）与 `soundEnabled`。用户在设置页切换「通知声音」或界面语言时，已订阅设备静默调用 `setWebPushSubscribed(true, { locale, soundEnabled })` 更新服务端记录；服务端在 `soundEnabled === false` 时向推送载荷写入 `silent: true`。

### 4. `userVisibleOnly: true` 约束与前台通知清理

- 浏览器标准要求 `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` 的每次推送都必须展示可见通知，否则 iOS WebKit 会吊销订阅，Chromium 会弹出「此网站已在后台更新」警告。因此服务端只发送 `action: "show"` 可见推送，不下发静默撤回包。
- **非 Apple WebKit 浏览器**（桌面与 Android 的 Chromium / Firefox）对已有可见同源窗口的站点豁免 `userVisibleOnly` 检查，`zcode-push-sw.js` 检测到存在 `visibilityState === "visible" && focused === true` 的工作台窗口时直接跳过弹窗。
- **Apple WebKit 环境**（iPhone / iPad 所有浏览器及 macOS Safari）无前台豁免，`zcode-push-sw.js` 始终调用 `showNotification()`；若用户正处于前台页面，`webNotifications.ts` 在收到 `zcode:web-push-shown`、窗口 `focus`/`visibilitychange` 回到前台或点击进入某会话时，调用 `registration.getNotifications()` 自动关闭对应的 `zcode:*` 系统通知。

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
- `packages/web/public/zcode-push-sw.js` 仅监听 `install`、`activate`、`push` 与 `notificationclick`，不注册 `fetch` 处理器，不影响页面静态资源加载与断线重连恢复。

### 2. iOS / iPadOS 16.4+ 添加到主屏幕指引

- iOS / iPadOS 16.4+ 仅在从主屏幕启动的独立 Web App（`display-mode: standalone` 或 `navigator.standalone === true`）中暴露 `Notification` 与 `PushManager`。
- `webNotifications.ts` 通过 User-Agent 与 `MacIntel + maxTouchPoints > 1` 识别 iPhone / iPad 设备：当未处于独立显示模式且无 `Notification` API 时，权限状态返回 `"ios-install-required"`。
- 设置页「常规」分区在「任务通知」下方展示 `settings.notificationPermissionIosInstall` 提示（引导用户通过浏览器「分享 → 添加到主屏幕」并从主屏幕图标打开后再开启通知），同时将「后台推送」开关置为禁用态。

### 3. 点击通知聚焦与跨项目会话定位

- **已有工作台窗口聚焦**：点击系统通知时，`zcode-push-sw.js` 关闭被点击通知，优先从同源窗口客户端中选择已聚焦或可见的 `/` 工作台窗口，调用 `client.focus()` 并发送 `postMessage({ type: "zcode:notification-click", taskId, workspacePath, workspaceIdentity })`。
- **无窗口冷启动深链**：若当前无已打开的工作台窗口，`zcode-push-sw.js` 调用 `clients.openWindow("/?zcodeTask=<taskId>&zcodeWorkspace=<workspacePath>&zcodeWorkspaceIdentity=<workspaceIdentity>")`。页面启动时 `packages/web/src/main.tsx` 先调用 `consumeNotificationDeepLink()` 提取目标会话参数，并通过 `history.replaceState` 清理 `zcodeTask`、`zcodeWorkspace`、`zcodeWorkspaceIdentity` 三个查询参数（原样保留 `token` 等其他参数），再作为 `initialNotificationTarget` 注入 `createWebPlatform`。
- **跨工作区激活与冷启动等待（`useRootPlatformEffects.ts`）**：
  1. 先在全局 `useZCodeSessionStore` 已加载的工作区中查找 `taskId`；若命中则激活对应工作区标签页并选中任务。
  2. 若全局缓存尚未命中但通知携带 `workspacePath`，则先调用 `activateNotificationWorkspace` 激活目标工作区标签页（独立 Web 下若服务端携带的 canonical `workspaceIdentity` 未命中本地 path-only 标签，自动回退按纯 `workspacePath` 激活，若仍无对应标签则在 `hasCompletedFullTabRestore` 完成后调用 `addTab(workspacePath)` 新建本地标签），待该工作区 `taskListCache` 加载完成后调用 `setActiveTaskId` 选中会话并触发 `notifyTaskNavigationCommitted` 清除侧栏未读红点。
  3. 冷启动期间若标签恢复或任务列表尚未就绪，自动订阅 `useZCodeSessionStore` 与 `tabStoreApi`（最长等待 `12_000ms`），就绪后立即完成定位，超时未找到则弹出 `automations.runs.openSessionFailed` 提示。
  4. 点击通知进入目标会话时，`webNotifications.ts` 同步清理该 `taskId` 下所有仍留存在系统通知栏中的 `zcode:*` 通知。

## 本地定向回归命令

在 `/workspace/maintenance/ZCode` 目录下运行（串行执行后端 Web Push 单测套件、前端平台与 Service Worker 单测套件、以及真实 `GeneralSectionContent` / `SettingsSearch` 组件与 PWA 静态产物校验）：

```sh
env -C /workspace/maintenance/ZCode GOMAXPROCS=2 node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-web-push.mjs
```
