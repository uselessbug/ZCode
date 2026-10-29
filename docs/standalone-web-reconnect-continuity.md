> 本规格描述已直接集成到当前源码的独立 Web 行为。下文的基础版本和补丁顺序仅是历史背景；构建使用本仓库当前源码，不再应用外部覆盖补丁。

# 独立 Web 重连连续性（闪烁、提示与焦点）

固定上游 3c5b227649371507ddc4eb46ac5133afe6db1cab。只调整普通 `/ws` 独立 Web 的重连体验；桌面 MessagePort 与 `/remote` relay 的所有权、恢复语义不变。连接生命周期见 [独立 Web 连接恢复](standalone-web-recovery.md)。

## 背景与根因

`connectViaWebSocket` 每次连接都构造新的 `RemoteServiceAccess`，其 `settingService` 实例随之更换。`useSettings` 的默认 `cacheKey` 按 `settingService` 实例身份（`WeakMap`）分键，新实例命中初始 `{ settings: null }` 快照，使 `OccupationOnboarding` 在 `!settings` 时整块卸载 workspace 内容（编辑器与草稿），表现为重连时“闪一下刷新”。

祖先元素设置 `inert` 会 blur 当前编辑器；移除 `inert` 不会自动恢复焦点，重连后用户丢失输入焦点。

## 所有者与事件顺序

```mermaid
sequenceDiagram
    participant UI as 现有组件树和草稿 Store
    participant Owner as 独立 Web 连接控制器
    participant Life as 官方 lifecycle 恢复
    participant RPC as 当前连接 ChannelClient
    RPC->>Owner: close 或心跳读取失败
    Owner->>Owner: 结束旧代际 清空 live
    Owner->>UI: 立即 inert 断线 保存编辑器焦点与选区
    Life->>Owner: hidden/pagehide/freeze 后 visible/pageshow/online 触发 recover
    Owner->>RPC: 经现有认证重新握手并只读探活
    Owner->>UI: onReady 注入 fresh services 加稳定 settingService/broadcast
    UI->>UI: connected 提交并移除 inert 后恢复焦点
    UI->>RPC: 经稳定 settingService 转发读取最新设置
```

## 规则

- 连接控制器只拥有连接代际、心跳和重试，不保存任务事实，不重放任何业务写请求。
- **settingService 稳定转发**：`onReady` 只稳定 `settingService` 与 `broadcastService` 两个成员，其余 services 每次保持 fresh 对象。转发对象身份在同一 controller/root host 内不变，每次调用路由到当前 `live.settingService`；未连接时明确拒绝 `ConnectionClosed`，不排队、不缓存、不重放写请求。官方 `useSettings` 缓存继续按同一 `cacheKey` 唯一拥有设置快照，不在转发对象内保存设置。
- 保留 fresh `RootServices` 对象，使 `Root` 的 `[services]` effect 重新执行 `refreshAppSettings` 读取最新设置（`packages/ui/src/Root.tsx:538-566`）。
- **跨 Host 隔离**：每个独立 Web controller 拥有自己的转发对象，不修改全局 `cacheKey`；远端 workspace 的 `settingService` 继续使用各自身份，不跨 Host 串味。
- **lifecycle 复用**：复用官方 `createWebRemoteControlLifecycleRecovery`，只有真正经历 hidden/pagehide/freeze 暂停后，恢复事件才触发既有 `recover`；`onSuspend` 不主动关闭健康 WebSocket、不清空业务状态、不改 25s/10s/8s 阈值；并发保护仍由既有 `current`/`pulseInFlight` 承担，不新增 single-flight。手动 retry 与真实 close/error 恢复保留。
- **重连提示**：底层 `state`/`inert` 立即如实反映断线；只有曾成功加载过 services 后的 `reconnecting` 提示延迟 1500ms 显示，`connected` 清除计时并隐藏，`auth-required` 与首连 `connecting` 立即显示正确文案。计时器在状态切换与真实 `pagehide` 退出时清理；BFCache（`persisted`）恢复沿用既有路径，不用 `location.reload`。
- **焦点恢复**：断线时（connected → 非 connected）保存 root 内 input/textarea/contenteditable 及其选区；`connected` 提交并移除 `inert` 后，仅当文档可见、有焦点、当前焦点仍为 `body`（用户未点击重试/登录等控件）且元素仍连接时，用 `focus({ preventScroll: true })` 恢复并还原选区，不重置滚动。不扩大为全局焦点框架，不处理 IME/移动端键盘策略。
- **同 Host 会话恢复幂等**：`Root` 的 `restorePersistedSession` 依赖 `services.fileService`，重连后 fresh services 会让该 callback 换引用。对同一 `settingService`（同一 controller/root host 内的稳定转发对象）且 `restoreSession` 未变的首次恢复，一旦真正完整成功，后续仅因 `restorePersistedSession` 或持久化输入引用变化触发的恢复 effect 重跑，不得再从磁盘 `restoreTabs` 覆盖当前 tabs（例如用户已打开的 settings tab）；重跑只按 `persistSession` 同步写回门禁，不重置恢复中/完成态。真实 `settingService` 换实例（Host 变更）或 `restoreSession` 由 false 转 true 仍必须恢复；恢复失败或 deferred inactive 尚未补齐时保持 fail-closed，允许 callback 变化后重试。

