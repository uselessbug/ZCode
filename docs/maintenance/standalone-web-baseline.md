# 独立 Web 实施基线

## 1. 上游 3.18.2 升级基线

- 记录日期：2026-11-14
- 工作分支：`sync/upstream-3.18.2`
- 上游合并提交：`347fd4ff`（合并上游 `fec97590` v3.18.2 与独立 Web 基线 `f40a4597`，共同祖先 `a9fe401e`）
- 模型删除/保存反馈竞态修复提交：`454b2832`
- 升级前 `main` 基线：`f40a4597`（`docs(maintenance): record standalone MCP deployment acceptance`）
- 当前状态：本地合并与本地定向回归校验已完成，尚未推送远端、尚未运行 CI 构建、尚未执行实机部署。

### 1.1 升级保护能力范围

1. **连接恢复与重连连续性**：独立 Web 断线重连恢复、过期 RPC 清理、重连期间保持设置页/草稿/焦点、服务端项目 Host 别名解析。
2. **任务、多 root 项目与分组**：独立 Web 任务归档/取消归档、无项目会话草稿、多 root 项目目录增删与任务跨项目移入/移动、任务分组排序与移出分组。
   - **归档任务删除（3.18.2 用户可见变化）**：采用上游 3.18.2 官方「归档预检 + 二次确认永久删除」及同 Host 归档删除 carrier 路由，不再保留旧版软删除 guard helper，不自动清理既有历史数据。
3. **移动端与输入适配**：手机单栏导航与设置页布局、子代理颜色选中居中与模型菜单 44px 触控尺寸、权限弹窗子代理来源完整换行与有界滚动、新建技能/插件试用预填自动跳转聊天页、长文本粘贴转内存 `File` 附件。
4. **服务端记忆、范围文案与目录交互**：项目记忆目录展示与 Markdown 页内预览/编辑/保存、服务端个性化指令（`AGENTS.md`）读写、`settings.scope.server`“当前服务器”文案、从服务器目录添加插件来源、`.zcodeignore` 打开右侧文件栏定位项目根目录（技能详情打开路径维持撤回状态）。
5. **独立 Web MCP 服务端路由与 Node 统一发行包**：独立 Web “当前服务器”与项目 MCP 路由至服务端 Host 读写/启停/重连；`zcode` / `zcode --web` 发行包内置官方插件与 `bundled-skills` 随包组装及容器 `sha-<8位>` 标签发布。

### 1.2 3.18.2 凭据强校验与回退限制

依据 [`docs/plans/2026-10-29-system-credential-storage.md`](../plans/2026-10-29-system-credential-storage.md)（保持上游行为，不自动生成生产密钥或恢复弱密钥兜底）：

- **显式凭据密钥强校验（`:99-104`）**：独立 Server / Docker Web 在开放 HTTP 服务前会初始化凭据后端；无系统 keyring 时必须显式提供 `ZCODE_CREDENTIAL_SECRET` 或 `ZCODE_CREDENTIAL_SECRET_FILE`（32–4096 字节只读 secret，按原字节读取、不 trim，二者不可同时设置）。本地隔离探针已验证凭据 cipher wrapper 初始化：无 secret 且无 keyring 时凭据初始化失败，注入合成 secret 时凭据初始化通过（非完整 HTTP 服务实测）。
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
