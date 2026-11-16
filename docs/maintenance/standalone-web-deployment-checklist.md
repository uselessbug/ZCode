# 独立 Web 部署与实机验证清单

- 关联入口：[独立 Web 与移动端适配问题清单](./issues.md) · [独立 Web 实施基线](./standalone-web-baseline.md)

## 1. 上游 3.18.2 升级基线、部署要求与验证清单

- **固定基线与当前状态**：线上当前实际运行版本为 `a18fe44a`（`sha-a18fe44a`），前一批 4 项修改（移除项目数据估算与清理、普通二进制上传与 >64K 文本落盘、独立 HTTP 服务端定时任务执行链、非桌面 Web 停用营销轮询）已通过 GitHub Actions [`43860163049`](https://github.com/uselessbug/ZCode/actions/runs/43860163049) `success` 发布并于 `2026-11-16T11:59:45.181Z` 完成容器自更新与运行探针校验；2026-11-16 用户已在页面实测 `.docx` 附件上传与解析成功，在此基础上完成的桌面行为对齐更新已提交，待 CI 构建与部署验收。早前 `b9f0e517` 主题兼容修复已由用户确认自动跟随恢复（切换时页面重载与重连横幅另行追踪），`f643ee64` 部署的 `restoreProject` 项目恢复已于 2026-11-16 经用户页面实操与容器运行日志验证通过。具体证据见下方及 [standalone-web-baseline.md](./standalone-web-baseline.md)。
- **3.18.2 凭据密钥部署要求与步骤说明（保持上游强校验，参见 [`docs/plans/2026-10-29-system-credential-storage.md`](../plans/2026-10-29-system-credential-storage.md)）**：
  - **启动约束与默认路径自动发现（`:99-104`）**：独立 Web HTTP 服务在开放前会初始化凭据后端。无系统 keyring 的部署环境支持：
    - **默认路径自动发现**：当未设置 `ZCODE_CREDENTIAL_SECRET` 与 `ZCODE_CREDENTIAL_SECRET_FILE` 时，服务端按 UTF-8 自动读取 `<zcodeHomeDir>/v2/credential-secret`（容器默认 `/home/agent/.zcode/v2/credential-secret`，32–4096 字节随机文本密钥，权限 `0600`，属主为容器运行 UID `1001`）。若持久化目录中已存在合规的默认密钥文件，直接沿用上游自动发现即可，无须补设 `ZCODE_CREDENTIAL_SECRET_FILE`。
    - **显式环境变量注入**：若使用自定义路径或环境变量，可显式提供 `ZCODE_CREDENTIAL_SECRET_FILE` 或 `ZCODE_CREDENTIAL_SECRET`（二者不可同时设置，32–4096 字节 UTF-8 随机文本密钥，按原样读取、不 trim）。
  - **密钥准备与回退限制**：
    1. **升级前一致性备份**：在拉取并启动 3.18.2 镜像前，先对整个持久化数据目录（包含 SQLite 数据库、凭据目录与 `v2/credential-secret` 等全部状态）做一致性备份。
    2. **排他准备密钥文件（确保容器运行 UID 可读且绝不覆盖已有密钥）**：若默认路径 `/home/agent/.zcode/v2/credential-secret`（或自定义挂载路径）尚不存在密钥文件，以排他创建方式写入 32–4096 字节 UTF-8 随机文本密钥（`umask 077`，属主设为容器运行用户 UID `1001`，权限设为 `0600`；已有密钥文件必须直接复用，绝不覆盖）。
    3. **密钥留存与回退限制（`:46-63`）**：妥善保留并备份该密钥文件；3.18.2 写入或迁移生成 `zcodeCredentialFormat: 2`（v2 密文）后，仅支持 v1 的 3.17.2 旧版镜像（`f40a4597` / `364e6c55`）无法读取 v2 密文（且旧版程序不会自动安全阻止回滚）。因此**不能仅靠切回旧镜像标签或仅恢复 `credentials.json` 回退**；如需回退旧镜像，须核对 SQLite 数据库迁移差异并整体恢复升级前的一致性数据备份。
- **本轮 3.18.2（`4e959bab`）本地与 CI 已通过校验**：
  - `node --test scripts/zcode-distribution.test.mjs`：11 项通过。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-multi-root-projects.mjs`：7 项通过。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-memory-files.mjs`：5 项通过。
  - `node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-mcp-routing.mjs`：13 项通过（容器构建校验工作流已同步接入该项）。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-archived-deletion-carrier.mjs`：3 组通过（验证真实 Host + stub CLI 路由：cold owner 路由至管理进程、hot 路由至原 CLI、foreign/path/`remoteSessionId` 等 5 类非法目标 × preview/execute 共 10 次请求全部拒绝且无 fallback）。
  - 设置页模型删除/保存反馈竞态真实 UI 浏览器回归（修复提交 `454b2832`）：15 项全部通过（15 pass / 0 fail；修复前 14 项基线用例中 11 fail / 3 pass，经 token 变异验证同 key 与跨卡片 3 项用例失败检出后已还原）。
  - 架构检查（相对 `fec97590` 新增违规为 0）与定向 `lint`（0 errors，含上游既有 warnings）通过。
  - GitHub Actions 远端构建与发布：PR #2 运行 `43569582003`、`main` 运行 `43570424184` 与 `4e959bab` 运行 `43622140891` 全部 `success`（已发布 `latest` 与 `sha-4e959bab`）。
- **已完成容器部署与实机验收（2026-11-15）**：
  - [x] **3.18.2（`4e959bab`）容器启动、鉴权与 WebSocket 基础探针**：容器状态 `healthy`（`restarts: 0`），默认 `v2/credential-secret`（64B、`0600`、UID `1001`）自动发现生效；HTTP 首页返回 `200`，鉴权 `serverinfo` 返回 `200`、未授权请求返回 `401`，WebSocket 握手通过；检查运行日志 5446 行无启动失败、凭据错误、`Unknown channel`、未捕获异常或 OOM 等关键错误。
  - [x] **归档任务删除端到端与实机验证（3.18.2 用户可见变化）**：2026-11-15 用户实机执行归档任务永久删除确认正常；运行日志同步确认 `zcode-task.previewArchivedTaskDeletion`（`2026-11-15T14:00:51.756Z`，`OK 1051ms`）与 `zcode-task.permanentlyDeleteArchivedTask`（`2026-11-15T14:00:56.749Z`，`OK 1143ms`）均成功完成且无对应失败（未声称做独立磁盘逐文件审计）。
  - [x] **设置页删除/保存模型反馈实机验证**：2026-11-15 用户实机确认模型保存与删除提示正常。
  - [x] **移动端、重连与工作区交互实机确认**：2026-11-15 用户实机确认实体手机重连未见明显问题，手机工作区与 `compact-web` 新版设置页、手机子代理设置、权限确认弹窗、新建技能/插件试用预填跳转聊天页、任务分组、新建项目目录选择（默认 `/workspace`）以及任务工作区归属均正常。
- **已完成 `29c3c4dc` 部署、Browser Use 实测及独立 Browser MCP 移除进展（2026-11-15）**：
  - **统一 CI 与发布产物证据**：提交链 `ce24c4cf`（3 项冗余参数/字段清理）→ `ab4ab3ac`（独立 HTTP Web `browser-use` 受管 CDP 接线）→ `29c3c4dc`，GitHub Actions 运行 [`43723274317`](https://github.com/uselessbug/ZCode/actions/runs/43723274317) `success`（`typecheck`、`lint`、架构检查、`ci-browser` Browser Use 真实 Chromium 回归、ARM64 发行镜像构建、native 工具、随包资源与 HTTP 鉴权探针全部通过），发布镜像 `latest` 与 `sha-29c3c4dc`（digest `sha256:afef497a850fb3424f125be498badc2206e818eb301349b6c5d0508b2e007b00`）。
  - [x] **`29c3c4dc` 容器部署、健康探针与 3 项冗余代码清理生效**（代码 `ce24c4cf`）：线上容器核实运行源码 `29c3c4dc0ecfe54b640b40a332a97862619787af`，状态 `healthy`（`restarts: 0`），HTTP 首页 `200`、鉴权 `serverinfo` `200` / 未授权 `401`、WebSocket 握手通过，检查启动日志 70 行无匹配关键错误；移除 `rootStartupGate` 未使用 `providerStartupSyncPending` 参数、`ConversationTimeline` 废弃 `compactForRemoteControl` 属性、`scripts/zcode-distribution/assets.mjs` 未使用 `version` 字段均已随镜像部署生效。
  - [x] **独立 HTTP Web 官方 `browser-use`（`agent.browsers.*`）线上部署与网页访问/读取验证**（代码 `ab4ab3ac`，规格见 [`docs/standalone-web-browser-use.md`](../standalone-web-browser-use.md)）：在线上会话中经 `browser-use` 技能 -> `mcp__node_repl__js` -> `agent.browsers` 成功访问 `https://example.com/`，读取标题 `Example Domain`、多语正文及 `Learn more` 链接 `https://iana.org/help/example-domains`，用户确认“看起来没问题”（本轮仅验证访问与读取，其余交互不扩称为已全部线上验收）。
  - [x] **移除当前服务器用户级 `browser` MCP 配置并复测 `browser-use`**：按用户授权从 `/home/agent/.zcode/cli/config.json` 删除 `mcp.servers.browser`，保留 `mcp.servers.rea` 与官方 `browser-use` 插件；删除后重新通过 `browser-use` 运行时列出原 `example.com` 标签并读取 `title`、`url` 与 `domSnapshot`（`Example Domain`、正文及 `Learn more` 链接）成功，确认配置移除不影响官方 `browser-use` 网页读取。新会话不再按此配置加载 `browser` MCP；现有存量会话已运行的 `playwright-mcp` 进程与工具目录不立即热卸载，随会话重载自然释放，无须为此重启服务或强杀其他会话。
- **已完成 `f643ee64` CI 发布、容器部署与回归探针（2026-11-16）**：
  - **CI 与镜像发布证据**：提交 `f643ee64`（完整 SHA：`f643ee6465143c583bd741047c08634231c4ba89`）已推送 `main`，GitHub Actions 运行 [`43789255724`](https://github.com/uselessbug/ZCode/actions/runs/43789255724) 全部作业 `success`（全量类型检查、lint、架构检查、Browser Use 回归与 ARM64 发行镜像契约校验通过），发布镜像 `latest` 与 `sha-f643ee64`。
  - [x] **容器更新与持久化探针（`2026-11-16T02:10:54Z`）**：本地源码与运行容器已更新至 `f643ee6465143c583bd741047c08634231c4ba89`，`docker inspect` 状态 `healthy`（`restarts: 0`），独立部署 helper 容器 `exited 0`；探针确认 HTTP 首页 `200`、鉴权 `serverinfo` `200`、未授权请求 `401`、WebSocket 握手 `pass`，`credential-secret` 与 provider 配置指纹保持不变。
  - [x] **独立 Browser MCP 完整移除与新镜像线上 Browser Use 实测通过**：线上容器探针确认 `/opt/browser-mcp` 不存在、配置中 `browser` MCP 不存在、官方 `browser-use` 插件保持开启、发行包 `playwright-core` 可用；`Dockerfile` `/opt/browser-mcp` 安装步骤、专属 CI 探针与设置页中英文旧文案已随 `f643ee64` 发布与镜像部署清理生效（验收脚本已独立更新为复用发行包 `playwright-core`）。在新运行 `f643ee64` 容器中经 `browser-use` 技能 -> `agent.browsers` 列到新受管 CDP，实际打开 `https://example.com/` 并等待 `domcontentloaded` 后成功读取标题 `Example Domain`、多语正文与 `Learn more` IANA 链接。
  - [x] **记忆冲突重载专用标识（`settings-memory-reload`）部署与组件 fixture**：冲突重载改用 `TID_SETTINGS_MEMORY_RELOAD`（`settings-memory-reload`），列表刷新保留 `settings-memory-refresh`，已随 `f643ee64` 部署；真实前端组件 fixture（`MemorySettingsViewer` + `ConfirmDialogHost`）通过冲突流程、标识唯一、取消保留草稿与确认加载外部最新文件（旧标识变异如期检出）；整条 Electron WDIO 套件未运行。
  - [x] **`restoreProject` 项目恢复（2026-11-16 实机交互与日志验收通过）**：`packages/server/src/http.ts` 补齐 `restoreProject` 位置参数转换并随 `f643ee64` 部署上线。2026-11-16 用户在独立 Web 先从「已移除的项目」恢复旧版本移除的项目，随后连续操作两次「移除 → 恢复 → 移除」；服务端容器运行日志确认 4 次 RPC 全部成功且无 `project.host-offline`：`2026-11-16 15:10:38 project.restoreProject OK (11.9ms)`、`15:10:42 project.deleteProject OK (6.9ms)`、`15:10:45 project.restoreProject OK (7.2ms)`、`15:10:48 project.deleteProject OK (6.5ms)`。同次操作日志暴露移除弹窗预估数据报 `project.measureProjectData FAIL Error: project.data-local-only`，已作为独立问题在 `a18fe44a` 完成源码修改并部署上线（见第 4 节）。

- **系统主题兼容修复 `b9f0e517`（2026-11-16）**：
  - GitHub Actions [`43795610757`](https://github.com/uselessbug/ZCode/actions/runs/43795610757) 全部成功并发布 `sha-b9f0e517`；完整类型、lint、架构、主题与 Browser Use 浏览器回归、发行包和服务启动检查通过。
  - 主题回归覆盖普通规则 10 组、Nightly 单值 meta 覆写模拟 9 组，共 19 组通过；修复前代码在模拟下复现暗→浅不变及刷新仍暗，修复后正常。2026-11-16 用户确认 Android Firefox Nightly 自动跟随已恢复；另补充确认切换时伴随页面重载、加载条与重连横幅，单独在 [issues.md](./issues.md) 追踪。
  - 已部署源码 `b9f0e517457179eef35cd8112923fbeda7659b5f`，容器 `healthy`、`restarts: 0`。`2026-11-16T03:17:57Z` 探针确认 HTTP `200`、鉴权 `200` / 未授权 `401`、WebSocket 通过，凭据和 Provider 配置指纹不变，页面 `color-scheme` meta 为 `light dark`；启动日志 300 行未匹配关键错误。

- **已完成 `a18fe44a` CI 发布、容器部署与运行探针（2026-11-16）**：
  - **CI 与镜像发布证据**：提交 `a18fe44a`（完整 SHA：`a18fe44a5d0f3eadd7af630c854350952340e90c`，包含 `f4e9adb9` 停用非桌面营销轮询、`2d420913` 普通二进制与大文本附件修复、`844e62d6` 独立 Web 项目数据估算与清理、`e552c565` + `a18fe44a` 独立 HTTP 定时任务 `automation-runtime` 执行链及 `da4511a5` 项目恢复验收记录），GitHub Actions 运行 [`43860163049`](https://github.com/uselessbug/ZCode/actions/runs/43860163049) `success`，发布镜像 `latest` 与 `sha-a18fe44a`（digest `sha256:b05def7328ed9ee88da4d21fd9fe60a55e1009298737fb433f5e9d8f44f98da9`）。
  - [x] **容器自更新与运行探针（`2026-11-16T11:59:45.181Z`）**：独立后台 `docker:cli` helper 容器（`--rm`）于 `2026-11-16T11:59:46Z` 完成并退出码 `0`；`ai-agent-zcode-1` 状态 `running`、`healthy`、`restarts: 0`，运行镜像 `org.opencontainers.image.revision` 核实为 `a18fe44a5d0f3eadd7af630c854350952340e90c`；HTTP 首页 `200`、鉴权 `/api/server-info` `200`、未授权 `/api/server-info` `401`、WebSocket 握手 `pass`、`credential-secret` 与 `provider_config.json` SHA-256 指纹不变、首页双值 `color-scheme` meta 为 `true`、`/opt/browser-mcp` 目录不存在。

---

## 2. 历史基线、构建产物与回退记录（3.17.2 阶段，截至 `f40a4597`）

- **3.17.2 阶段回退基线**：3.17.2 适配周期改动前远端 `main` 基线为 `364e6c55`（完整 SHA：`364e6c551a0ec0680488e558bf01459da555e1e1`，提交说明：`feat(web): enable server personalization settings`），3.17.2 阶段收口提交为 `f40a4597`，已记录于 [standalone-web-baseline.md](./standalone-web-baseline.md)。
- **3.17.2 阶段本地已通过校验记录（脚本当前入口已迁至 `packages/web/test/e2e/remote-control/projects/manual-review/pending/`）**：
  - `node --test scripts/zcode-distribution.test.mjs`：10 项通过（3.18.2 已扩展为 11 项通过，见第 1 节）。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-multi-root-projects.mjs`：7 项通过（多 root 增删、任务移动缺 root 确认与增补、普通远端单 root 门禁、跨 Host 拒绝）。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-memory-files.mjs`：5 项通过（项目记忆读取与保存、权限保留、乐观并发冲突拒绝、越界与超限拦截）。
  - `node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-mcp-routing.mjs`：13 项非 GUI 运行时回归通过（真实模块 + 临时 `HOME`，覆盖独立 Web base Host 读写/启停、首屏 pending fail-closed 与 0 写入、同 base wrapper 并发不误取消、`setMcpStorePlatform` 换绑丢弃旧结果、跳过浏览器旧 `localStorage` 迁移与手动迁移 no-op、Desktop 本机迁移及跨 Host 远端 fail-closed；历史日志 `/home/agent/.local/state/zcode-mcp-validation-UonqMRyk/runtime-final.log`）。
  - 2026-11-13 提交前本地校验记录：`pnpm architecture:check --changed` 通过，改动文件格式检查通过，根级 `pnpm lint` exit 0（含既有 warnings）；根级 `pnpm typecheck` 在当前环境因缺少全量 workspace/node 类型依赖 exit 2；提交时尚未在本地执行 GUI / CI 镜像构建（后续用户已部署并实机验证通过第 7 项，见下文）。
- **CI 构建与镜像标签约定**：
  - 完整打包与镜像构建统一由 GitHub Actions 执行，不要求扩容本地构建内存；部署只使用 GitHub Actions 在目标提交上成功构建出的镜像。
  - 镜像工作流 `sha-<8位>` 标签接线已完成；PR 仅执行构建与校验（不推送发布镜像），推送 `main` 后由 GitHub Actions 构建并发布对应提交镜像。
- **3.17.2 阶段回退与 3.18.2 升级后回退区别**：在 3.17.2 阶段内回退可切回 `364e6c55` / `f40a4597` 对应 `sha-<8位>` 镜像并保持持久化数据目录挂载不变；但若升级至 3.18.2 并写入 v2 凭据密文或执行新版 SQLite 迁移后，旧版镜像无法读取 v2 密文且不会自动安全阻止回滚，必须按第 1 节要求恢复升级前的一致性完整数据备份。

## 3. 3.17.2 阶段已实机验证项记录（7 项，保持历史验收状态）

### (1) 项目多目录保存/编辑与任务移入、跨项目移动（2026-11-12 实机验证通过）

- **实机验证结果（2026-11-12）**：已通过。用户反馈项目添加/编辑多个目录、将无项目任务移入项目及跨项目移动均正常。
- **关于“任务移出项目”的说明**：桌面端与服务端共享设计中，任务一旦归属项目只支持移动到其他项目（`ProjectSidebarNode` 仅展示目标项目列表，后端 `moveTask` 的 `projectId` 为必填非空字符串并校验 `requireProject`，无置 `null` 分支）；“不在项目中工作”仅用于新建无项目会话草稿，不支持将已有项目内任务移出为无项目状态，非独立 Web 缺陷。

### (2) 项目记忆 Markdown 页内预览、编辑保存与冲突保护（本仓新增，2026-11-12 实机验证通过）

- **实机验证结果（2026-11-12）**：已通过。官方原有记忆设置仅提供列表与调用外部编辑器（无删除接口）；本仓本轮新增页内 Markdown 预览、编辑与保存，进入「设置 -> 记忆」点击记忆文件即可在网页弹窗内预览、编辑并保存。
- **关于列表菜单操作**：用户确认后端无 delete 接口则不做删除功能（需删除时让对话 Agent 删除，尽量少改后端），已取消新增 delete API 需求；列表项直接“编辑”菜单暂不做（若未来需要再另行评估）。

### (3) 技能详情“打开路径”（已撤回适配，Web 暂不支持）与 `.zcodeignore`「打开文件位置」（已实现保留）

- **3.1 技能详情“打开路径”（已撤回适配；独立 Web 暂不支持，不计为已修复）**：
  - **实机表现**：点击技能路径后能打开右侧「文件管理」栏，但无法定位到技能目录。
  - **已确认根因**：文件树仍以当前项目为根，技能目录在项目外，因而定位被跳过。
  - **回退结论**：`SkillsSection` 已撤回适配，仅将技能路径打开退回原本地文件管理器调用与失败提示，并撤回无项目时的目录浏览弹窗；独立 Web 下技能打开路径暂不支持（不记为功能已修复，不再单独追踪待验证）。技能页“当前服务器”范围文案及其他改动保留。
- **工作区文件搜索 `.zcodeignore`「打开文件位置」（已实现，未单列验收）**：
  - `WorkspaceFileSearchSection` 中「打开文件位置」定位的就是当前项目根目录本身，不存在跨出项目根目录的问题，保留打开右侧「文件管理」栏（用户未单列验收，不作为阻断或待反馈项）。

### (4) 从服务器目录添加插件来源（2026-11-12 实机验证通过）

- **实机验证结果（2026-11-12）**：已通过。用户确认在「插件市场 -> 添加来源」中点击「选择目录」可正常浏览并选择服务器上的插件源目录完成添加。

### (5) 设置页配置范围“当前服务器”文案（2026-11-12 已修复）

- **实机反馈结果（2026-11-12）**：用户已确认修改生效。
- **实际改动范围**：新增 `settings.scope.server`（“当前服务器” / `Current server`），未改动既有 key。独立 Web 下 `PluginScopeMenu`（插件、技能、命令、Hooks、子代理、MCP 共用）中当前服务器承载的“本机”、“用户”及“本机 · 用户”触发器统一显示为“当前服务器”，技能页“个人 / 用户”显示为“当前服务器”；其他远端设备分组仍保留其设备名与“用户”标签，记忆页项目选择器未改动，个性化指令此前已是服务端说明。

### (6) 内置 `skill-creator` 默认加载与动态工作流资源（`dynamic-workflows`）随包就绪（2026-11-12 实机验证通过）

- **实机验证结果（2026-11-12）**：已通过。用户确认内置官方插件与内置技能资源均齐全可用。

### (7) 独立 Web 设置页“当前服务器”与项目 MCP 读写、启停与重连（2026-11-13 用户部署实机验证通过）

- **实机验证结果（2026-11-13）**：已通过。用户部署后确认独立云端 Web「设置 -> MCP」中“当前服务器”已安装列表为空（`已安装 0`、`browser` / `rea` 不显示）问题已修复完成。
- **后续回归关注要点**：
  - 在“当前服务器”与具体项目间切换，用户级 MCP（如 `rea`；历史验收时含已移除的 `browser`）与项目级 MCP 在“已安装”分组正常展示并刷新连接状态。
  - 新增、编辑、删除、启停 MCP 持久化到当前服务器，刷新页面或重连后保持；首次加载不闪现假空列表；Desktop 本机、手机 `/remote` 与跨 Host 远端行为不退化。

## 4. 已提交待 CI 构建与部署验收、已部署线上项、暂缓项与内部小项

- **已提交，待 CI 构建与部署验收（桌面行为对齐）**：
  - [ ] **附件原文件名落盘与桌面 `readTextFileForModel` 预读统一**：上传普通文件与长粘贴在会话附件目录内改为 `<artifactId>/<安全化原文件名>` 子目录原子落盘（保留中文、空格等原文件名，使模型路径与 `::zcode-file-citation` 芯片显示真实原名，兼容新旧读取/统计与顶层条目保留匹配）；普通上传文本删除自建 64 KiB 硬切分，统一复用桌面 `resolveLocalFileAttachment` / `readTextFileForModel`（256 KiB + 25k token 预读、`.json` 等统一带 `source` 附件提醒，保留双 `zcode-artifact://` URI）。本地 `standalone-cli-attachment-materialization.mjs` 与 CLI 单测通过。
  - [ ] **项目数据双记忆命名空间覆盖**：`project-data` 同时估算与清理独立 Web 本地路径哈希记忆目录（`<slug>-<hash>/memory`）与 canonical 身份哈希记忆目录（`project-<hash>/memory`），避免本地路径会话记忆漏估漏删。本地 `standalone-project-alias.mjs` 回归通过。
  - [ ] **独立 Web 开启代码批注卡片**：`packages/web/src/main.tsx` `<Root>` 补传 `assistantCodeCommentCardsEnabled`。
  - [ ] **定时任务已冻结目录快照放行**：进程内可信标记放行已持久化的定时任务目录快照，项目编辑或清空 `roots` 后仍按原快照创建会话。本地 `standalone-automation-runtime.mjs` 回归通过。
  - [ ] **Browser Use 普通释放保留上下文与归档/删除生命周期清理**：普通 `closeSession` 仅释放租约并将 `BrowserContext`/页面/Cookie 保存在有界空闲池供后续恢复；归档、自动归档、删除、永久删除及项目数据清理（含已删 `owned` 子会话）统一经 per-`sessionKey` 串行队列触发 `closeTaskSessions` 彻底销毁上下文（真实 Chromium `verify-standalone-browser-use.mjs` 18/18 通过）。
  - [ ] **0 目录新建与清空目录对齐桌面生命周期**：支持保存与编辑清空为 `0` 个目录、恢复干净默认项目名，首次 `prepareSession` 懒创建 `/workspace/.zcode/workspace/<projectId>`；无项目草稿目录保持 `/workspace/.zcode/conversations/draft-<id>`，新建/编辑项目目录浏览默认起点保持 `/workspace`。本地 `standalone-multi-root-projects.mjs` 回归通过。
  - [ ] **当前服务器本地 Git 受管 Worktree 全链路打通**：服务端、`/api/server-info`（`capabilities.managedWorktrees`）与前端入口协同放行，受管 Worktree 落盘在 `/workspace/.zcode/worktrees`，补齐真实 `worktreeRemovalGate` `readTaskCwd`、Browser Use 归属归一及归档 Worktree 任务永久删除路径对齐（`standalone-managed-worktree.mjs` 真实 Git 验收通过）。
  - [ ] **任务菜单「显示文件树」与隐藏无效配置入口**：侧栏任务菜单调用官方 `openTaskFiles` 打开右侧文件栏，隐藏无效的「前往 Provider 配置」（`standalone-desktop-parity-ui.mjs` 26 项通过）。
- **已部署（`a18fe44a`），线上运行中（4 项；GitHub Actions [`43860163049`](https://github.com/uselessbug/ZCode/actions/runs/43860163049) `success`，镜像 `sha-a18fe44a`，`2026-11-16T11:59:45.181Z` 容器与接口探针通过，2026-11-16 用户已实测 `.docx` 附件上传与解析成功）**：
  - [ ] **移除项目时无法估算与清理当前服务器项目数据**：补齐 `packages/server/src/http.ts` 对 `measureProjectData`、`deleteProjectData` 的位置参数 Host 别名转换；仅在 `standalone-server` 且开启独立 Web 兼容配置时放行当前服务器 `ownerHostId`（跨 Host 与普通远端仍报 `project.data-local-only`）；同时覆盖本地路径哈希记忆目录与 canonical 身份哈希记忆目录，并复用严格会话删除载体（优先命中热运行工作区 CLI 保护 `busy` 会话，仅在 `ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE` 且归属本服务器时回落管理面进程）。本地 `standalone-project-alias.mjs` 回归通过。
  - [x] **普通二进制文件分块上传与大文本落盘（用户已实测 `.docx` 上传解析成功，进一轮具名落盘与桌面预读对齐见上方待 CI 部署项）**：前端对无 `localPath` 的普通文件统一按真实字节走 V4 `begin/chunk/commit` 分块上传（上限 20 MiB，支持 0 字节文件，超限抛 `OversizedInlineFileAttachmentError` 提供 5 语言提示并补齐图片超限本地化，移除前端 64K 字符截断）；`a18fe44a` 部署后用户实测 `.docx` 上传与解析成功。本地 `standalone-attachment-upload.mjs`（16 项）与 `standalone-cli-attachment-materialization.mjs` 回归通过。
  - [ ] **独立 HTTP 服务端定时任务缺少到期调度与立即运行执行链**：新增受管模块 `packages/services/src/automation-runtime`，提取并由 Desktop 与独立 HTTP 共享 20s 到期轮询、5min misfire 跳过、按 `runId` 幂等结算、单飞 manual claim 与 60s 心跳续租、统一变更 `wake` 及先排空在途派发再关库的优雅关闭；修复 `standalone-server` 下新建及会话内 `CronCreate` 的服务器 `hostId` 与 canonical `workspaceIdentity` 固化，启动对齐采用无批量迁移副作用的只读 canonical 查询（保护同路径异域定义不被改写）；仅在 `entry-http.ts` 显式启用执行链。本地 `standalone-automation-runtime.mjs` 回归通过。
  - [ ] **非桌面 Web 停用 Z.ai 营销／活动轮询（冗余清理）**：`MarketingTouchProvider` 在非桌面入口（`!desktop`）直接返回空上下文，不创建营销 runtime/poller、不挂载 `MutationObserver`、不发起 `marketing-touch.query` 请求，消除自托管 Web 下的无用轮询与重复 `ZodError` 日志。本地 `standalone-attachment-upload.mjs` 挂载对照通过。
- **待定位（1 项）**：
  - Android Firefox Nightly 自动切换系统主题时页面重载并出现重连横幅。
- **暂缓 / 暂不做**：
  - 设置页“记忆”列表项菜单直接“编辑”入口（暂不做，页内点击查看与编辑已可用）。
  - 依赖宿主专属容器的插件自定义交互页（UI Plugin）独立 Web 承载（暂缓，低优先级）。
- **内部工程小项（非用户故障）**：记忆列表刷新与冲突重载测试标识分离已随 `f643ee64` 部署，真实组件 fixture 通过，整条 Electron WDIO 未运行（见第 1 节与 [issues.md](./issues.md)）。
