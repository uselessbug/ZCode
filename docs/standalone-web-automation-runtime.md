# 独立 HTTP 服务端定时任务执行链（`automation-runtime`）

## 目标与范围

独立 HTTP Server（`packages/server/src/entry-http.ts`）是独立云端 Web 场景下工作区与定时任务的唯一 Host 权威，没有 Electron Main 与独立 `utilityProcess` scheduler。本规格将 Desktop 既有的定时任务调度、单次执行、模型冻结、终态生命周期与 Bot 投递提取为受管共享模块 `packages/services/src/automation-runtime`（`requires: [shared]`），在保持 Desktop IPC、off-peak 与遥测不变的前提下，为开启 `automationExecutionEnabled: true` 的独立 HTTP Host 提供等价的执行链。

Desktop-attached remote source server（`zcode-server-cli`）与未开启开关的 `createServerHostServices` 调用方保持 `automationExecutionEnabled = false`，不启动进程内调度器，避免与桌面主调度器重复调度。

## 架构与所有权

```text
packages/services/src/automation-runtime/   (受管模块，requires: [shared])
  ├── scheduler.ts       20s 轮询、5min misfire 跳过、claimDue / claimManualRuns、
  │                      按 runId 幂等结算、wake 合并补跑、优雅关闭等待在途
  ├── executor.ts        单次执行（模型解析与 fixRunModelSelection 冻结、create/resume、
  │                      先注册 Bot 监听与 terminal outcome 订阅再 sendPrompt、
  │                      按 inputId === runId 匹配终态置未读）
  ├── modelSelection.ts  固定选型复用或 modelSelectionService.getView() 校验解析
  ├── runLifecycle.ts    60s manual claim 心跳续租、best-effort 终态回写与 claim 释放
  ├── botDelivery.ts     sendPrompt 前置 watchCronRunBotDelivery 订阅
  └── alignment.ts       standalone 启动前存量定义权威 workspaceIdentity / hostId 对齐

消费端：
  - Desktop scheduler process (packages/desktop/src/scheduler/*)  -> 复用 scheduler + runLifecycle
  - Desktop window host (packages/desktop/src/host/*)             -> 复用 executor + modelSelection + runLifecycle + botDelivery
  - Standalone HTTP host (packages/services/src/node.ts + entry-http.ts)
      -> automationExecutionEnabled: true 时启用进程内 automation-runtime（scheduler + executor + alignment）
```

## `workspaceIdentity` 与 `hostId` 边界（区分两种 `standalone-server` 模式）

`standalone-server` 按 `allowStandaloneCloudWorkspaces`（对应环境变量 `ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS=1`）分为两种运行模式：

### 模式 A：独立 Web 本地工作台模式（`serviceAuthorityMode === "standalone-server"` 且 `allowStandaloneCloudWorkspaces === true`）

1. **回归官方 path-only 身份（同时保护既有 canonical 绑定会话坐标）**：
   - 对齐官方桌面本机工作区行为：独立 Web 新建的定时任务定义与产出会话保持 `workspaceIdentity: undefined`（`workspaceKey = workspacePath`），仅以 `hostId = projectStorageHostId`（如 `remote:server:oci-ai-agent`）表达当前服务器权威归属。
   - `prepareProjectExecution` 经 `projectService.prepareSession` 得到 `workspacePath` 后返回 `{ ...prepared, hostId: projectStorageHostId, workspaceIdentity: undefined }`。
   - 无 `projectId` 创建与会话内 `CronCreate`（`zcodeProtocolMethods.automationCreate`）经 `resolveAutomationExecutionContext` 处理：若入站 `target.workspaceIdentity` 非空，先使用**纯无副作用只读查询**（仅比对本机确定性 `stableIdentity` 或只读查询 `workspace_alias` 表的 `canonical_key`；非远端字符串仅允许等于 `target.workspacePath`）校验归属，不归属则立即抛出 `"Automation workspace does not belong to this server"`，绝不调用带扫描/合并副作用的 `sourceServerWorkspaceService.resolveWorkspace`，保证被拒绝的异域请求对 `automations`、`automation_runs`、`tasks`、`workspace_alias` 零写入。校验通过后，仅当携带 `targetTaskId`、入站 `identity` 为归属本服务器的远端身份且 `tasks` 表中确实存在对应 canonical 会话行（`taskIndexRepo.getTaskMeta` 非空）时保留 `{ hostId, workspaceIdentity: identity }`，避免经 Desktop `/ws/host` 创建的 canonical 会话内 `CronCreate` 与 CLI `session.workspace_id` 及 `updateTaskPresentation` 坐标分裂；其余所有情况一律返回 `{ hostId, workspaceIdentity: undefined }`。
   - 这样独立 Web 定时任务产出的会话与独立 Web 普通会话、受管 Worktree、`<slug>-<hash>/memory` 记忆目录及前端本地标签页（`ensureTaskNavigationWorkspace` 的 `addLocalWorkspaceTab`）完全一致，不分裂存储桶、不双开同项目 `zcode-cli` 进程。
