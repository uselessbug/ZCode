# 独立 Web 实施基线

## 1. 上游 3.18.2 升级基线

- 记录日期：2026-11-15
- 升级分支与合并链路：`sync/upstream-3.18.2`（PR #2，GitHub Actions 运行 `43569582003` `success`）合并至 `main` 生成 `ae58c92f`（GitHub Actions 运行 `43570424184` `success`），后续在 `main` 提交 `4e959bab`（完整 SHA：`4e959baba16eeb1f8403b9785aa3bae7866dd32f`，容器镜像新增 Docker CLI 与 Compose 插件，GitHub Actions 运行 `43622140891` `success` 并发布 `latest` 与 `sha-4e959bab`）
- 关键包含提交：
  - 上游合并提交：`347fd4ff`（合并上游 `fec97590` v3.18.2 与独立 Web 基线 `f40a4597`，共同祖先 `a9fe401e`）
  - 模型删除/保存反馈竞态修复提交：`454b2832`
  - CI 依赖安装竞态修复提交：`bf8c2105`
  - 容器内置 Docker CLI / Compose 插件提交：`4e959bab`
  - 3 项冗余参数/字段清理与独立 HTTP Web 官方 `browser-use` 受管 CDP 适配：`ce24c4cf`、`ab4ab3ac`（阶段发布基线 `29c3c4dc`）
  - 项目恢复 `restoreProject` 位置参数转换、记忆冲突重载专用标识与独立 Browser MCP 镜像/文案清理：`f643ee64`
  - 系统主题 `meta[name="color-scheme"]` 兼容修复：`b9f0e517`
  - 非桌面 Web 停用营销轮询、普通二进制与 >64K 文本附件修复、移除项目数据估算与清理、独立 HTTP 服务端定时任务 `automation-runtime` 执行链：`f4e9adb9`、`2d420913`、`844e62d6`、`e552c565`、`a18fe44a`
  - 独立 Web 对齐官方桌面行为（`52c43e5a`、`520e37e9`、`9d3ef7b2`、`5d682dfd`，已通过 CI `43917276559` 构建发布 `sha-5d682dfd` 并完成部署探针校验与 2026-11-17 线上验收）：附件 `<artifactId>/<安全化原文件名>` 具名子目录落盘与桌面 `readTextFileForModel` 预读统一、项目数据双记忆命名空间覆盖（`<slug>-<hash>/memory` + `project-<hash>/memory`）、独立 Web 开启 `assistantCodeCommentCardsEnabled` 代码批注卡片、定时任务已冻结目录快照放行、Browser Use 普通释放保留上下文与归档/删除生命周期 `closeTaskSessions` 清理、0 目录新建与编辑清空目录对齐桌面懒创建 `/workspace/.zcode/workspace/<projectId>` 生命周期、当前服务器本地 Git 受管 Worktree 全链路打通（`/workspace/.zcode/worktrees`）、侧栏任务菜单「显示文件树」与隐藏无效「前往 Provider 配置」
  - 独立 Web 定时任务 path-only 工作区身份回归与进程池/空闲回收优化（`b8b71985`、`5759c882`，本地串行回归 `standalone-automation-runtime.mjs` 通过，已通过 CI `44167318739` 构建发布 `sha-5759c882`，于 `2026-11-17T20:44:37.133Z` 完成部署与容器探针校验，并于 2026-11-18 完成线上验收）：`standalone-server` 开启 `allowStandaloneCloudWorkspaces` 时新建项目/无项目定时任务与 path-only 会话内 `CronCreate` 保持 `workspaceIdentity: undefined`（`workspaceKey = workspacePath`、`hostId = projectStorageHostId`），入站非空身份经只读 `workspace_alias` 校验拒绝异域请求且关联既有 canonical 会话保留 canonical 坐标；接通官方 `useSharedTaskRuntime`（委托 `hasProjectWorkspace` 让无项目与 `draft-*` 草稿共用单个 `SHARED_TASK_RUNTIME_KEY` 进程，项目目录与 0 目录项目首次 `prepareSession` 目录独占进程）并为 `pluginProcessManager` 注入默认 5 分钟 `idleTimeoutMs` 自动回收与按需重拉起
  - 独立 Web 浏览器通知与后台推送（Web Push）（`7a72f272`、`d20c7f4c`、`71149de2`，已通过 CI `44247679952` 构建发布 `sha-71149de2`，于 `2026-11-18T06:24:33Z` 完成宿主自更新部署并通过 `2026-11-18T06:24:31.853Z` 容器与 Web Push 接口探针校验；2026-11-18 用户实测确认 PC Firefox 与 Android Firefox 均可正常收到 Web Push 推送、Mozilla Autopush 返回 HTTP 201）：补齐 Web 通知授权、Android Service Worker `showNotification` 兼容、4s `tag`/`secondaryTag` 去重、总开关退订与通知声音联动、`userVisibleOnly: true` 约束与前台通知清理；服务端基于 Node 原生 `crypto` 实现 VAPID（RFC 8292）与 `aes128gcm`（RFC 8291）并持久化在 `<appConfigDir>/web-push/`，覆盖会话完成/失败（主动停止静默）、全局会话待审批/`AskUserQuestion`/`ExitPlanMode`（含 `autoResolution` 转换与已解决取消）、定时任务终态结算与回合去重，提供同源 `/api/web-push/*` 接口、出站 DNS/IP 防私网校验、PWA `manifest.webmanifest`（`crossorigin="use-credentials"`）及 iOS 16.4+ 主屏幕指引
  - 基于 `71149de2` 的通知点击、多标签协同、重连体验与草稿修复（`c4a71467` 与跟进移除工作台重复重连横幅的 `0ebadad9`，已通过 `standalone-web-push.mjs` 47 项、`standalone-desktop-parity-ui.mjs` 30 项、`standalone-multi-root-projects.mjs` 8 组与 `standalone-pending-draft-recovery.mjs` 5 组本地回归，`0ebadad9` 经 CI [`44336551515`](https://github.com/uselessbug/ZCode/actions/runs/44336551515) 构建发布 `sha-0ebadad9`，于 `2026-11-18T15:52:00Z` 完成宿主自更新部署并通过 `2026-11-18T15:51:30.977Z` 容器探针与受控浏览器对照校验，待实机复测）：① 通知点击跳转修复（改调 `zcodeTaskService.getTaskMeta` 定位会话与断线重试、`requestNotificationTaskNavigation` -> `WorkspaceShellLayout.handleSelectTaskInChat`、`WebRemoteControlMobileShell` `revealChatRequestId` 切入 `Chat`、冷启动深链直传 `<Root initialWorkspaceAbsPath initialTaskId initialWebRemoteControlMobileNavigationIntent="chat">`、SW `client.focus()` 不可见时 `postMessage` 保底 + `clients.openWindow` 回退、页内通知补齐 `workspacePath`）、多标签协同通知（`syncActiveTaskSession` 在设置页与手机 `Home` 列表上报 `null`，`syncWindowTabs` 上报当前激活工作区与已打开工作区，SW 统一 4 秒去重、单次响铃、仅前台聚焦查看该 `taskId` 时抑制、窗口全部最小化时对已由页内展示的同 `tag` 推送以 `silent: true, renotify: false` 合并，点击通知按「已打开该 `taskId` > 当前停在该项目工作区 > 已打开该项目 Tab > 兜底窗口」优先级聚焦标签页）与主动停止/抢占打断 `completedInterrupted` 静默；② 独立 Web 首屏零横幅直出、手机切后台 `0ms` 无感重连与移除已加载工作台后的重复重连横幅（`resolveWebBootstrap` 已确认鉴权时首连单次 `/ws` 握手挂载 `<Root>`、首连 `3000ms` 保留 `index.html` 启动动画、移除 `inert` 与 `StandaloneFocusRestore*`、切后台恢复 `2.5s` 短超时探活与 `0ms -> 1s -> 2s -> 4s -> 8s` 退避、握手失败才调 `checkAccess` 区分登录过期；`0ebadad9` 移除工作台加载后的 `4500ms` 独立 Web 通用重连横幅，已打开会话视图沿用上游会话订阅重连/反馈面板，仅 `auth-required` 显示重新验证与重试横幅）；③ 无项目新建任务失效草稿目录自动换绑恢复（`reuseDraft: true` 遇到 `ENOENT` 返回 `project.draft-workspace-missing`，前端 `rotateMissingPendingTaskDraft` 自动换绑新 UUID 重建目录并保留草稿文字，含迟到回包、并发换绑与无项目菜单路径校验）；④ 独立 Web 项目设备名称统一改为“当前服务器”（`ProjectEditor`、`ProjectManagementRow`、`ProjectFolderTrustDialog`、`ProjectComposerMenu` 四处在 `useIsServerHostedSettingsScope()` 下显示“当前服务器”）
- 升级前 `main` 基线：`f40a4597`（`docs(maintenance): record standalone MCP deployment acceptance`）
- 当前状态（更新于 2026-11-18）：线上容器当前实际运行版本为 `0ebadad9`（完整 SHA：`0ebadad960fb34fd23fa9f956622b2d7b06fb42a`；GitHub Actions [`44336551515`](https://github.com/uselessbug/ZCode/actions/runs/44336551515) `success`，镜像 `sha-0ebadad9` / `latest`，digest `sha256:3a0366e6fa23bfb14f545adaac695fdb728a07fbe0f06e900803c0cde73e22a0`，于 `2026-11-18T15:52:00Z` 完成宿主自更新部署并通过 `2026-11-18T15:51:30.977Z` 容器与运行探针校验，`ai-agent-zcode-1` 状态 `running` / `healthy` / `restarts: 0`，`/zcode-push-sw.js` 哈希与工作区源码一致、`vapid.json` 与凭据/Provider 指纹保持不变）。受控 Chromium 对已发布镜像的隔离回环对照确认：旧版 `c4a71467` 长断线后显示独立 Web 额外横幅，新版 `0ebadad9` 断线 `>=8s` 不再显示该额外横幅、对话内容保持可见且网络恢复后 WebSocket 自动重连恢复，模拟登录过期仍显示重新登录与重试且鉴权恢复后重试可恢复对话（受控测试未触发官方会话订阅错误面板）。上述 4 项修复（`c4a71467` 及其重连横幅收敛跟进 `0ebadad9`）已部署上线，待用户在实体 PC 与手机端完成真实场景复测（注：Firefox Android 若进程已被系统彻底杀死，受 Mozilla [Bug 1762032](https://bugzilla.mozilla.org/show_bug.cgi?id=1762032) 限制会忽略通知点击；后台驻留与切换标签通过 `openWindow` 回退拉起）。前一版本 `71149de2`（完整 SHA：`71149de29744d8b0e5aeb3535e1b78a7b4c673c2`，GitHub Actions [`44247679952`](https://github.com/uselessbug/ZCode/actions/runs/44247679952) `success`，镜像 `sha-71149de2`，`2026-11-18T06:24:33Z` 部署）已完成 PC Firefox 与 Android Firefox 推送收包实测（Mozilla Autopush 返回 HTTP 201）。更早基线 `5759c882`（完整 SHA：`5759c882095668742fc53d2ab857d6dce34ef216`，包含 `b8b71985`、`5759c882`；GitHub Actions [`44167318739`](https://github.com/uselessbug/ZCode/actions/runs/44167318739) `success`，镜像 `sha-5759c882`，digest `sha256:f9c120bc2a66d3dbe83548a1f05a67208911bc245bee44dd41cb5fbabb04378f`）的 2 项修复已于 2026-11-18 完成线上验收：定时任务回归官方 path-only 工作区身份后，用户实测“立即运行”正常，改为 1 分钟间隔（`* * * * *`）到期自动触发执行返回 `succeeded`（生成会话 `workspace_identity: null`）且与同项目交互对话共用同一顶层 `zcode-cli` 进程；`plugin-management` 进程在最后一次调用满 5 分钟（`07:37:38.181` → `07:42:38.181`）准时触发 `idle timeout; reclaiming` 自动退出，顶层仅保留当前活跃项目与 `/home/agent/.zcode` 无项目共享池两个进程。更早基线 `5d682dfd`（完整 SHA：`5d682dfd473c915dad98a3c16688f822237764f8`，GitHub Actions [`43917276559`](https://github.com/uselessbug/ZCode/actions/runs/43917276559) `success`，镜像 `sha-5d682dfd`，digest `sha256:ce7a0475f08bff71703f0ce1be81bb7f22e315ba1130a51f58651eade2838075`）8 项桌面行为对齐更新已于 2026-11-17 完成线上验收。当前另有 1 项待定位问题（Android Firefox Nightly 自动切换主题时页面重载并出现重连横幅）。早前 `a18fe44a`（GitHub Actions [`43860163049`](https://github.com/uselessbug/ZCode/actions/runs/43860163049) `success`，镜像 `sha-a18fe44a`，`2026-11-16T11:59:45.181Z` 探针通过）4 项改动已于 2026-11-16 至 2026-11-17 完成线上验收；`b9f0e517`（GitHub Actions [`43795610757`](https://github.com/uselessbug/ZCode/actions/runs/43795610757) `success`，镜像 `sha-b9f0e517`）主题兼容修复已由用户确认手机自动跟随恢复；`f643ee64` 部署的 `restoreProject` 项目恢复已于 2026-11-16 经用户页面连续移除/恢复实操与服务端 4 次 RPC 日志确认通过，记忆标识与 Browser MCP 清理保持生效。详细证据见 [standalone-web-deployment-checklist.md](./standalone-web-deployment-checklist.md) 与 [issues.md](./issues.md)。
- 历史部署验收基线：2026-11-15 `29c3c4dc`（GitHub Actions 运行 [`43723274317`](https://github.com/uselessbug/ZCode/actions/runs/43723274317) `success`）完成 `ce24c4cf` 冗余清理生效及官方 `browser-use` 网页访问读取实测与用户确认；更早 `4e959bab` 部署完成运行日志 5446 行无关键错误核验及用户多端实机验收（模型保存/删除提示、归档任务永久删除、实体手机重连、手机工作区与 `compact-web` 设置页、任务分组、子代理设置与权限弹窗、新建技能/插件试用预填跳转、新建项目目录选择与任务工作区归属均确认正常；详见 [standalone-web-deployment-checklist.md](./standalone-web-deployment-checklist.md)）。

### 1.1 升级保护能力范围

以下能力均已集成到 `main`，并随 `0ebadad9` 部署。重复横幅修复通过隔离浏览器对照，4 项更新的实机复测见[问题台账](./issues.md)。

1. **连接恢复与重连连续性**：独立 Web 首屏单往返握手（仅首连设置一次 `3000ms` 延迟保留 `index.html` 启动动画，超时才显示首连提示与手动重试）、切后台恢复 `2.5s` 快速探活与 `0ms -> 1s -> 2s -> 4s -> 8s` 退避重连、工作台已加载后普通断线重连不再弹出独立 Web 顶部通用重连横幅（打开的会话视图沿用上游会话订阅重连/反馈面板，其“重新连接”重试 `lease.store.retry()`，设置页/首页不新增额外提示，底层 `/ws` 后台独立自动重连；首连与重连遇到 `auth-required` 仍立即显示重新验证横幅，点击重试在同一横幅暂态显示“正在连接服务器…”直至恢复或再次要求验证）、断线期间无 `inert` 锁页保持设置页/草稿/原生焦点、过期 RPC 清理、服务端项目 Host 别名解析。
2. **任务、多 root 项目、受管 Worktree、定时任务与共享进程池**：独立 Web 任务归档/取消归档、侧栏任务菜单「显示文件树」（隐藏无效「前往 Provider 配置」）、无项目会话草稿（`/workspace/.zcode/conversations/draft-<id>`，目录缺失时返回 `project.draft-workspace-missing` 并由 `rotateMissingPendingTaskDraft` 自动换绑重建且保留草稿正文）与非项目目录共用 `SHARED_TASK_RUNTIME_KEY` 进程、0 目录新建与编辑清空目录（首次 `prepareSession` 懒创建 `/workspace/.zcode/workspace/<projectId>` 并独占项目进程）、多 root 项目目录增删与任务跨项目移入/移动、当前服务器本地 Git 受管 Worktree（`/workspace/.zcode/worktrees`）、独立 Web 定时任务 path-only 工作区身份（`workspaceIdentity: undefined`、`hostId = projectStorageHostId`，纯只读 `workspace_alias` 入站校验与冻结目录快照放行）、任务分组排序与移出分组。
   - **归档任务删除（3.18.2 用户可见变化）**：采用上游 3.18.2 官方「归档预检 + 二次确认永久删除」及同 Host 归档删除 carrier 路由（含受管 Worktree 归档任务主工作区路径对齐），不再保留旧版软删除 guard helper，不自动清理既有历史数据（2026-11-15 已实机确认）。
3. **移动端、输入、消息渲染与浏览器通知/Web Push 适配**：手机 Home/Chat 单栏导航与设置页官方 `compact-web` 横向导航布局、子代理颜色选中居中与模型菜单 44px 触控尺寸、权限弹窗子代理来源完整换行与有界滚动、新建技能/插件试用预填自动跳转聊天页、独立 Web 开启 `assistantCodeCommentCardsEnabled` 代码批注卡片、普通文件与长粘贴 `<artifactId>/<安全化原文件名>` 具名子目录落盘并复用桌面 `readTextFileForModel` 预读、独立 Web 页内浏览器通知与标准 Web Push 后台推送（VAPID + `aes128gcm`、`<appConfigDir>/web-push/` 持久化、Service Worker 多标签去重/单次响铃/按 `taskId` 精确防打扰与最小化静音合并、主动打断 `completedInterrupted` 静默、PWA `manifest.webmanifest` 与点击通知按标签页优先级聚焦/冷启动跨工作区会话定位，详见 [`standalone-web-notifications.md`](../standalone-web-notifications.md)）。
4. **服务端记忆、项目数据清理、范围与设备文案及目录交互**：项目记忆目录展示与 Markdown 页内预览/编辑/保存、项目数据清理同时覆盖本地路径哈希记忆目录与 canonical 身份哈希记忆目录、服务端个性化指令（`AGENTS.md`）读写、`settings.scope.server`“当前服务器”文案（覆盖设置页范围选择与 `ProjectEditor`/`ProjectManagementRow`/`ProjectFolderTrustDialog`/`ProjectComposerMenu` 本地设备名）、从服务器目录添加插件来源、`.zcodeignore` 打开右侧文件栏定位项目根目录（已实现，未单列验收；技能详情打开路径维持撤回、独立 Web 暂不支持）。
5. **独立 Web MCP 服务端路由、插件管理进程空闲回收、Browser Use 受管 CDP 与 Node 统一发行包**：独立 Web “当前服务器”与项目 MCP 路由至服务端 Host 读写/启停/重连；`standalone-server` 为 `pluginProcessManager`（`plugin-management` lane）注入默认 5 分钟 `idleTimeoutMs` 自动回收并支持按需重拉起；独立 HTTP Server 接入官方受管无头 Chromium（`server-browser-control` -> `agent.browsers.*`，普通 `closeSession` 保留上下文入有界空闲池，归档/删除/项目清理经 `closeTaskSessions` 彻底销毁）；`zcode` / `zcode --web` 发行包内置官方插件与 `bundled-skills` 随包组装及容器 `sha-<8位>` 标签发布。

### 1.2 3.18.2 凭据强校验与回退限制

依据 [`docs/plans/2026-10-29-system-credential-storage.md`](../plans/2026-10-29-system-credential-storage.md)（保持上游行为，不自动生成生产密钥或恢复弱密钥兜底）：

- **凭据密钥发现与强校验（`:99-104`）**：独立 Server / Docker Web 在开放 HTTP 服务前会初始化凭据后端；无系统 keyring 时支持以下任一方式提供 32–4096 字节只读随机文本密钥（按 UTF-8 文本原样读取、不 trim）：
  1. 未设置环境变量时，自动发现默认持久化路径 `<zcodeHomeDir>/v2/credential-secret`（容器默认 `/home/agent/.zcode/v2/credential-secret`，已有合规密钥文件时直接复用，无须额外设置 `ZCODE_CREDENTIAL_SECRET_FILE`）；
  2. 显式设置 `ZCODE_CREDENTIAL_SECRET` 或 `ZCODE_CREDENTIAL_SECRET_FILE`（二者不可同时设置）。
     本地隔离探针已验证凭据 cipher wrapper 初始化，实际 3.18.2 容器部署已通过默认持久化 `v2/credential-secret` 自动发现完成启动与基础探针验收。
- **v2 密文与跨版本回退限制（`:46-63`）**：3.18.2 启用 `zcodeCredentialFormat: 2`（v2 密文）。一旦写入或迁移生成 v2 密文，仅支持 v1 的旧版镜像（如 3.17.2 阶段的 `f40a4597` / `364e6c55`）无法读取 v2 密文（且旧版程序不具备 v2 版本门禁，不会自动安全阻止回滚）。因此不能仅靠切回旧镜像标签回退；升级前须对整个持久化数据目录（含 SQLite 数据库与凭据目录）及凭据密钥做一致性备份，回退前须核对 SQLite 迁移兼容性并整体恢复升级前数据备份，不能假设仅恢复 `credentials.json` 即可回退。

---

## 2. 历史基线记录（3.17.2 阶段回退基线）

- 记录日期：2026-11-12（至 2026-11-13 完成 `f40a4597` 实机验收）
- 仓库：`uselessbug/ZCode`
- 分支：`main`（基于 v3.17.2）
- 3.17.2 阶段改动前远端 main：`364e6c55`（完整 SHA：`364e6c551a0ec0680488e558bf01459da555e1e1`，`feat(web): enable server personalization settings`）
- 3.17.2 阶段适配收口提交：`f40a4597`（`docs(maintenance): record standalone MCP deployment acceptance`）

在尚未部署 3.18.2（未写入 v2 凭据密文）时，`364e6c55` / `f40a4597` 对应提交的 `sha-<8位>` 镜像为 3.17.2 阶段回退基线。升级 3.18.2 后的回退须遵守上方 1.2 节凭据格式限制。

## 关联文档

- [独立 Web 与移动端适配问题清单](./issues.md)
- [独立 Web 部署与实机验证清单](./standalone-web-deployment-checklist.md)
- [独立 Web 浏览器通知与后台推送](../standalone-web-notifications.md)
- [定时任务服务端执行链](../standalone-web-automation-runtime.md)
- [系统安全存储与凭据迁移计划](../plans/2026-10-29-system-credential-storage.md)
- [多 root 项目与任务移动](../standalone-web-multi-root-projects.md)
- [设置页服务边界与手机布局](../standalone-web-settings.md)
- [Node 统一发行包规格](../../specs/zcode-unified-distribution.md)
