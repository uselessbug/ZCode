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
- 页内通知优先走 Service Worker 的 `showNotification`（Android Chrome 不允许 `new Notification`），无可用 Service Worker 时回退 `new Notification`。同一 tag 4 秒内只提示一次；Service Worker 发来 `zcode:web-push-shown` 时把 `tag` 和 `secondaryTag` 都记入该窗口，避免定时任务与会话终态双响。
- 前台清理：页面获得焦点或变为可见时关闭本站遗留的 `zcode:` 系统通知；页面在前台时收到 `zcode:web-push-shown` 会立即收回对应通知（iOS/Safari 的 Service Worker 无法在前台跳过展示）。点击通知进入会话时，同一 `taskId` 的其余通知一并关闭。
- 通知点击：Service Worker 通过 `zcode:notification-click` 消息或 `?zcodeTask=&zcodeWorkspace=&zcodeWorkspaceIdentity=` 冷启动参数回到会话。入口用 `consumeNotificationDeepLink` 读取并清理这三个参数，目标在 Root 注册点击监听前一直缓存。
- `public/zcode-push-sw.js` 只处理 push 与 notificationclick，不拦截 fetch，不缓存静态资源。订阅使用 `userVisibleOnly: true`，因此每条 push 都会展示通知：解析失败或缺字段时展示标题为 `ZCode` 的通用通知，不会静默返回。仅在非 Apple WebKit 且存在可见且聚焦的工作台窗口时跳过展示；iOS/Safari 始终展示。工作台窗口只匹配同源且路径为 `/` 或 `/index.html` 的页面，`/remote/*`、`/share/*` 等不算。多个工作台窗口时优先选聚焦或可见的窗口。