2. **启动对齐与异域拒绝**：
   - `standaloneAuthority` 启用 `localWorkspaceAliasEnabled: true`。调度器启动前先用无副作用条件过滤异域记录（`hostId` 属于其他远端，或 `workspaceIdentity`/`workspaceKey` 携带异域 `remote:ssh:*` / `remote:wsl:*` / `remote:docker:*` / 其他 `remote:server:*`），跳过并保护同路径异域定义与 `automation_runs` 不被改写；对本服务器归属记录通过 `AutomationRepo.hasCanonicalReferencedSession`（与 `alignStandaloneWorkspaceIdentity` 事务内原子守卫）检查 `target_task_id` 或 `automation_runs.session_id` 是否在 `tasks` 表关联了非空 canonical `workspace_identity` 会话：
     - **无关联 canonical 会话**（含 `hostId` 缺失/`"local"` 历史记录，以及尚未产出 canonical `tasks` 行的同服务器 `remote:server:<self>:<path>` 定义）：在事务内精准对齐为 `workspace_key = workspacePath`、`workspace_identity = NULL`、`host_id = projectStorageHostId`（关联 run 同步更新为 `workspacePath`）。
     - **已关联 canonical `tasks` 会话**：不剥离 `workspace_identity`，对齐并保留在经只读校验的本服务器 `canonicalWorkspaceKey`（`workspace_key = canonicalWorkspaceKey`、`workspace_identity = canonicalWorkspaceKey`、`host_id = projectStorageHostId`），维持 `automations`、`automation_runs`、`tasks` 与 CLI `session.workspace_id` 四处坐标一致。
   - 运行期 `assertStandaloneAutomationOwnership` 校验 `request.hostId === projectStorageHostId`：放行 `!identity`（独立 Web 新建与未关联 canonical 会话的任务统一走 path-only，可在独立 Web 原生打开），以及 `identity` 为经过只读校验的本服务器 `canonicalWorkspaceKey`（如 Desktop `/ws/host` 创建或保留坐标一致性的本机 canonical 任务）；**不依赖可随时删除的 `automation_runs` 历史记录**，确保删除历史运行记录后循环定时任务仍可正常继续派发；其余任何 `"local"` `hostId`、异域 `hostId`、异域 `remote:ssh:*`/`remote:server:other:*` 或非 canonical 字符串（如裸 `workspacePath` 残留在 `workspaceIdentity`）均按 `AutomationPermanentDispatchError` 拒绝，不回落 `"local"`。

### 模式 B：纯远端 Source Server 模式（`serviceAuthorityMode === "standalone-server"` 且 `!allowStandaloneCloudWorkspaces`）

1. **新建定义固化 canonical 身份**：
   - `prepareProjectExecution` 在 `standalone-server` 下经 `projectService.prepareSession` 得到 `workspacePath` 后，调用 `sourceServerWorkspaceService.resolveWorkspace({ workspacePath })` 获取 `canonicalWorkspaceKey`，将可信 `hostId: projectStorageHostId` 与 canonical `workspaceIdentity` 固化到新建定义。
   - 无 `projectId` 创建与会话内 `CronCreate`（`zcodeProtocolMethods.automationCreate`）先以同样的纯只读逻辑校验入站 `workspaceIdentity`（异域直接拒绝、零写入，绝不提前调用 `resolveWorkspace`）；校验通过后优先读取 `workspace_alias` 已持久化的 `canonical_key`，仅在无已登记 alias 时才调用 `sourceServerWorkspaceService.resolveWorkspace` 分配并固化 canonical `workspaceIdentity` 与可信 `hostId`。