## 验收

1. 重连前后 `onReady` 返回的 `settingService` 是同一对象；`get`/`update` 路由到当前连接；断线期间调用明确拒绝 `ConnectionClosed`，不缓存、不重放。
2. 两个独立 Web controller 的 `settingService` 转发对象互不相同，各读各自连接。
3. 隐藏后重新可见的健康连接不重建（连接数不增）；首屏 `pageshow` 不重复建连。
4. 曾加载过 services 后瞬时断线不闪重连横幅；持续断线 1500ms 后显示；`auth-required` 与首连立即显示对应文案。
5. 断线前编辑器焦点与选区在重连后恢复；用户已点击其他控件或元素已卸载时不抢焦点。
6. 真实 client close 后已发送与新 RPC 均被拒绝，无永久 pending。
7. 同一 Host 重连（`settingService` 对象身份不变、其余 services 换新）后，用户已打开的设置页不被切回工作台：settings tab 与其 `activeTabId` 保持不变，磁盘恢复不再重跑，也不额外读取设置。换到另一 Host（新 `settingService`）或 `restoreSession` 关闭转开启时仍恢复；上次恢复失败时重连仍会重试，并在成功后按真实结果打开写回门禁。

## 手动重试与后台焦点恢复补充

- 顶部“重试连接”由 controller 立即取消旧代际、清理计时并发起新的 Access 检查及连接；正在等待旧鉴权或 WebSocket 握手不应使按钮无效。自动 lifecycle 恢复仍只轻量探活，旧代际结果不影响新连接，不重放写入。
- 后台完成重连时，保留尚未消费的焦点快照，待可见且窗口获得焦点后恢复。用户已经选中其他控件或显式点击重试时放弃恢复，元素卸载后也放弃。只响应浏览器 focus/visibilitychange，不轮询，不强制手机键盘弹出。
- 验收：挂起一次 WebSocket 握手后点击重试，应立即建立新代际；后台完成重连再切回页面，应保留原编辑器、草稿并恢复可恢复的焦点/选区；移动浏览器系统键盘仍服从浏览器限制。

## Provider 启动门禁补充

- `useProviderAvailabilityLoginEntryGuard` 是首次 Provider 检查完成态的唯一所有者。检查完成后，重连使 fresh modelSelectionService 暂时 loading 时，不应重新把 Provider 判定当成首次启动，避免将 restoreSession 瞬时从 true 变 false 再变 true，重复覆盖 tabs。
- 首次仍等待既有守卫完成检查或明确错误；登录/OAuth 门禁及显式 restoreSession 开关保留。模型 View 继续由新 service 读取与订阅，不复用旧 Host View，不新增模型缓存或稳定事件代理。
- 验收在已完成首次检查后模拟模型目录 pending→ready，同时更换恢复 callback：设置标签保持活动、未提交筛选和焦点保留；初次未完成的 Provider 检查仍阻塞。
