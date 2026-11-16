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
- 升级前 `main` 基线：`f40a4597`（`docs(maintenance): record standalone MCP deployment acceptance`）
- 当前状态（更新于 2026-11-16）：线上容器当前实际运行版本为 `a18fe44a`（完整 SHA：`a18fe44a5d0f3eadd7af630c854350952340e90c`，GitHub Actions [`43860163049`](https://github.com/uselessbug/ZCode/actions/runs/43860163049) `success`，镜像 `sha-a18fe44a`，digest `sha256:b05def7328ed9ee88da4d21fd9fe60a55e1009298737fb433f5e9d8f44f98da9`）。`2026-11-16T11:59:45.181Z` 探针确认容器 `running`、`healthy`、`restarts: 0`，运行镜像 `org.opencontainers.image.revision` 核实为 `a18fe44a5d0f3eadd7af630c854350952340e90c`，HTTP 首页 `200`、鉴权 `/api/server-info` `200`、未授权 `401`、WebSocket 握手 `pass`、`credential-secret` 与 `provider_config.json` SHA-256 指纹不变、首页双值 `color-scheme` meta 为 `true`、`/opt/browser-mcp` 目录不存在。本轮 4 项修改（移除项目时估算与清理当前服务器项目数据、普通二进制文件分块上传与 >64K 文本附件落盘物化、独立 HTTP 服务端定时任务 `automation-runtime` 到期调度与立即运行执行链、非桌面 Web 停用营销轮询）已部署上线并通过启动与接口探针，待浏览器刷新加载新前端静态资源后由用户日常使用做实际页面交互验收。同日早前 `b9f0e517`（GitHub Actions [`43795610757`](https://github.com/uselessbug/ZCode/actions/runs/43795610757) `success`，镜像 `sha-b9f0e517`）主题兼容修复已由用户确认手机自动跟随恢复（切换时页面重载与重连横幅另行追踪）；`f643ee64` 部署的 `restoreProject` 项目恢复已于 2026-11-16 经用户页面连续移除/恢复实操与服务端 4 次 RPC 日志确认通过，记忆标识与 Browser MCP 清理保持生效。详细证据见 [standalone-web-deployment-checklist.md](./standalone-web-deployment-checklist.md) 与 [issues.md](./issues.md)。
- 历史部署验收基线：2026-11-15 `29c3c4dc`（GitHub Actions 运行 [`43723274317`](https://github.com/uselessbug/ZCode/actions/runs/43723274317) `success`）完成 `ce24c4cf` 冗余清理生效及官方 `browser-use` 网页访问读取实测与用户确认；更早 `4e959bab` 部署完成运行日志 5446 行无关键错误核验及用户多端实机验收（模型保存/删除提示、归档任务永久删除、实体手机重连、手机工作区与 `compact-web` 设置页、任务分组、子代理设置与权限弹窗、新建技能/插件试用预填跳转、新建项目目录选择与任务工作区归属均确认正常；详见 [standalone-web-deployment-checklist.md](./standalone-web-deployment-checklist.md)）。

### 1.1 升级保护能力范围

1. **连接恢复与重连连续性**：独立 Web 断线重连恢复、过期 RPC 清理、重连期间保持设置页/草稿/焦点、服务端项目 Host 别名解析。
2. **任务、多 root 项目与分组**：独立 Web 任务归档/取消归档、无项目会话草稿、多 root 项目目录增删与任务跨项目移入/移动、任务分组排序与移出分组。
   - **归档任务删除（3.18.2 用户可见变化）**：采用上游 3.18.2 官方「归档预检 + 二次确认永久删除」及同 Host 归档删除 carrier 路由，不再保留旧版软删除 guard helper，不自动清理既有历史数据（2026-11-15 已实机确认）。
3. **移动端与输入适配**：手机 Home/Chat 单栏导航与设置页官方 `compact-web` 横向导航布局、子代理颜色选中居中与模型菜单 44px 触控尺寸、权限弹窗子代理来源完整换行与有界滚动、新建技能/插件试用预填自动跳转聊天页、系统原生剪贴板长文本粘贴转内存 `File` 附件。
4. **服务端记忆、范围文案与目录交互**：项目记忆目录展示与 Markdown 页内预览/编辑/保存、服务端个性化指令（`AGENTS.md`）读写、`settings.scope.server`“当前服务器”文案、从服务器目录添加插件来源、`.zcodeignore` 打开右侧文件栏定位项目根目录（已实现，未单列验收；技能详情打开路径维持撤回、独立 Web 暂不支持）。
5. **独立 Web MCP 服务端路由、Browser Use 受管 CDP 与 Node 统一发行包**：独立 Web “当前服务器”与项目 MCP 路由至服务端 Host 读写/启停/重连；独立 HTTP Server 接入官方受管无头 Chromium（`server-browser-control` -> `agent.browsers.*`）；`zcode` / `zcode --web` 发行包内置官方插件与 `bundled-skills` 随包组装及容器 `sha-<8位>` 标签发布。

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
- [定时任务服务端执行链](../standalone-web-automation-runtime.md)
- [系统安全存储与凭据迁移计划](../plans/2026-10-29-system-credential-storage.md)
- [多 root 项目与任务移动](../standalone-web-multi-root-projects.md)
- [设置页服务边界与手机布局](../standalone-web-settings.md)
- [Node 统一发行包规格](../../specs/zcode-unified-distribution.md)
