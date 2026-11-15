# 独立 Web 实施基线

## 1. 上游 3.18.2 升级基线

- 记录日期：2026-11-15
- 升级分支与合并链路：`sync/upstream-3.18.2`（PR #2，GitHub Actions 运行 `43569582003` `success`）合并至 `main` 生成 `ae58c92f`（GitHub Actions 运行 `43570424184` `success`），后续在 `main` 提交 `4e959bab`（完整 SHA：`4e959baba16eeb1f8403b9785aa3bae7866dd32f`，容器镜像新增 Docker CLI 与 Compose 插件，GitHub Actions 运行 `43622140891` `success` 并发布 `latest` 与 `sha-4e959bab`）
- 关键包含提交：
  - 上游合并提交：`347fd4ff`（合并上游 `fec97590` v3.18.2 与独立 Web 基线 `f40a4597`，共同祖先 `a9fe401e`）
  - 模型删除/保存反馈竞态修复提交：`454b2832`
  - CI 依赖安装竞态修复提交：`bf8c2105`
  - 容器内置 Docker CLI / Compose 插件提交：`4e959bab`
- 升级前 `main` 基线：`f40a4597`（`docs(maintenance): record standalone MCP deployment acceptance`）
- 当前状态：`4e959bab` 已合并至 `main` 并由 GitHub Actions 完成构建、校验与镜像发布（`sha-4e959bab`）；已完成宿主容器更新、Agent 基础运行验收（容器 `healthy`、`restarts: 0`，HTTP 页面 `200`、鉴权 `serverinfo` `200` / 未授权 `401`、WebSocket 握手通过，运行日志无启动/凭据/`Unknown channel`/未捕获异常/OOM 关键错误）及 2026-11-15 用户实机验收（模型保存/删除提示、归档任务永久删除、实体手机重连、手机工作区与 `compact-web` 设置页、任务分组、子代理设置与权限弹窗、新建技能/插件试用预填跳转、新建项目目录选择与任务工作区归属均确认正常；归档永久删除同步经运行日志 `previewArchivedTaskDeletion` 与 `permanentlyDeleteArchivedTask` `OK` 印证）。
- 后续工作区本地改动（待 CI 与部署）：3 项冗余参数/字段清理已提交 `ce24c4cf`，独立 HTTP Web 官方 `browser-use`（`agent.browsers.*`）受管 CDP 适配已在本地实现，均待推送后由 GitHub Actions 构建校验并部署验证；另经代码审查发现 `http.ts` 中 `restoreProject` 遗漏 `positionalHostMethods` 别名重写（未修复，详见 [issues.md](./issues.md)）。

### 1.1 升级保护能力范围

1. **连接恢复与重连连续性**：独立 Web 断线重连恢复、过期 RPC 清理、重连期间保持设置页/草稿/焦点、服务端项目 Host 别名解析。
2. **任务、多 root 项目与分组**：独立 Web 任务归档/取消归档、无项目会话草稿、多 root 项目目录增删与任务跨项目移入/移动、任务分组排序与移出分组。
   - **归档任务删除（3.18.2 用户可见变化）**：采用上游 3.18.2 官方「归档预检 + 二次确认永久删除」及同 Host 归档删除 carrier 路由，不再保留旧版软删除 guard helper，不自动清理既有历史数据（2026-11-15 已实机确认）。
3. **移动端与输入适配**：手机 Home/Chat 单栏导航与设置页官方 `compact-web` 横向导航布局、子代理颜色选中居中与模型菜单 44px 触控尺寸、权限弹窗子代理来源完整换行与有界滚动、新建技能/插件试用预填自动跳转聊天页、系统原生剪贴板长文本粘贴转内存 `File` 附件。
4. **服务端记忆、范围文案与目录交互**：项目记忆目录展示与 Markdown 页内预览/编辑/保存、服务端个性化指令（`AGENTS.md`）读写、`settings.scope.server`“当前服务器”文案、从服务器目录添加插件来源、`.zcodeignore` 打开右侧文件栏定位项目根目录（已实现，未单列验收；技能详情打开路径维持撤回、独立 Web 暂不支持）。
5. **独立 Web MCP 服务端路由与 Node 统一发行包**：独立 Web “当前服务器”与项目 MCP 路由至服务端 Host 读写/启停/重连；`zcode` / `zcode --web` 发行包内置官方插件与 `bundled-skills` 随包组装及容器 `sha-<8位>` 标签发布。

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
- [系统安全存储与凭据迁移计划](../plans/2026-10-29-system-credential-storage.md)
- [多 root 项目与任务移动](../standalone-web-multi-root-projects.md)
- [设置页服务边界与手机布局](../standalone-web-settings.md)
- [Node 统一发行包规格](../../specs/zcode-unified-distribution.md)
