# 独立 Web 与移动端适配问题清单

本文是独立 Web 与移动端适配问题的唯一维护入口，按用户可见症状记录当前状态。

## 待定位（1 项）

- **Android Firefox Nightly 自动切换主题时页面重载并出现重连横幅**：主题跟随已恢复；2026-11-16 用户补充确认，切换时伴随页面重载、Firefox 顶部加载条和 ZCode 重连横幅。源码主题回调只更新类名、CSS `color-scheme` 和 `theme-color`，没有刷新或导航调用；下一步用固定主题、其他网站与 Firefox 稳定版作对照，并采集文档生命周期和 WebSocket 事件，定位 Firefox 重载或页面恢复链路的触发原因。Mozilla [Bug 1807095](https://bugzilla.mozilla.org/show_bug.cgi?id=1807095) 有类似报告，当前设备是否同因未确认。

## 已部署待实机复测（`c4a71467`，4 项）

提交 `c4a71467`（完整 SHA：`c4a7146757dbecb1de27d41f6613e688c961a4b9`）已通过 GitHub Actions [`44301991974`](https://github.com/uselessbug/ZCode/actions/runs/44301991974) `success` 发布镜像 `sha-c4a71467`（digest `sha256:3e97d67ef273260f9d7f9ba8849a9dd826156ba5a8065efd7ad9545af8e5d001`），于 `2026-11-18T12:33:09Z` 完成宿主自更新部署并通过 `2026-11-18T12:32:39.368Z` 容器与运行探针校验，待用户在实体浏览器和手机端完成实机复测：

1. **独立 Web 浏览器通知与后台推送（Web Push）、点击通知会话跳转、多标签协同与主动打断静默**
   - **背景与线上状态**：此前 `71149de2`（完整 SHA：`71149de29744d8b0e5aeb3535e1b78a7b4c673c2`）经 GitHub Actions [`44247679952`](https://github.com/uselessbug/ZCode/actions/runs/44247679952) 部署后，**2026-11-18 用户线上实测确认 PC Firefox 与 Android Firefox 均可正常收到 Web Push 推送（Mozilla Autopush 返回 HTTP 201）**；同时反馈点击通知跳转存在异常（PC 端跳到首页草稿而非对应任务、Android 端未跳转）、多标签页下通知需按任务精确协同，以及用户主动停止或发新消息打断旧回合时不应弹出“任务已完成”通知。上述问题已在 `c4a71467` 修复上线。
   - **本地验证与部署态**：`standalone-web-push.mjs` 的 47 项检查通过（其中服务端套件 10 项、前端平台与 Service Worker 套件 77 项）；`2026-11-18T12:32:39.368Z` 线上容器探针确认 `/zcode-push-sw.js` 哈希与工作区源码一致、`vapid.json` 指纹未变且 `/api/web-push/config` 正常。待实机验证点击跳转、多标签协同及主动打断静默。
     - **点击通知跳转修复**：移除 `useRootPlatformEffects.ts` 对 V4 下恒为 `null` 的 `workspaceState.taskListCache` 的依赖，改调 `zcodeTaskService.getTaskMeta` 定位会话（断线重连期间自动等待重试），统一经 `requestNotificationTaskNavigation` -> `WorkspaceShellLayout.handleSelectTaskInChat` 切换工作区 Tab、退出设置/自动化/插件页、同步分屏并清除未读；`WebRemoteControlMobileShell` 新增 `revealChatRequestId` 让手机窄屏自动从 `Home` 切入 `Chat`；冷启动深链 `?zcodeTask=...&zcodeWorkspace=...` 直接覆盖 `<Root>` 的 `initialWorkspaceAbsPath`、`initialTaskId` 与 `initialWebRemoteControlMobileNavigationIntent="chat"`；`zcode-push-sw.js` 在 `client.focus()` 抛错或返回不可见客户端时先 `postMessage` 保底再调 `clients.openWindow` 回退拉起；页内通知 `TaskNotificationPayload` 补齐 `workspacePath` / `workspaceIdentity`。
     - **多标签页协同（按任务精确防打扰、单次响铃与精准切回标签页）**：Web 端接通 `syncActiveTaskSession`（设置页、新任务草稿与手机 `Home` 列表态上报 `null`，仅进入具体会话 `Chat` 时上报 `taskId`）与 `syncWindowTabs`；页内通知与后台推送统一由 Service Worker 裁决（跨标签共享 4 秒 `recentTags` 去重、仅首个请求标签页播放一次自定义提示音、仅当前台聚焦标签页正在查看该 `taskId` 时抑制通知，前台看任务 A 时不吞任务 B 的通知；所有工作台窗口最小化时对刚由页内展示过的同 `tag` 推送以 `silent: true, renotify: false` 静默合并，遵守 Chromium `userVisibleOnly` 配额且不重复响铃）；点击通知时 SW 通过 `MessageChannel`（`120ms` 超时）瞬时查询各工作台标签页，按「已打开该 `taskId` > 当前停在该项目工作区 > 已打开该项目 Tab > 兜底窗口」优先级精确聚焦目标标签页，不冲掉其他标签页正在看的任务。
     - **主动停止或发新消息抢占打断静默**：`taskNotificationOrchestrator.ts` 将 `completedInterrupted` 从完成通知中排除（与后端 Web Push 一致保持静默，仅 `completedSuccess` 弹完成、`error` 弹失败）。
     - **平台限制**：Firefox Android 若浏览器进程已被系统彻底杀死，GeckoView 存在上游已知问题（Mozilla [Bug 1762032](https://bugzilla.mozilla.org/show_bug.cgi?id=1762032)）会忽略系统通知点击；后台驻留与切换标签场景通过 `openWindow` 回退拉起。设计见[独立 Web 浏览器通知与后台推送](../standalone-web-notifications.md)。

2. **独立 Web 首屏零横幅直出与手机切后台 `0ms` 无感重连**
   - **症状**：独立 Web 首屏加载时在 `resolveWebBootstrap` 请求 `/api/server-info` 后又在建连前重复请求一次 `/api/server-info` 并等待首包 `system.info`，且首屏短暂闪出“正在连接服务器…”横幅；断线重连期间给页面加 `inert` 会锁死滚动、强行 blur 输入框并收起手机软键盘；切后台恢复时首次重连固定等待 `1s` 且 `1500ms` 即弹出重连横幅。
   - **已部署待复测（`c4a71467`，本地 `standalone-web-push.mjs` 连接恢复套件与 `standalone-desktop-parity-ui.mjs` 回归通过）**：
     - `packages/web/src/main.tsx`：`resolveWebBootstrap` 已确认鉴权正常（`initialAccessState === "ok"`）时，首连跳过重复 `/api/server-info` 与首包 `system.info` 探活，直接单次 `/ws` 握手挂载 `<Root>`；首连 `3000ms` 内不渲染连接横幅，`#root` 保留 `index.html` 原生居中 Logo 启动动画，连上后一次渲染直出首页。
     - 移除断线期间锁死全页与收起手机软键盘的 `inert` 属性，并清理 `StandaloneFocusRestore*` 焦点快照恢复代码，断线重连期间页面保持可滚动、输入框可继续打字。
     - 后台恢复采用 `2.5s`（`2500ms`）短超时探活，首次断开与切回前台首轮重连延迟改为 `0ms` 单往返（已连上过不重复请求 `/api/server-info`，仅在握手失败后检查一次访问状态区分 `401/403`；连续失败再按 `1s -> 2s -> 4s -> 8s` 退避），重连横幅显示延迟拉长至 `4500ms`（`401/403` 仍立即提示重新验证）。设计见[连接恢复](../standalone-web-recovery.md)与[重连连续性](../standalone-web-reconnect-continuity.md)。

3. **无项目新建任务失效草稿目录自动换绑恢复（解决首页新建任务 `ENOENT`）**
   - **症状**：浏览器本地缓存的无项目草稿 `draftId` 对应磁盘目录（`/workspace/.zcode/conversations/draft-<id>`）被清理或移走后，从首页或会话区新建无项目任务时 `prepareSession({ draftId, reuseDraft: true })` 因磁盘目录 `ENOENT` 报错失败。
   - **本地验证**：`standalone-multi-root-projects.mjs` 8 组通过，覆盖实际目录重建与草稿保留。`standalone-pending-draft-recovery.mjs` 5 组通过，覆盖两个入口的迟到回包、并发换绑和无项目菜单路径。
     - `packages/services/src/project/index.ts` 在无项目草稿 `reuseDraft: true` 分支遇到磁盘目录 `ENOENT` 时返回稳定业务错误码 `project.draft-workspace-missing`；`composerDraftStore.ts` 新增 `rotateMissingPendingTaskDraft`，`useRootWorkspaceActions.ts` 与 `useConversationWorkspaceActions.ts` 捕获该错误且无在途首发 `commandId` 时自动换绑新 UUID 重新调用 `prepareSession` 创建目录，同时完整保留输入框内已有草稿文字。设计见[任务管理与非项目工作模式](../standalone-web-task-and-project-compat.md)。

4. **独立 Web 项目设备名称统一改为“当前服务器”**
   - **症状**：独立 Web 下设置页插件/技能/MCP 范围已显示“当前服务器”，但项目新建/编辑弹窗、项目管理行、目录信任弹窗与输入框项目选择菜单中的本地设备名称仍显示桌面端的“此电脑”（`project.thisComputer`）。
   - **已部署待复测（`c4a71467`，本地 `standalone-desktop-parity-ui.mjs` 30 项回归通过）**：
     - `ProjectEditor.tsx`、`ProjectManagementRow.tsx`、`ProjectFolderTrustDialog.tsx`、`ProjectComposerMenu.tsx` 四处在服务端承载环境（`useIsServerHostedSettingsScope()` 为 `true`）下将本地设备文案从“此电脑”（`project.thisComputer`）统一改为“当前服务器”（`settings.scope.server`），桌面端保持“此电脑”不变。设计见[设置页服务边界与手机布局](../standalone-web-settings.md)与[任务管理与非项目工作模式](../standalone-web-task-and-project-compat.md)。

## 已部署并完成验收（`5759c882`，2 项）

本轮针对线上暴露的“定时生成会话在侧栏/运行历史点击无法打开及同项目双开 `zcode-cli`”与“闲置工作区/草稿/插件管理进程常驻累积导致 OOM”完成源码修复与本地串行回归验收（`standalone-automation-runtime.mjs` 含真实 `createStandaloneProjectAlias` + `readTree` + `ensureTaskNavigationWorkspace` 三路跳转、删光历史记录继续调度、`draft-*` 共享同 PID、0 目录/普通项目独占 PID、`plugin-management` 空闲超时回收与重拉起）。提交 `5759c882`（完整 SHA：`5759c882095668742fc53d2ab857d6dce34ef216`，包含 `b8b71985`、`5759c882`）已通过 GitHub Actions [`44167318739`](https://github.com/uselessbug/ZCode/actions/runs/44167318739) `success` 发布镜像 `sha-5759c882`（digest `sha256:f9c120bc2a66d3dbe83548a1f05a67208911bc245bee44dd41cb5fbabb04378f`），于 `2026-11-17T20:44:37.133Z` 完成宿主自更新部署与容器探针校验（`ai-agent-zcode-1` 状态 `running` / `healthy` / `restarts: 0`，HTTP 首页 `200`、鉴权 `/api/server-info` `200` 含 `capabilities.managedWorktrees: true`、未授权 `401`、WebSocket 握手 `pass`、`credential-secret` 与 `provider_config.json` 指纹不变、首页双值 `color-scheme` meta 为 `true`、`/opt/browser-mcp` 不存在），并于 2026-11-18 完成线上实测与运行日志验收：

1. **独立 Web 定时任务回归官方 path-only 工作区身份（解决定时生成会话在侧栏/运行历史点击报“目标项目当前未连接”及同项目双开 `zcode-cli` 问题）**
   - **症状**：定时任务运行记录为 `succeeded`，但此前生成的会话携带 canonical `remote:server:oci-ai-agent:*` 身份，从侧栏或运行历史点击时 `ensureTaskNavigationWorkspace` 因无法匹配页面 path-only 标签按 `remote_attachment_missing` 拒绝并提示“目标项目当前未连接，无法打开该会话”，且与普通交互会话因 `workspaceKey` 不同在同项目下双开 `zcode-cli`。
   - **本地修改与线上验收**：已部署并完成验收（`5759c882`）。`standalone-server` 开启 `allowStandaloneCloudWorkspaces` 时，新建项目定时任务、无项目定时任务与独立 Web path-only 会话内 `CronCreate` 保持 `workspaceIdentity: undefined`（`workspaceKey = workspacePath`），以 `hostId = projectStorageHostId` 表达服务器归属；入站非空身份先经纯只读 `workspace_alias` 校验拒绝异域请求（零写副作用）；关联既有 canonical 会话的定义保留本机 canonical 坐标且删除运行历史不影响继续派发；纯远端模式保持 `canonicalWorkspaceKey` 不变。2026-11-18 用户实测“立即运行”正常，改为 1 分钟间隔（`* * * * *`）实测到期自动触发执行返回 `succeeded`（生成会话 `workspace_identity: null`），且与同项目交互对话共用同一顶层 `zcode-cli` 进程。
2. **独立 Web 接通官方 `useSharedTaskRuntime` 非项目/`draft-*` 共享进程池与 `pluginProcessManager` 5 分钟空闲回收（缓解闲置工作区进程常驻累积 OOM）**
   - **症状**：2026-11-17 容器在 8 GiB 内存、512 进程/线程上限下，因多个无项目/`draft-*` 草稿工作区各自独占 `zcode-cli` 进程且 `pluginProcessManager` 常驻不回收，叠加活跃工作区与浏览器运行触发 OOM。
   - **本地修改与线上验收**：已部署并完成验收（`5759c882`）。`allowStandaloneCloudWorkspaces` 开启且无 `workspaceIdentity` 时委托 `hasProjectWorkspace` 让所有无项目目录与 `draft-*` 草稿共用单个 `SHARED_TASK_RUNTIME_KEY` 进程（项目目录与 0 目录项目首次 `prepareSession` 目录仍独占项目进程）；`standalone-server` 为 `pluginProcessManager`（`plugin-management` lane）注入默认 5 分钟 `idleTimeoutMs` 自动回收并支持按需重新拉起（桌面端默认行为不变）。2026-11-18 线上运行日志核实 `plugin-management` 进程在最后一次调用满 5 分钟（`07:37:38.181` → `07:42:38.181`）准时触发 `idle timeout; reclaiming` 自动退出，顶层仅保留当前活跃项目与 `/home/agent/.zcode` 无项目共享池两个进程。

## 已部署并完成验收（`5d682dfd`，桌面行为对齐 8 项）

在用户确认 `.docx` 与 `.pdf` 附件上传正常的基础上，提交 `5d682dfd`（完整 SHA：`5d682dfd473c915dad98a3c16688f822237764f8`，包含 `52c43e5a`、`520e37e9`、`9d3ef7b2`、`5d682dfd`）通过 GitHub Actions [`43917276559`](https://github.com/uselessbug/ZCode/actions/runs/43917276559) `success` 发布镜像 `sha-5d682dfd`（digest `sha256:ce7a0475f08bff71703f0ce1be81bb7f22e315ba1130a51f58651eade2838075`），于 `2026-11-16T17:49:21.595Z` 完成宿主自更新部署与容器探针校验，并于 2026-11-17 完成线上验收：

1. **附件原文件名落盘与桌面 `readTextFileForModel` 预读统一**
   - **本地修改与线上验收**：上传普通文件与长粘贴在会话附件目录内改为 `<artifactId>/<安全化原文件名>` 子目录原子落盘（保留中文、空格等原文件名，使模型路径与 `::zcode-file-citation` 芯片显示真实原名，兼容新旧读取/统计与顶层条目保留匹配）；普通上传文本删除自建 64 KiB 硬切分，统一复用桌面 `resolveLocalFileAttachment` / `readTextFileForModel`（256 KiB + 25k token 预读、`.json` 等统一带 `source` 附件提醒，保留双 `zcode-artifact://` URI）。本地 `standalone-cli-attachment-materialization.mjs` 与 CLI 单测通过；用户确认 PDF 与 DOCX 上传正常，2026-11-17 线上验证中文/空格原名保留、100,038 字节文本逐字节完整、ZIP 落盘内容读取及 20 MiB 超限提示通过。
2. **项目数据双记忆命名空间覆盖**
   - **本地修改与线上验收**：`project-data` 同时估算与清理独立 Web 本地路径哈希记忆目录（`<slug>-<hash>/memory`）与 canonical 身份哈希记忆目录（`project-<hash>/memory`），避免本地路径会话记忆漏估漏删。本地 `standalone-project-alias.mjs` 回归通过；2026-11-17 线上验证设置页移除项目弹窗显示数据估算（193 KB），勾选清理并输入 `delete` 后彻底删除成功，服务日志 `measureProjectData`、`deleteProjectData` 均 `OK`。
3. **独立 Web 开启代码批注卡片（`::code-comment`）**
   - **本地修改与线上验收**：`packages/web/src/main.tsx` `<Root>` 补传 `assistantCodeCommentCardsEnabled`，使独立 Web 与桌面、手机远控一致渲染结构化代码审查卡片。2026-11-17 线上验证代码批注卡片展开及点击跳转至文件第 1 行通过。
4. **定时任务已冻结目录快照放行**
   - **本地修改与线上验收**：进程内私有 `Symbol` 可信标记放行已持久化的定时任务目录快照，项目编辑或清空 `roots` 后仍按创建时冻结的目录快照创建会话。本地 `standalone-automation-runtime.mjs` 回归通过；2026-11-17 线上验证清空项目 `roots` 后按冻结目录立即运行状态为 `succeeded`（定时生成会话的工作区身份与侧栏打开问题已在 `5759c882` 修复并部署，见上方“已部署并完成验收（`5759c882`）”第 1 项）。
5. **Browser Use 普通释放保留上下文与归档/删除生命周期清理**
   - **本地修改与线上验收**：普通 `closeSession` 仅释放租约并将 `BrowserContext`/页面/Cookie 保存在有界空闲池供后续恢复；归档、自动归档、删除、永久删除及项目数据清理（含已删 `owned` 子会话）统一经 per-`sessionKey` 串行队列触发 `closeTaskSessions` 彻底销毁上下文。2026-11-17 线上复跑真实 Chromium `verify-standalone-browser-use.mjs` 18/18 通过（含上下文/Cookie 保留、归档/删除/清理回收与并发保护）。
6. **0 目录新建与清空目录对齐桌面生命周期**
   - **本地修改与线上验收**：支持保存与编辑清空为 `0` 个目录、恢复干净默认项目名，首次 `prepareSession` 懒创建 `/workspace/.zcode/workspace/<projectId>`；无项目草稿目录保持 `/workspace/.zcode/conversations/draft-<id>`，新建/编辑项目目录浏览默认起点保持 `/workspace`。本地 `standalone-multi-root-projects.mjs` 回归通过；2026-11-17 线上验证 0 目录项目创建、清空目录保存、刷新及首次发消息通过。
7. **当前服务器本地 Git 受管 Worktree 全链路打通**
   - **本地修改与线上验收**：服务端、`/api/server-info`（`capabilities.managedWorktrees`）与前端入口协同放行，受管 Worktree 落盘在 `/workspace/.zcode/worktrees`，补齐真实 `worktreeRemovalGate` `readTaskCwd`、Browser Use 归属归一及归档 Worktree 任务永久删除路径对齐。本地 `standalone-managed-worktree.mjs` 真实 Git 验收通过，线上 `/api/server-info` 返回 `capabilities.managedWorktrees: true`，2026-11-17 线上验证 Worktrees 管理弹窗列出并删除临时副本、磁盘目录同步移除通过。
8. **任务菜单「显示文件树」与隐藏无效配置入口**
   - **症状**：原「待页面复现」项——任务菜单「在文件管理器中打开／前往 Provider 配置」在独立 Web 下点击无反馈。
   - **本地修改与线上验收**：独立 Web 侧栏任务菜单（列表视图与分组视图）调用官方 `openTaskFiles` 显示为「显示文件树」以定位任务 `cwd` 并打开右侧文件栏（顶栏任务菜单与手机远控隐藏该项）；无本机文件打开能力（`!canOpenLocalFiles`）时统一隐藏无效的「前往 Provider 配置」。本地 `standalone-desktop-parity-ui.mjs` 26 项（含分组视图菜单）通过，2026-11-17 线上验证侧栏任务菜单点击打开右侧文件树通过。

## 早前已部署并完成验收（`a18fe44a`，4 项）

提交 `a18fe44a`（完整 SHA：`a18fe44a5d0f3eadd7af630c854350952340e90c`，包含 `f4e9adb9`、`2d420913`、`844e62d6`、`e552c565`、`da4511a5`）已通过 GitHub Actions [`43860163049`](https://github.com/uselessbug/ZCode/actions/runs/43860163049) `success` 发布镜像 `sha-a18fe44a`（digest `sha256:b05def7328ed9ee88da4d21fd9fe60a55e1009298737fb433f5e9d8f44f98da9`），于 `2026-11-16T11:59:45.181Z` 完成宿主自更新部署与容器探针校验，并于 2026-11-16 至 2026-11-17 完成线上验收：

1. **移除项目时无法估算与清理当前服务器项目数据**
   - **症状**：2026-11-16 用户在独立 Web 执行项目移除与恢复时，移除确认弹窗预估项目数据触发 `project.measureProjectData FAIL Error: project.data-local-only`。
   - **本地修改与线上验收**：补齐 `packages/server/src/http.ts` 对 `measureProjectData`、`deleteProjectData` 的位置参数 Host 别名转换；仅在 `standalone-server` 且开启独立 Web 兼容配置时放行当前服务器 `ownerHostId`（跨 Host 与普通远端仍报 `project.data-local-only`）；同时覆盖独立 Web 本地路径哈希记忆目录（`<slug>-<hash>/memory`）与 canonical 身份哈希记忆目录（`project-<16位哈希>/memory`），并复用严格会话删除载体（优先命中热运行工作区 CLI 保护 `busy` 会话，仅在 `ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE` 且归属本服务器时回落管理面进程）。本地 `standalone-project-alias.mjs` 回归与 2026-11-17 线上项目移除估算、彻底清理验证均通过。
2. **普通二进制文件无法上传及 >64K 文本附件静默截断**
   - **症状**：独立 Web 上传普通二进制文件（如 `.zip`、`.docx`）失败或被当作文本处理，大于 64K 字符的文本附件在前端被静默截断。
   - **本地修改与线上验收**：前端对无 `localPath` 的普通文件统一按真实字节走 V4 `begin/chunk/commit` 分块上传（上限 20 MiB，支持 0 字节文件，超限抛 `OversizedInlineFileAttachmentError` 提供 5 语言提示并补齐图片超限本地化，移除前端 64K 字符截断）；用户实测 `.docx` 与 `.pdf` 附件上传通过，`5d682dfd` 进一步完成具名子目录落盘与桌面 `readTextFileForModel` 预读统一，2026-11-17 线上验证大文本、ZIP 与 20 MiB 超限提示通过。
3. **独立 HTTP 服务端定时任务缺少到期调度与立即运行执行链**
   - **症状**：独立 HTTP Server 原先仅有 `AutomationService` 读写接口，未挂载进程内到期调度器与 `runAutomationNow` 执行派发器，导致定时任务到期不触发、点击「立即运行」报错。
   - **本地修改与线上验收**：新增受管模块 `packages/services/src/automation-runtime`，提取并由 Desktop 与独立 HTTP 共享 20s 到期轮询、5min misfire 跳过、按 `runId` 幂等结算、单飞 manual claim 与 60s 心跳续租、统一变更 `wake` 及先排空在途派发再关库的优雅关闭；放行已持久化定时任务的冻结目录快照，仅在 `entry-http.ts` 显式启用执行链。本地 `standalone-automation-runtime.mjs` 回归通过；2026-11-17 线上排查确认此前两次失败源于所选模型供应商返回 HTTP 402（`insufficient_credits`），改用可用模型后到期运行与清空 `roots` 后按冻结目录立即运行均为 `succeeded`；后续 `5759c882` 进一步将独立 Web 定时任务回归官方 path-only 工作区身份（见上方“已部署并完成验收（`5759c882`）”第 1 项）。设计见[定时任务服务端执行链](../standalone-web-automation-runtime.md)。
4. **非桌面 Web 停用 Z.ai 营销／活动轮询（冗余清理）**
   - **症状**：非桌面 Web 入口挂载了仅用于桌面端的 Z.ai 营销轮询，产生无用请求与重复 `ZodError` 日志。
   - **本地修改与线上验收**：`MarketingTouchProvider` 在非桌面入口（`!desktop`）直接返回空上下文，不创建营销 runtime/poller、不挂载 `MutationObserver`、不发起 `marketing-touch.query` 请求，消除自托管 Web 下的无用轮询与重复 `ZodError` 日志。本地 `standalone-attachment-upload.mjs` 挂载对照与线上验证通过。

## 已验收的主题修复

- **Firefox Nightly“系统”主题暗色切回浅色失效**：用户在 Android Firefox Nightly `162.0a1` 反馈暗→浅不跟随、刷新仍暗，Firefox 自身界面已浅；PC Firefox Beta `161.0b3` 正常。Nightly 新规则让单值 `color-scheme` meta 覆写系统媒体查询，旧首屏 `dark` 和运行时单值写入形成反馈。提交 `b9f0e517` 已将两个网页入口固定为 `light dark` 并停止运行时改写 meta，CSS 原生控件配色照常同步；CI 与部署完成，普通 / Nightly 模拟规则 19 组通过，旧版变异检出。2026-11-16 用户确认手机自动跟随已恢复；切换时的加载条单独追踪。见[部署验证记录](./standalone-web-deployment-checklist.md)与[主题规格](../web-remote-control/mobile-theme-control.md)。

## 待评估建议与暂缓项（2 项）

1. **设置页“记忆”列表项菜单直接提供编辑入口（暂不做）**
   - **说明**：记忆文件点击查看、页内编辑与保存已可用；用户确认后端无删除接口则不做删除功能（需删除时让对话 Agent 删除，尽量少改后端），已取消新增删除接口需求；列表菜单直接“编辑”入口暂不做（若未来需要再另行评估）。
   - **状态**：暂不做（本轮不实施）。

2. **插件交互页（UI Plugin）独立 Web 承载**
   - **症状**：依赖宿主专属容器的插件自定义交互页面在独立 Web 下尚未提供通用承载入口。
   - **状态**：暂缓（低优先级，待实际使用需求明确后再评估）。

## 已修复

- **独立 Web 项目管理“撤销移除 / 恢复已移除项目”缺少 `restoreProject` Host 别名重写**
  - **症状**：在独立 Web「设置 -> 项目管理」移除项目后点击 Toast「撤销」，或在「已移除的项目」中点击恢复时，客户端以位置参数调用 `restoreProject(id, "local")`，服务端此前遗漏第 2 个位置参数 `hostId` 别名转换，会报 `project.host-offline`。
  - **状态**：已修复（提交 `f643ee64` 部署后，2026-11-16 用户在独立 Web 先从「已移除的项目」恢复旧版本移除的项目，随后连续操作两次「移除 → 恢复 → 移除」；服务端容器运行日志确认 4 次 RPC 全部成功且无 `project.host-offline`：`2026-11-16 15:10:38 project.restoreProject OK (11.9ms)`、`15:10:42 project.deleteProject OK (6.9ms)`、`15:10:45 project.restoreProject OK (7.2ms)`、`15:10:48 project.deleteProject OK (6.5ms)`。同次操作日志暴露出移除弹窗预估数据时报 `project.measureProjectData FAIL Error: project.data-local-only`，已作为独立问题在 `a18fe44a` 完成源码修复并部署上线，见上方“早前已部署（`a18fe44a`）”第 1 项）。

- **独立 Web / HTTP Server 下官方 `browser-use` 插件 `agent.browsers.list()` 返回 `[]`**
  - **症状**：官方 `browser-use` 插件已启用且运行模块可加载，但调用 `agent.browsers.list()` 返回 `[]`。
  - **已确认根因**：环境已安装 Chromium 且发行包内 Playwright 可解析；`services/zcodeAgentService` 缺少 `browserControlExecutor` 时 `agent.browsers.list()` 直接返回 `[]`，桌面端（desktop）已注入而独立 HTTP Server 入口未接线。
  - **状态**：已修复（提交 `ab4ab3ac` 与同批 `ce24c4cf` 3 项冗余代码清理随 `29c3c4dc` 部署生效，2026-11-15 网页访问与读取实测通过且用户确认；2026-11-16 `f643ee64` 镜像完整移除独立 Browser MCP 后线上访问读取复测通过。证据见[部署与实机验证清单](./standalone-web-deployment-checklist.md)，设计见[Browser Use 规格](../standalone-web-browser-use.md)）。

- **设置页删除自定义模型后底部“正在删除模型…”提示持续转圈不消失**
  - **症状**：在「设置 -> 模型供应商」删除模型后，详情栏底部删除进度横幅持续停留在转圈（`pending`）状态，未替换为“已删除”或失败提示。
  - **已确认机制**：`InlineEditableProviderCard.tsx` 的 `runSaveOperation` 原先让 Provider 表单草稿与所有模型操作共用单一 `draftRevisionRef`；连续删除不同模型或在模型删除在途期间发生 Provider 草稿变更时，后一次操作递增 `draftRevisionRef` 会使前一次操作完成时因 `shouldApplyProviderSaveCompletion` 版本不等而直接返回，导致 `model-save:<providerId>:<modelId>` 一直留在 `pending` 状态。
  - **状态**：已修复（提交 `454b2832`，本地真实 UI 浏览器回归 15 项通过；随 3.18.2 `4e959bab` 部署后，2026-11-15 用户实机确认模型保存与删除提示正常）。
- **独立 Web 设置页“当前服务器”MCP 已安装列表为空**
  - **症状**：独立云端 Web 进入「设置 -> MCP」选择“当前服务器”时，顶栏显示插件 MCP 计数（如 `MCP 7`），但“已安装”分组显示 `0`（用户级 `browser`、`rea` 等均不展示）。
  - **已确认根因**：服务端原生 `mcp-sync.loadMcpFromUserDirectory` 正常返回用户级 MCP，问题在于 `useMcpStore` 的 `resolveTargetDirectoryService` 将无 `workspaceIdentity` 且无 `authorityKey` 直接当作桌面本机探测并返回 `null`，回退到无桌面代理的 Web `platform` 读取硬编码 `{ servers: [] }` 并误标 ready。
  - **状态**：已修复（2026-11-13 用户部署实机验证通过；本地非 GUI 运行时回归 `node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-mcp-routing.mjs` 13 项通过）。
- **插件市场从服务器目录添加插件来源**
  - **症状**：在「插件市场 -> 添加来源」点击「选择目录」时调用电脑本地文件夹选择器，独立 Web 下无法浏览并选择服务器上的插件源目录。
  - **状态**：已修复（2026-11-12 实机验证通过：可在「添加来源」弹窗中浏览服务器目录并添加插件来源）。
- **工作区文件搜索 `.zcodeignore`「打开文件位置」**
  - **症状**：在「设置 -> 工作区文件搜索」生成或保存 `.zcodeignore` 后点击「打开文件位置」时调用电脑本地文件管理器。
  - **状态**：已实现，未单列实机验收（目标路径即为当前项目根目录，点击后打开右侧「文件管理」栏定位到项目根目录，未随技能路径回退；不作为阻断或待反馈项）。
- **任务移入项目、跨项目移动与项目多目录（多 root）限制**
  - **症状**：独立 Web 下无目录自动分配与单目录新建项目已可用，但为项目添加或编辑多个目录、将无项目会话移入项目，或在项目之间移动任务时，仍被远程单目录与目录不可变策略拦截。
  - **状态**：已修复（2026-11-12 实机验证通过：项目增删多个目录、无项目任务移入项目及跨项目移动均正常；2026-11-15 用户进一步确认新建与归档任务工作区归属正常。注：将已有任务“移出项目”变回无项目状态不在桌面端与后端既有设计范围内——`ProjectSidebarNode` 仅提供移动到目标项目，`moveTask` 接口 `projectId` 为必填非空字符串且校验目标项目存在，“不在项目中工作”仅用于新建无项目会话草稿，并非独立 Web 缺陷）。
- **记忆目录展示、正文页内查看与编辑保存，以及个性化指令门禁**
  - **症状**：独立 Web 此前因桌面门禁隐藏了服务端项目记忆目录与用户级 `AGENTS.md` 个性化指令；且官方原有“记忆”分区仅提供文件列表与调用本机外部编辑器（无删除接口），独立 Web 下无法在网页内直接查看或编辑记忆正文。
  - **状态**：已修复（按服务端能力开放项目记忆目录列表与服务端个性化指令读写；本仓新增记忆 Markdown 页内预览、编辑与保存，2026-11-12 实机验证通过）。
- **Node 发行包内置插件与内置技能资源缺失**
  - **症状**：独立 Web / Server 的 Node 打包与运行产物缺少内置插件、内置技能等随包资源，导致服务端运行时无法加载对应内置资源。
  - **状态**：已修复（2026-11-12 实机验证通过：内置官方插件与 `dynamic-workflows` 等内置技能资源齐全可用）。
- **安装与配置范围“用户 / 本机 / 此电脑”表述歧义**
  - **症状**：插件、技能等配置范围与项目本地设备沿用桌面端“用户 / 本机 / 此电脑”文案，在独立 Web 下易与访问者浏览器所在设备混淆。
  - **状态**：2026-11-12 用户确认设置页范围文案已改为“当前服务器”。项目弹窗与菜单里的设备名见上方“已部署待实机复测”第 4 项。
- **归档、取消归档、删除任务失败及旧会话复活（含 3.18.2 归档永久删除）**
  - **症状**：归档、取消归档或删除任务时报 `Unknown channel`，或删除任务后刷新、重新打开页面时旧会话重新出现；3.18.2 升级为官方「归档预检 + 二次确认永久删除」。
  - **状态**：已修复（2026-11-15 用户实机确认永久删除归档任务正常，服务端运行日志同步确认 `zcode-task.previewArchivedTaskDeletion` 与 `zcode-task.permanentlyDeleteArchivedTask` 均 `OK` 完成且无报错）。
- **项目创建（无目录自动分配 / 单目录）与非项目工作模式报错**
  - **症状**：新建项目（含不选目录自动分配与单目录创建）或切换到“不在项目中工作”时，界面直接报 `remote-single-root-required`、`remote-project-required` 等错误码。
  - **状态**：已修复（用户确认；多目录项目与任务跨项目移入/移动见上方“任务移入项目、跨项目移动与项目多目录（多 root）限制”）。
- **系统原生剪贴板长文本粘贴转附件**
  - **症状**：独立 Web 粘贴 ≥15360 字符文本时调用缺失的桌面临时文件接口，导致文本既未进入输入框也未生成附件。
  - **状态**：已修复（Web 端改走内存 `File` 附件上传路径，用户确认系统原生剪贴板长文本转附件正常；移动端输入法自带剪贴板无法通过标准粘贴事件可靠识别，不纳入追踪）。
- **任务分组排序与移出分组失效**
  - **症状**：独立 Web 下新建分组、拖动任务排序或将任务移出分组不生效，刷新后顺序丢失或报 `task-group.host-identity-mismatch`、`project.host-offline`。
  - **状态**：已修复（统一使用服务端权威身份读写分组与删除记录；2026-11-15 用户确认正常）。
- **手机工作区与设置页布局、导航、说明列及 Switch 尺寸**
  - **症状**：手机窄屏下工作区与设置页沿用桌面双栏与 192px 控件列，说明文字被挤成窄列、缺少移动端设置导航、Switch 控件被拉伸变形、触控高度不足 44px。
  - **状态**：已修复（接入手机 Home/Chat 导航壳层，设置页随 3.18.2 升级采用官方 `compact-web` 横向导航布局，说明在上控件在下，保持 Switch 原始尺寸与 44px 触控区；2026-11-15 用户确认手机工作区与新版设置页无明显问题）。
- **手机设置列表顶部留白过大**
  - **症状**：手机设置页早期沿用桌面窗口 48px 拖拽留白，返回按钮与导航整体偏下。
  - **状态**：已修复（移除移动端桌面拖拽留白并收敛返回栏间距，设置页随 3.18.2 升级采用官方 `compact-web` 横向导航；2026-11-15 用户确认正常）。
- **手机子代理颜色选中圈偏移**
  - **症状**：手机端颜色单选按钮触控高度增至 44px 后，24px 选中圈沿用固定 `top: 4px` 导致位置偏上、与色点不居中。
  - **状态**：已修复（选中圈改为垂直居中对齐；2026-11-15 用户确认手机子代理设置正常）。
- **子代理授权来源截断与长命令遮挡按钮**
  - **症状**：权限确认框中子代理来源说明仅在悬停标题显示或被截断，展开长命令后挤压底部导致批准/拒绝按钮不可见。
  - **状态**：已修复（完整换行展示子代理类型与任务说明，采用有界滚动容器保证操作按钮可达；2026-11-15 用户确认权限弹窗正常）。
- **设置页内置子代理模型菜单触控尺寸过小**
  - **症状**：手机端设置页内置子代理（`general-purpose`、`Explore`）的模型与思考强度下拉菜单未透传移动视口标志，仍按桌面 32px 渲染。
  - **状态**：已修复（透传移动视口标志，菜单项统一为 44px 触控高度且不超出屏幕宽度；2026-11-15 用户确认手机子代理设置正常）。
- **新建技能与插件试用预填后未进入聊天页**
  - **症状**：手机端在设置中点击“新建技能”或在插件详情点击“试用/示例”预填提示词后，停留在原页面未切换到聊天视图。
  - **状态**：已修复（触发预填后自动跳转至手机 Chat 页面并保留草稿；2026-11-15 用户确认预填导航正常）。
- **断线重连闪屏、焦点丢失与设置页跳回工作台**
  - **症状**：短暂断线重连时整页内容卸载闪烁、编辑器焦点丢失，或已打开的设置页在重连后被磁盘标签恢复逻辑切回对话页，以及点击“重试连接”被旧握手阻塞。
  - **状态**：稳定服务引用、同 Host 标签恢复和手动重试的修复已部署，2026-11-15 用户验证通过。首屏启动和前台恢复的后续调整见上方“已部署待实机复测”第 2 项。
- **新建项目目录浏览默认起点**
  - **症状**：独立 Web 新建项目选择目录时未默认定位到工作区根目录。
  - **状态**：已修复（独立 Web 目录浏览器默认起始路径设为 `/workspace`；2026-11-15 用户确认新建项目目录选择正常）。

## 桌面专属能力边界与暂不支持项（非独立 Web 缺陷 / 不计为已修复）

- **技能详情“打开路径”打开服务器目录（独立 Web 暂不支持）**：在「设置 -> 技能」点击技能路径原调用本机文件管理器；此前尝试打开右侧「文件管理」栏因文件树以当前项目为根、无法定位项目外技能目录，已撤回该适配（`SkillsSection` 退回原本地文件管理器调用与失败提示，技能页“当前服务器”范围文案保留）。**不计为功能已修复，独立 Web 暂不支持，不再单独追踪待验证。**
- **Electron 内置浏览器与本机 Chrome 数据导入/清理**：访问者电脑 Chrome Cookie 导入、内置浏览器缓存清理与证书设置仅适用于桌面端 Electron 内置浏览器；独立 Web 已区分提示。服务端浏览器自动化统一采用官方 `browser-use` 插件（走 `agent.browsers.*` / `browserControlExecutor` 受管无头 Chromium 链路）；早期独立 `@playwright/mcp` 用户级配置与容器镜像 `/opt/browser-mcp` 均已随 `f643ee64`（`sha-f643ee64`）完整移除，且移除后线上 Browser Use 网页访问读取复测通过（详见[部署与实机验证清单](./standalone-web-deployment-checklist.md)与[Browser Use 规格](../standalone-web-browser-use.md)）。
- **原生桌面交互（GenUI 沙箱、系统托盘、本机 WSL 等）**：依赖桌面宿主桥接，独立 Web 按平台能力隐藏或给出说明，不伪装为桌面可用。

## 内部工程与测试标识小项（非用户故障）

- **`MemorySettingsViewer` 冲突重载按钮 `data-testid` 重复（已部署，组件 fixture 通过）**：冲突重载改用 `TID_SETTINGS_MEMORY_RELOAD`（`settings-memory-reload`），列表刷新保留原标识，已随 `f643ee64` 部署上线。真实组件浏览器 fixture 验证冲突流程、标识唯一、取消保留草稿与确认加载最新文件通过（旧标识变异能被检出）；完整 Electron WDIO 用例未运行。证据见[部署与实机验证清单](./standalone-web-deployment-checklist.md)。

## 相关设计说明

- [独立 Web 实施基线](./standalone-web-baseline.md)
- [独立 Web 部署与实机验证清单](./standalone-web-deployment-checklist.md)
- [独立 Web 浏览器通知与后台推送](../standalone-web-notifications.md)
- [定时任务服务端执行链](../standalone-web-automation-runtime.md)
- [Browser Use 规格](../standalone-web-browser-use.md)
- [连接恢复](../standalone-web-recovery.md)
- [任务管理与非项目工作模式](../standalone-web-task-and-project-compat.md)
- [多 root 项目与任务移动](../standalone-web-multi-root-projects.md)
- [任务分组与手机界面兼容](../standalone-web-mobile-and-task-groups.md)
- [手机可用性与服务端能力边界](../standalone-web-mobile-parity.md)
- [长文本粘贴与子代理模型选择器](../standalone-web-input-settings-followup.md)
- [重连连续性](../standalone-web-reconnect-continuity.md)
- [设置页服务边界与手机布局](../standalone-web-settings.md)
- [Node 统一发行包规格](../../specs/zcode-unified-distribution.md)
