# 定时任务共享运行时（`automation-runtime`）

承载 Desktop scheduler / window host 与独立 HTTP Host 共用的定时任务调度、单次执行、模型冻结、终态生命周期、Bot 投递与 standalone 启动身份对齐。依赖收敛在 `shared`，所有存储、任务创建/发送、模型解析、Bot 监听与时钟均由装配层经窄端口注入，避免依赖 SQLite、Electron 或具体服务实现。

## 不变量

- **幂等结算与 single-flight**：周期 run（`automationId:scheduledAt`）与手动 run（`automationId:manual:uuid`）均按 `runId` 幂等回写 `automation_runs` 与 `run_count`，重复回执不重复累加计数或推进 `next_run_at`；manual run 在 `sendPrompt` 之前即持有 `running` 锁与 60s 心跳，直到匹配 `inputId === runId` 的终态后释放并触发 `wake`。
- **先监听再发送**：`dispatchRun` 在调用 `sendPrompt` 前完成 Bot 终态订阅与 `onDynamicTaskTerminalOutcome` 注册，避免快速回合丢失终态回写或 Bot 通知；Bot 订阅失败仅记 warn，不阻断主派发。
- **Wake 合并**：`wake()` 在未就绪或 `tick` 进行中记录 `tickRequested`，当前轮结束后立即补跑，不丢失并发唤醒。
- **Host 归属防线**：standalone 启动前先用纯无副作用条件校验 `hostId` 与已有身份归属本服务器（仅缺失或非远端显式本地路径以及同 `serverId` 记录进入后续解析），保证同路径共存的异域 `remote:ssh:*` / `remote:server:*` 定义与台账零篡改、不回落 `"local"`。开启 `localWorkspaceAliasEnabled`（独立 Web 本地工作台模式）时，独立 Web 新建与未关联 canonical 会话的任务统一在事务内对齐为 path-only 身份（`workspace_key = workspacePath`、`workspace_identity = NULL`、`host_id = projectStorageHostId`，供独立 Web 原生打开），而启动对齐通过 `hasCanonicalReferencedSession`（与 `alignStandaloneWorkspaceIdentity` 事务内原子守卫）识别 `target_task_id` 或 `automation_runs.session_id` 已关联非空 canonical `workspace_identity` 的 `tasks` 会话并保留其本服务器 `canonicalWorkspaceKey`；运行期派发前不依赖可删除的 `automation_runs` 历史行，只要 `hostId === projectStorageHostId` 且 `!identity` 或 `identity` 为经过只读校验的本服务器 `canonicalWorkspaceKey` 即放行（删除运行历史不影响循环任务继续派发），其余 `"local"` / 异域 `hostId`、异域身份或非 canonical 字符串按 permanent 失败拒绝。未开启时（纯远端 Source Server 模式）沿用只读 canonical `workspaceIdentity` 对齐与运行期匹配校验；异域任务均按 permanent 失败拒绝。
- **冻结目录快照派发**：`node.ts` 为 `automationRuntime` 的 `resolveTargetServices` 包装内部 `taskService.createTask` 代理，先读取 `automationRuntimeRepo` 中已持久化的 `automationId` 定义并核对归属本 Host 与冻结目录一致，再通过不可序列化的私有 `Symbol`（`TRUSTED_FROZEN_EXECUTION_SNAPSHOT`）传递给 `ProjectRepository.reserveCreatedTask`，使项目 `roots` 变更或清空后定时任务仍能按冻结的 `workspacePath` 与 `additionalDirectories` 创建会话。
- **优雅关闭顺序**：`executor.disposeAndWait()` 与 `runtime.dispose()` 先关闭调度与 manual 新 admission、停止轮询 timer，并等待全部在途 `tick` 与 `dispatchRun`/`dispatchManualRun`（含成功 `markManualRunDispatched` 与失败 `settleManualDispatchFailureBestEffort` 写库）结算后再清理终态监听与心跳、等待在途 `outcome` 写库完成，保证调用方在关闭 Agent 与 SQLite 句柄后不再发生悬空写库。
