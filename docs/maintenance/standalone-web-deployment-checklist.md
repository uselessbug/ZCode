# 独立 Web 部署与实机验证清单

- 关联入口：[独立 Web 与移动端适配问题清单](./issues.md) · [独立 Web 实施基线](./standalone-web-baseline.md)

## 1. 上游 3.18.2 升级（`sync/upstream-3.18.2`）基线、部署要求与验证清单

- **固定基线与当前状态**：工作分支 `sync/upstream-3.18.2`，上游合并提交 `347fd4ff`（合并上游 `fec97590` v3.18.2 与升级前 `main` 基线 `f40a4597`，共同祖先 `a9fe401e`），模型反馈竞态修复提交 `454b2832`；本地非 GUI 回归与 15/15 真实浏览器回归已通过（PR 基线架构检查新增违规为 0），尚未推送远端、尚未执行 GitHub Actions 构建、尚未实机部署。
- **3.18.2 凭据密钥部署要求与步骤说明（保持上游强校验，当前尚未配置，参见 [`docs/plans/2026-10-29-system-credential-storage.md`](../plans/2026-10-29-system-credential-storage.md)）**：
  - **启动约束（`:99-104`）**：独立 Web HTTP 服务在开放前会初始化凭据后端（隔离探针仅验证真实 cipher wrapper 初始化：无 keyring 且未配置密钥时凭据初始化失败，配置合成密钥时凭据初始化通过，非完整 HTTP 服务启动实测；CI 校验使用合成测试密钥）。无系统 keyring 的部署环境须显式提供 `ZCODE_CREDENTIAL_SECRET_FILE` 或 `ZCODE_CREDENTIAL_SECRET`（二者不可同时设置，32–4096 字节，按原字节读取、不 trim）。
  - **支持的密钥文件部署示例（`ZCODE_CREDENTIAL_SECRET_FILE`）**：
    1. **升级前一致性备份**：在拉取并启动 3.18.2 镜像前，先对整个持久化数据目录（包含 SQLite 数据库、`credentials.json` 所在凭据目录等全部状态）做一致性备份。
    2. **排他准备并挂载密钥文件（确保容器运行 UID 可读且绝不覆盖已有密钥）**：在宿主机持久化路径确认密钥文件不存在后，以排他创建方式写入 32–4096 字节随机密钥（`umask 077`，属主设为容器运行用户 UID `1001`，权限设为 `0600`，避免使容器 UID `1001` 无法读取的 `root:root 0400`；已有密钥文件必须直接复用，绝不覆盖），再以只读方式挂载到容器内并设置 `ZCODE_CREDENTIAL_SECRET_FILE=<容器内挂载路径>`（或显式注入 `ZCODE_CREDENTIAL_SECRET`）。
    3. **密钥留存与回退限制（`:46-63`）**：妥善保留并备份该密钥文件；3.18.2 写入或迁移生成 `zcodeCredentialFormat: 2`（v2 密文）后，仅支持 v1 的 3.17.2 旧版镜像（`f40a4597` / `364e6c55`）无法读取 v2 密文（且旧版程序不会自动安全阻止回滚）。因此**不能仅靠切回旧镜像标签或仅恢复 `credentials.json` 回退**；如需回退旧镜像，须核对 SQLite 数据库迁移差异并整体恢复升级前的一致性数据备份。
- **本轮 3.18.2 本地已通过校验**：
  - `node --test scripts/zcode-distribution.test.mjs`：11 项通过。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-multi-root-projects.mjs`：7 项通过。
  - `pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-memory-files.mjs`：5 项通过。
  - `node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-mcp-routing.mjs`：13 项通过（容器构建校验工作流已同步接入该项）。
  - `node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-archived-deletion-carrier.mjs`：3 组通过（验证真实 Host + stub CLI 路由：cold owner 路由至管理进程、hot 路由至原 CLI、foreign/path/`remoteSessionId` 等 5 类非法目标 × preview/execute 共 10 次请求全部拒绝且无 fallback；注：本项仅验证 Host 路由，未实测 CLI 物理擦除、revision 或 incomplete 分支）。
  - 设置页模型删除/保存反馈竞态真实 UI 浏览器回归（修复提交 `454b2832`）：15 项全部通过（15 pass / 0 fail；修复前 14 项基线用例中 11 fail / 3 pass，经 token 变异验证同 key 与跨卡片 3 项用例失败检出后已还原）。
  - 架构检查（相对 `fec97590` 新增违规为 0）与定向 `lint`（0 errors，含上游既有 warnings）通过。
- **待完成验证项（尚未推送 / 尚未执行 CI / 尚未实机部署）**：
  - [ ] **归档任务删除端到端与实机验证（3.18.2 用户可见变化）**：采用上游 3.18.2 官方「归档预检 + 二次确认永久删除」，本地仅完成 Host carrier 路由 3 组校验；CLI 物理擦除及网页端归档预检、二次确认永久删除、刷新/重连不复活待部署后实机验证。
  - [ ] **设置页删除/保存模型反馈实机验证**：本地 15 项浏览器回归已通过，待镜像部署后实机确认。
  - [ ] **远端 CI 构建校验与独立 Web 实机回归**：待推送升级分支并创建 PR 先执行构建与自动化校验，合并至 `main` 发布镜像后再执行实机部署验收。

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

### (3) 技能详情“打开路径”（3.1 实机验证未通过 -> 已撤回适配，待新版部署验证）与 `.zcodeignore`「打开文件位置」（单列保留）

- **3.1 技能详情“打开路径”（已撤回适配，待新版部署验证；Web 暂不支持）**：
  - **实机表现**：点击技能路径后能打开右侧「文件管理」栏，但无法定位到技能目录。
  - **已确认根因**：文件树仍以当前项目为根，技能目录在项目外，因而定位被跳过。
  - **回退结果**：已撤回适配，待新版部署验证（`SkillsSection` 局部回退）：仅将技能路径打开退回原本地文件管理器调用与失败提示，并撤回无项目时的目录浏览弹窗；独立 Web 下技能打开路径暂不支持（仍显示原失败提示），不记为功能已修好。技能页“当前服务器”范围文案及其他本轮改动保留。
- **工作区文件搜索 `.zcodeignore`「打开文件位置」（单列保留，未随同回退）**：
  - `WorkspaceFileSearchSection` 中「打开文件位置」定位的就是当前项目根目录本身，不存在跨出项目根目录的问题，保留打开右侧「文件管理」栏。

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
  - 在“当前服务器”与具体项目间切换，用户级 MCP（如 `browser`、`rea`）与项目级 MCP 在“已安装”分组正常展示并刷新连接状态。
  - 新增、编辑、删除、启停 MCP 持久化到当前服务器，刷新页面或重连后保持；首次加载不闪现假空列表；Desktop 本机、手机 `/remote` 与跨 Host 远端行为不退化。

## 4. 保留待确认、待复核与暂缓项

- **待集中复核**：新建任务、归档与取消归档在独立 Web 下的工作区归属（`cwd`、Git 归属、`workspacePath`、`workspaceIdentity`）一致性，结合实机多 root 与任务移动使用情况继续观察复核。
- **待实机确认**：
  - 输入法剪贴板粘贴超长文本（>15360 字符）时输入框转为附件的表现。
  - 实体手机断线重连后的编辑器焦点恢复与软键盘交互表现。
- **暂缓（低优先级）**：依赖宿主专属容器的插件自定义交互页（UI Plugin）独立 Web 承载。
