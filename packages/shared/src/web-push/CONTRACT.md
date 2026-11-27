# Web 通知与 Web Push 共享契约（`web-push-shared`）

承载独立 Web 页内浏览器通知、Service Worker 与服务端 Web Push 共用的路由常量、订阅请求校验 schema、加密载荷消息结构、确定性去重 `tag` 规则与双语通知文案格式化函数。模块保持零运行时 IO、零平台依赖。

## 不变量

- **统一去重标签（`tag` / `secondaryTag`）**：页内 `showTaskNotification` 与服务端 Web Push 对同一待处理交互使用相同的 `zcode:interaction:<interactionId>`，对会话终态使用 `zcode:task:<taskId>:terminal`；定时任务结算使用 `zcode:automation:<runId>` 并在关联会话时携带 `secondaryTag: zcode:task:<taskId>:terminal`，避免多标签页或后台推送与页内通知重复提醒。
- **遵循 `userVisibleOnly` 约束**：服务端仅向浏览器推送通道发送带可见标题与摘要的 `action: "show"` 消息，不下发静默 `dismiss` 推送包（防止触发 iOS WebKit 吊销订阅或 Chromium 后台静默更新警告）；已解决交互在发送前由服务端内存取消，已展示通知在页面聚焦或交互完成后由本地关闭。
- **文案截断与声音同步**：推送标题与正文沿用桌面端任务通知语义并限制字节预算（确保 RFC 8291 单记录 `< 4096` 字节），同时按设备订阅的 `soundEnabled` 偏好透传 `silent` 标志。
