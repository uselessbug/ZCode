# 独立 Web 实施基线

## 1. 上游 4.0.0 升级基线

- 记录日期：2026-11-27
- 上游基线版本：`v4.0.0`（上游 tag `a4b4445141eb7d3b3e99eada9292775383bfc44e`，构建源 `6d86cdaa161f70573e88ce1ad2d15ea767167285`），与前版 `v3.18.2`（`fec975905a2abd4c07e35c40d51fa097a2258ec9`）及原 `main`（`67ca5801671318a4ce454078546a694e097b9e3a`）合并。
- 升级分支与合并链路：`sync/upstream-4.0.0`（合并提交 `ffbd8c0e7542ccab71081bf1e0cee43d0b83b8a0` + 测试夹具外置修复 `a29797b9`），[PR #3](https://github.com/uselessbug/ZCode/pull/3) 经 GitHub Actions [`45942444661`](https://github.com/uselessbug/ZCode/actions/runs/45942444661) `success` 全绿通过后合入 `main` 生成 `fe8520a3`（完整 SHA：`fe8520a3d8e8a649367e07700638463d9e307c3e`）；`main` 分支 GitHub Actions [`45943585104`](https://github.com/uselessbug/ZCode/actions/runs/45943585104) `success`，发布 `ghcr.io/uselessbug/zcode:latest` 与 `ghcr.io/uselessbug/zcode:sha-fe8520a3`（digest `sha256:6a088d52eef19eba45cbd4f7f1ab8c5c1b5c743173e8afd4463bf34ddd27df67`，`org.opencontainers.image.version=4.0.0`，`org.opencontainers.image.revision=fe8520a3d8e8a649367e07700638463d9e307c3e`）。
- 4.0.0 核心取舍与新增适配：
  - 采用上游 4.0 实现并清理残留：会话状态面板切换至上游输入框状态胶囊（`StatusCapsule` / `ComposerStatusRow`，窄屏保持 32px 紧凑高度并以 `::before` `inset: -7px 0` 补足 44px 垂直触控热区，清理旧状态面板与 `summaryPanelLayout` 残留）；采用上游归档永久删除批量预检（`deletionPreviewBatch` / `inspectSessionDeletions`）与分享字节头尾统计 `statToolResultArtifact`；复用既有 `isTaskArchived` 移除重复 `getTaskIndexFlags`；保留 Web 区域 OAuth 返回路径修复、CLI 显式 `--browser-state`、`project.host-mismatch.{owner,project,fork}` 细分错误码与 Worktree Hook Trust。
  - 独立 Web 适配更新：统一单项与批量永久删除的同 Host 热/冷载体路由及受管 Worktree 目录映射，并修复 `standalone-archived-deletion-carrier.mjs` 后台订阅计数偶发抖动；窄屏模型面板适配 4.0 `Popover`（`[role="option"]` ≥ 44px）；Linux 统一发行包按目标平台排除仅限 macOS/Windows 的 `computer-use` 插件（保留其余 16 个官方插件及 4 个办公文档插件新增的 `zcode_libreoffice.py` / profile 资产）；接通独立 Web「设置 -> 行为与工具 -> 回复语言（`replyLanguage`）」（`createWebPlatform` 在独立 Web 挂载 `setReplyLanguage` 与 `onSettingsChanged`，经空串清除哨兵写入 `setting.json`，服务端 `node.ts` 同步刷新内存缓存并响应 CLI `session/readReplyLanguage`，手机远控保持显示“请在本机设置”）。
  - 数据库迁移与回退约束：CLI 会话库新增 `0026_dwf_run_parent_session_index` 索引迁移（`tasks-index.sqlite` 无新增迁移，凭据仍为 `v2` 格式）；升级后如需回退至 3.18.2 阶段镜像（`sha-cf6fa5df`），须连同停机前一致性备份一并恢复，不单切镜像。
- 当前状态（更新于 2026-11-27）：线上容器 `ai-agent-zcode-1` 当前实际运行版本为 `4.0.0`（源码 `fe8520a3d8e8a649367e07700638463d9e307c3e`，镜像 `sha-fe8520a3` / `latest`，digest `sha256:6a088d52eef19eba45cbd4f7f1ab8c5c1b5c743173e8afd4463bf34ddd27df67`）。2026-11-27 经独立后台 `docker:cli` 执行 `zcode-self-update.sh`（日志 `20261127T052402Z.log` / `helper-fe8520a3.log`），一致性停机备份 `/opt/stacks/ai-agent/backups/zcode-self-update/20261127T052402Z.tar.gz` 经 `tar -tzf` 校验通过，新容器于 `2026-11-27T05:28:04Z` 启动就绪（`running` / `healthy` / `restarts: 0`），已清理旧归档 `20261121T134012Z.tar.gz`、`local/zcode-rollback` 临时标签及旧镜像 `sha256:7d1f5846858e1a7a8d8a128f2c0a239e9aabaa38cb9ddc1233f480335156fbe1`，并通过本地 `/ws` RPC 自动唤醒原会话。探针快照 `/opt/stacks/ai-agent/backups/zcode-self-update/probe-fe8520a3.json`（`checkedAt: 2026-11-27T05:28:52.672Z`）确认 `serverVersion: "4.0.0"`、`serverId: "oci-ai-agent"`、`GET /` `200`（双值 `color-scheme` meta 为 `true`）、`GET /manifest.webmanifest` `200`、`GET /zcode-push-sw.js` `200`（SHA-256 `3f6ee8a07b000310b692615aeeb511ab75c1e2b009fad977a3098a3cedb637f9`）、鉴权 `/api/server-info` `200`（`managedWorktrees: true`、`standaloneTerminalOwners: true`）/ 未鉴权 `401`、鉴权 `/api/web-push/config` `200`（`enabled: true`）、WebSocket `/ws` 握手与会话元数据读取通过、`credential-secret` / `provider_config.json` / `vapid.json` SHA-256 指纹保持不变、`/opt/browser-mcp` 不存在。详细证据见 [standalone-web-deployment-checklist.md](./standalone-web-deployment-checklist.md) 与 [issues.md](./issues.md)。

### 1.1 升级保护能力范围

以下能力均已集成到 `main`，并随 4.0.0（`fe8520a3`）部署（各项更新的实机复测见[问题台账](./issues.md)）。

1. **连接恢复与重连连续性**：独立 Web 首屏单往返握手（仅首连设置一次 `3000ms` 延迟保留 `index.html` 启动动画，超时才显示首连提示与手动重试）、切后台恢复 `2.5s` 快速探活与 `0ms -> 1s -> 2s -> 4s -> 8s` 退避重连、工作台已加载后普通断线重连不再弹出独立 Web 顶部通用重连横幅（打开的会话视图沿用上游会话订阅重连/反馈面板，其“重新连接”重试 `lease.store.retry()`，设置页/首页不新增额外提示，底层 `/ws` 后台独立自动重连；首连与重连遇到 `auth-required` 仍立即显示重新验证横幅，点击重试在同一横幅暂态显示“正在连接服务器…”直至恢复或再次要求验证）、断线期间无 `inert` 锁页保持设置页/草稿/原生焦点、过期 RPC 清理、服务端项目 Host 别名解析、独立 Web 终端（PTY）按所属页面独立 owner 作用域生命周期隔离（短断线宽限期保留、确认离开/刷新或超时仅回收本页 PTY）。
2. **任务、多 root 项目、受管 Worktree、定时任务与共享进程池**：独立 Web 任务归档/取消归档、侧栏任务菜单「显示文件树」（隐藏无效「前往 Provider 配置」）、无项目会话草稿（`/workspace/.zcode/conversations/draft-<id>`，目录缺失时返回 `project.draft-workspace-missing` 并由 `rotateMissingPendingTaskDraft` 自动换绑重建且保留草稿正文、支持无项目草稿冷恢复与附件预热等待/失败重试门禁、页面本地导航隔离与已删项目安全回退、首发结果不明按原 `commandId` 只查不重发）与非项目目录共用 `SHARED_TASK_RUNTIME_KEY` 进程、0 目录新建与编辑清空目录（首次 `prepareSession` 懒创建 `/workspace/.zcode/workspace/<projectId>` 并独占项目进程）、多 root 项目目录增删与任务跨项目移入/移动（保留 `project.host-mismatch.{owner,project,fork}` 细分错误码）、当前服务器本地 Git 受管 Worktree（`/workspace/.zcode/worktrees` 及 Worktree Hook Trust）、独立 Web 定时任务 path-only 工作区身份（`workspaceIdentity: undefined`、`hostId = projectStorageHostId`，纯只读 `workspace_alias` 入站校验与冻结目录快照放行）、任务分组排序与移出分组。
   - **归档任务永久删除（单项与 4.0 批量预检）**：采用上游归档预检 + 二次确认永久删除及 4.0 批量预检（`deletionPreviewBatch` / `inspectSessionDeletions`），统一单项与批量永久删除的同 Host 热/冷载体路由及受管 Worktree 主工作区路径对齐（复用既有 `isTaskArchived` 移除重复 `getTaskIndexFlags`，并修复 `standalone-archived-deletion-carrier.mjs` 后台订阅计数偶发抖动）。
3. **移动端、输入、状态胶囊、消息渲染与浏览器通知/Web Push 适配**：手机 Home/Chat 单栏导航与设置页官方 `compact-web` 横向导航布局、输入框状态胶囊（`StatusCapsule` / `ComposerStatusRow`，窄屏保持 32px 紧凑高度并以 `::before` `inset: -7px 0` 补足 44px 垂直触控热区，清理旧状态面板与 `summaryPanelLayout` 残留）、子代理颜色选中居中与窄屏 4.0 `Popover` 模型菜单（`[role="option"]` ≥ 44px）、权限弹窗子代理来源完整换行与有界滚动、手机 `Home` 新建任务/草稿等待 `prepareSession` 完成后再切入 `Chat`、新建技能/插件试用预填自动跳转聊天页、独立 Web 开启 `assistantCodeCommentCardsEnabled` 代码批注卡片、普通文件与长粘贴 `<artifactId>/<安全化原文件名>` 具名子目录落盘并复用桌面 `readTextFileForModel` 预读（含分享字节头尾统计 `statToolResultArtifact`）、独立 Web 页内浏览器通知与标准 Web Push 后台推送（VAPID + `aes128gcm`、`<appConfigDir>/web-push/` 持久化、显示 `tag` 与事件 `eventId` 分离及 Service Worker 有界持久化同事件去重/单次响铃/按 `taskId` 精确防打扰与 `userVisibleOnly` 同槽位保留或静音合并、主动打断 `completedInterrupted` 静默、PWA `manifest.webmanifest` 与点击通知优先回原发起页/非 Android 端信任 `client.focus()` resolve 客户端直投 `zcode:notification-click` 且 Android 端保留 `focused || visible` 兜底/纯 Push 仅复用同 `taskId` 页否则新开窗口/冷启动跨工作区会话定位，详见 [`standalone-web-notifications.md`](../standalone-web-notifications.md)）。
4. **服务端记忆、回复语言、项目数据清理、范围与设备文案及目录交互**：项目记忆目录展示与 Markdown 页内预览/编辑/保存、项目数据清理同时覆盖本地路径哈希记忆目录与 canonical 身份哈希记忆目录、服务端个性化指令（`AGENTS.md`）读写、独立 Web「设置 -> 行为与工具 -> 回复语言（`replyLanguage`）」服务端读写与空串清除（服务端 `node.ts` 同步刷新内存缓存并响应 CLI `session/readReplyLanguage`，手机远控保持显示“请在本机设置”）、`settings.scope.server`“当前服务器”文案（覆盖设置页范围选择与 `ProjectEditor`/`ProjectManagementRow`/`ProjectFolderTrustDialog`/`ProjectComposerMenu` 本地设备名）、从服务器目录添加插件来源、Web 区域 OAuth 返回路径修复、`.zcodeignore` 打开右侧文件栏定位项目根目录（已实现，未单列验收；技能详情打开路径维持撤回、独立 Web 暂不支持）。
5. **独立 Web MCP 服务端路由、插件管理进程空闲回收、Browser Use 受管 CDP 与 Node 统一发行包**：独立 Web “当前服务器”与项目 MCP 路由至服务端 Host 读写/启停/重连；`standalone-server` 为 `pluginProcessManager`（`plugin-management` lane）注入默认 5 分钟 `idleTimeoutMs` 自动回收并支持按需重拉起；独立 HTTP Server 接入官方受管无头 Chromium（`server-browser-control` -> `agent.browsers.*` 及 CLI 显式 `--browser-state`，普通 `closeSession` 保留上下文入有界空闲池，归档/删除/项目清理经 `closeTaskSessions` 彻底销毁）；`zcode` / `zcode --web` Linux 统一发行包按目标平台排除仅限 macOS/Windows 的 `computer-use` 插件（保留其余 16 个官方插件及 4 个办公文档插件新增的 `zcode_libreoffice.py` / profile 资产）、`bundled-skills` 随包组装及容器 `sha-<8位>` 标签发布。

### 1.2 4.0.0 数据库迁移、凭据强校验与回退限制

依据 [`docs/plans/2026-10-29-system-credential-storage.md`](../plans/2026-10-29-system-credential-storage.md) 与 4.0.0 数据库迁移机制：

- **4.0.0 CLI 会话库迁移（`0026_dwf_run_parent_session_index`）与跨版本回退约束**：4.0.0 在 CLI 会话数据库新增 `0026_dwf_run_parent_session_index` 索引迁移（`tasks-index.sqlite` 无新增迁移，凭据继续使用 `zcodeCredentialFormat: 2` / `v2` 格式）。升级至 4.0.0 后如需回退至 3.18.2 阶段镜像（如 `sha-cf6fa5df`），必须连同停机前一致性数据备份（如 `20261127T052402Z.tar.gz`）一并恢复，不得单纯切回旧镜像标签。
- **凭据密钥发现与强校验（`:99-104`）**：独立 Server / Docker Web 在开放 HTTP 服务前会初始化凭据后端；无系统 keyring 时支持以下任一方式提供 32–4096 字节只读随机文本密钥（按 UTF-8 文本原样读取、不 trim）：
  1. 未设置环境变量时，自动发现默认持久化路径 `<zcodeHomeDir>/v2/credential-secret`（容器默认 `/home/agent/.zcode/v2/credential-secret`，已有合规密钥文件时直接复用，无须额外设置 `ZCODE_CREDENTIAL_SECRET_FILE`）；
  2. 显式设置 `ZCODE_CREDENTIAL_SECRET` 或 `ZCODE_CREDENTIAL_SECRET_FILE`（二者不可同时设置）。
- **v2 密文与 3.17.2 旧版回退限制（`:46-63`）**：自 3.18.2 起启用 `zcodeCredentialFormat: 2`（v2 密文）。一旦写入或迁移生成 v2 密文，仅支持 v1 的 3.17.2 阶段镜像（如 `f40a4597` / `364e6c55`）无法读取 v2 密文（且旧版程序不具备 v2 版本门禁，不会自动安全阻止回滚），回退同样须整体恢复对应版本升级前的一致性数据备份。

---

## 2. 历史基线记录（3.18.2 与 3.17.2 阶段备查）

### 2.1 上游 3.18.2 阶段基线（2026-11-15 至 2026-11-21）

- 升级分支与合并链路：`sync/upstream-3.18.2`（PR #2，GitHub Actions 运行 `43569582003` `success`）合并至 `main` 生成 `ae58c92f`（GitHub Actions 运行 `43570424184` `success`），后续在 `main` 演进至 3.18.2 阶段最终线上基线 `cf6fa5df`（完整 SHA：`cf6fa5df86d74728da073a5329a36ebd655b622f`，GitHub Actions [`44908317953`](https://github.com/uselessbug/ZCode/actions/runs/44908317953) `success`，镜像 `sha-cf6fa5df`，digest `sha256:7d1f5846858e1a7a8d8a128f2c0a239e9aabaa38cb9ddc1233f480335156fbe1`，于 `2026-11-21T13:43:45Z` 部署，并在 4.0.0 升级前留下停机一致性备份 `20261127T052402Z.tar.gz`）。
- 3.18.2 阶段关键包含提交：
  - 上游合并提交：`347fd4ff`（合并上游 `fec97590` v3.18.2 与独立 Web 基线 `f40a4597`，共同祖先 `a9fe401e`）
  - 模型删除/保存反馈竞态修复：`454b2832`；CI 依赖安装竞态修复：`bf8c2105`；容器内置 Docker CLI / Compose 插件：`4e959bab`（Actions `43622140891`）
  - 3 项冗余参数/字段清理与独立 HTTP Web 官方 `browser-use` 受管 CDP 适配：`ce24c4cf`、`ab4ab3ac`（阶段发布基线 `29c3c4dc`，Actions `43723274317`）
  - 项目恢复 `restoreProject` 位置参数转换、记忆冲突重载专用标识与独立 Browser MCP 镜像/文案清理：`f643ee64`（Actions `43789255724`）
  - 系统主题 `meta[name="color-scheme"]` 兼容修复：`b9f0e517`（Actions `43795610757`）
  - 非桌面 Web 停用营销轮询、普通二进制与 >64K 文本附件修复、移除项目数据估算与清理、独立 HTTP 服务端定时任务 `automation-runtime` 执行链：`f4e9adb9`、`2d420913`、`844e62d6`、`e552c565`、`a18fe44a`（Actions `43860163049`）
  - 独立 Web 对齐官方桌面行为 8 项（附件 `<artifactId>/<安全化原文件名>` 具名落盘与桌面预读统一、项目数据双记忆命名空间覆盖、代码批注卡片、定时任务冻结目录快照放行、Browser Use 生命周期清理、0 目录项目懒创建生命周期、本地 Git 受管 Worktree、侧栏「显示文件树」）：`52c43e5a`、`520e37e9`、`9d3ef7b2`、`5d682dfd`（Actions `43917276559`）
  - 独立 Web 定时任务 path-only 工作区身份回归、非项目/`draft-*` 共享进程池与 `pluginProcessManager` 5 分钟空闲回收：`b8b71985`、`5759c882`（Actions `44167318739`）
  - 独立 Web 浏览器通知与后台推送（Web Push）：`7a72f272`、`d20c7f4c`、`71149de2`（Actions `44247679952`）
  - 通知点击跳转、多标签协同、首屏零横幅直出与移除工作台重复重连横幅、无项目失效草稿自动换绑恢复、项目设备名称“当前服务器”：`c4a71467`（Actions `44301991974`）、`0ebadad9`（Actions `44336551515`）
  - 无项目草稿与附件恢复预热、页面本地导航隔离、手机端准备完成后切入 `Chat`、同事件通知去重与原页/纯 Push 路由、终端页面作用域隔离：`284c4e62`、`0ac5d891`（Actions `44587175500`）
  - 桌面多进程 Firefox 后台标签页通知点击聚焦修复：`cf6fa5df`（Actions `44908317953`）

### 2.2 3.17.2 阶段历史基线（2026-11-12 至 2026-11-13）

- 仓库：`uselessbug/ZCode`，分支：`main`（基于 v3.17.2）
- 3.17.2 阶段改动前远端 `main`：`364e6c55`（完整 SHA：`364e6c551a0ec0680488e558bf01459da555e1e1`，`feat(web): enable server personalization settings`）
- 3.17.2 阶段适配收口提交：`f40a4597`（`docs(maintenance): record standalone MCP deployment acceptance`）
- 升级 3.18.2 / 4.0.0 后的回退须遵守上方 1.2 节数据库迁移与凭据格式限制。

## 关联文档

- [独立 Web 与移动端适配问题清单](./issues.md)
- [独立 Web 部署与实机验证清单](./standalone-web-deployment-checklist.md)
- [独立 Web 浏览器通知与后台推送](../standalone-web-notifications.md)
- [定时任务服务端执行链](../standalone-web-automation-runtime.md)
- [系统安全存储与凭据迁移计划](../plans/2026-10-29-system-credential-storage.md)
- [多 root 项目与任务移动](../standalone-web-multi-root-projects.md)
- [设置页服务边界与手机布局](../standalone-web-settings.md)
- [Node 统一发行包规格](../../specs/zcode-unified-distribution.md)