2. **启动对齐与异域拒绝**：
   - `standaloneAuthority` 保持 `localWorkspaceAliasEnabled: false`。调度器启动前遍历存量定时任务定义：在调用 `resolveWorkspace` 前先做无副作用过滤——若 `hostId` 为异域非 `"local"`，或已有远端 URI 身份（`remote:ssh:*` / `remote:wsl:*` / `remote:docker:*` / 其他 `remote:server:*`）的 `remoteHostIdFromWorkspaceIdentity(identity) !== ownerHostId`，直接跳过。仅对缺失 `workspaceIdentity`、显式本地路径（如 `workspaceIdentity === workspacePath`）或归属当前 `serverId` 的定义执行**只读** canonical 身份查询（优先读取 `workspace_alias` 已持久化的 `canonical_key`，未登记 alias 时使用本服务器确定性 `buildRemoteHostWorkspaceIdentity` 并同步注册 `workspaceIdentityMapper`），不触发 `SourceServerWorkspaceAliasRepo` 的全路径扫描与批量迁移，保护同路径下并存的异域 `remote:ssh:*` 定义与 `automation_runs` 不被改写；随后在事务内按 `automation_id` 与原 `workspace_key` 对齐当前服务器归属定义及其关联 run。
   - 运行期派发前复用同一只读身份查询校验归属：仅放行 `hostId === projectStorageHostId` 且 `workspaceIdentity === canonicalWorkspaceKey` 的定义，异域定义按 permanent failure 拒绝，不回落 `"local"`。

## 共享进程池与控制面空闲回收（独立 Web 本地工作台 / Standalone）

- **非项目 / `draft-*` 共享进程池**：`useSharedTaskRuntime` 在本地 Host 或独立 Web 本地工作台模式（`isLocalProjectHost || isStandaloneManagedWorktreeHost`）下，当 `!target.workspaceIdentity` 时委托 `taskIndexRepo.getProjectRepository(projectRepositoryOptions).hasProjectWorkspace(target)` 判断：项目目录（含 0 目录项目首次 `prepareSession` 落库后的 `.zcode/workspace/<projectId>`）独占项目 CLI 进程，非项目目录（如 `.zcode/conversations/draft-*`）共享 `SHARED_TASK_RUNTIME_KEY` 进程。
- **插件管理控制面空闲回收**：`standalone-server` 默认向 `createZCodeAgentService` 注入 `pluginManagementIdleTimeoutMs: 5 * 60_000`（`plugin-management` lane），空闲 5 分钟后自动回收，下次调用 `getPluginManagementClient()` 时按需重新拉起；桌面端默认不传，行为不变。

## 冻结目录快照派发

- 当定时任务绑定项目并冻结 `workspacePath` 与 `additionalDirectories` 后，用户修改或清空项目 `roots` 时，定时任务仍应按创建时持久化的目录快照创建新会话，不能被 `project.cwd-not-in-roots` 拦截。
- `node.ts` 在 `automationRuntime` 的 `resolveTargetServices` 中为 `taskService` 包装仅供调度器使用的内部代理：其 `createTask` 先从 `automationRuntimeRepo` 读取已持久化的 `automationId` 定义并校验归属本 Host 及冻结目录一致，再通过不可序列化的进程内私有 `Symbol`（`TRUSTED_FROZEN_EXECUTION_SNAPSHOT`）沿 `zcodeTaskServiceAdapter` -> `zcodeAgentService` -> `prepareSessionCreation` -> `ProjectRepository.reserveCreatedTask` 传递可信标记。
- `ProjectRepository.reserveCreatedTask` 与 `remote-policy` 仅在携带该内部标记时跳过当前 `project.roots` 包含性校验（仍校验项目存在、归属同一 `ownerHostId`，并保留软删除项目继续执行的语义），直接将已验证的冻结 `workspacePath` 与 `additionalDirectories` 固化写入 `tasks.execution_directories`；普通外部 RPC 调用不具备该内部标记，仍严格校验未删除项目与当前 `roots`。

## 统一 Wake 与优雅关闭

- `AutomationService` 在成功 `create` / `update` / `setEnabled` / `restart` / `delete` / `pause` 后统一触发可选 `onWake` 回调，覆盖 UI RPC 与 CLI `CronCreate`/`CronUpdate`；`tick` 进行中并发到达的 `wake` 通过 `tickRequested` 标记合并并在本轮完成后立即补跑。
- `runAutomationNow` 在认领前确认 dispatcher 存在且 runtime 尚未关闭；已关闭或未启用 `automationExecutionEnabled` 时直接拒绝，不写 `automation_runs`、不占 `running` 锁。
- `disposeServiceResourcesAndWait` 与 `entry-http.ts` 在 `SIGINT`/`SIGTERM` 或启动失败时遵守固定收口顺序：
  1. 关闭调度器与 manual 派发新 admission，停止 20s 轮询 timer；
  2. 等待在途 `tick` 与已受理的派发 ACK 结算，释放终态监听与 60s manual 心跳；
  3. 再关闭 Agent 进程树与共享 SQLite Repo（`AutomationRepo` / `TaskIndexRepo` / `OffPeakTaskRepo`），避免关库后异步写库异常。
