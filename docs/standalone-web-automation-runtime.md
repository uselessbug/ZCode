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

## Canonical `workspaceIdentity` 与 `hostId` 边界

1. **新建定义固化权威身份**：
   - `prepareProjectExecution` 在 `standalone-server` 下经 `projectService.prepareSession` 得到 `workspacePath` 后，调用 `sourceServerWorkspaceService.resolveWorkspace({ workspacePath })` 获取 `canonicalWorkspaceKey`，将可信 `hostId: projectStorageHostId` 与 canonical `workspaceIdentity` 固化到新建定义。
   - 无 `projectId` 创建与会话内 `CronCreate`（`zcodeProtocolMethods.automationCreate`）在 `standalone-server` 下同样校验并补齐可信 `hostId` 与 canonical `workspaceIdentity`，拒绝异域 `workspaceIdentity`。
2. **启动对齐与异域拒绝**：
   - 调度器启动前遍历存量定时任务定义：在调用 `resolveWorkspace` 前先做无副作用过滤——若 `hostId` 为异域非 `"local"`，或已有远端 URI 身份（`remote:ssh:*` / `remote:wsl:*` / `remote:docker:*` / 其他 `remote:server:*`）的 `remoteHostIdFromWorkspaceIdentity(identity) !== ownerHostId`，直接跳过。仅对缺失 `workspaceIdentity`、显式本地路径（如 `workspaceIdentity === workspacePath`）或归属当前 `serverId` 的定义执行**只读** canonical 身份查询（优先读取 `workspace_alias` 已持久化的 `canonical_key`，未登记 alias 时使用本服务器确定性 `buildRemoteHostWorkspaceIdentity` 并同步注册 `workspaceIdentityMapper`），不触发 `SourceServerWorkspaceAliasRepo` 的全路径扫描与批量迁移，保护同路径下并存的异域 `remote:ssh:*` 定义与 `automation_runs` 不被改写；随后在事务内按 `automation_id` 与原 `workspace_key` 对齐当前服务器归属定义及其关联 run。
   - 运行期派发前复用同一只读身份查询校验归属：仅放行 `hostId === projectStorageHostId` 且 `workspaceIdentity === canonicalWorkspaceKey` 的定义，异域定义按 permanent failure 拒绝，不回落 `"local"`。

## 统一 Wake 与优雅关闭

- `AutomationService` 在成功 `create` / `update` / `setEnabled` / `restart` / `delete` / `pause` 后统一触发可选 `onWake` 回调，覆盖 UI RPC 与 CLI `CronCreate`/`CronUpdate`；`tick` 进行中并发到达的 `wake` 通过 `tickRequested` 标记合并并在本轮完成后立即补跑。
- `runAutomationNow` 在认领前确认 dispatcher 存在且 runtime 尚未关闭；已关闭或未启用 `automationExecutionEnabled` 时直接拒绝，不写 `automation_runs`、不占 `running` 锁。
- `disposeServiceResourcesAndWait` 与 `entry-http.ts` 在 `SIGINT`/`SIGTERM` 或启动失败时遵守固定收口顺序：
  1. 关闭调度器与 manual 派发新 admission，停止 20s 轮询 timer；
  2. 等待在途 `tick` 与已受理的派发 ACK 结算，释放终态监听与 60s manual 心跳；
  3. 再关闭 Agent 进程树与共享 SQLite Repo（`AutomationRepo` / `TaskIndexRepo` / `OffPeakTaskRepo`），避免关库后异步写库异常。
