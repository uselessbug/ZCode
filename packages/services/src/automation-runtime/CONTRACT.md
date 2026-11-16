# 定时任务共享运行时（`automation-runtime`）

承载 Desktop scheduler / window host 与独立 HTTP Host 共用的定时任务调度、单次执行、模型冻结、终态生命周期、Bot 投递与 standalone 启动身份对齐。依赖收敛在 `shared`，所有存储、任务创建/发送、模型解析、Bot 监听与时钟均由装配层经窄端口注入，避免依赖 SQLite、Electron 或具体服务实现。

## 不变量

- **幂等结算与 single-flight**：周期 run（`automationId:scheduledAt`）与手动 run（`automationId:manual:uuid`）均按 `runId` 幂等回写 `automation_runs` 与 `run_count`，重复回执不重复累加计数或推进 `next_run_at`；manual run 在 `sendPrompt` 之前即持有 `running` 锁与 60s 心跳，直到匹配 `inputId === runId` 的终态后释放并触发 `wake`。
- **先监听再发送**：`dispatchRun` 在调用 `sendPrompt` 前完成 Bot 终态订阅与 `onDynamicTaskTerminalOutcome` 注册，避免快速回合丢失终态回写或 Bot 通知；Bot 订阅失败仅记 warn，不阻断主派发。
- **Wake 合并**：`wake()` 在未就绪或 `tick` 进行中记录 `tickRequested`，当前轮结束后立即补跑，不丢失并发唤醒。
- **Host 归属防线**：standalone 启动前先用纯无副作用条件校验 `hostId` 与已有身份归属本服务器（仅缺失或非远端显式本地路径以及同 `serverId` 记录进入后续解析），并使用无批量迁移副作用的只读 alias 查询（读取 `workspace_alias` 已持久化的 `canonical_key`，缺省使用本服务器确定性 identity）取得目标键，在事务内按 `automation_id` 与原 `workspace_key` 精准对齐 `automations` 和 `automation_runs`，保证同路径共存的异域 `remote:ssh:*` / `remote:server:*` 定义与台账零篡改、不回落 `"local"`；运行期派发前再次校验 `hostId` 与 `workspaceIdentity`，异域任务按 permanent 失败拒绝。
- **优雅关闭顺序**：`executor.disposeAndWait()` 与 `runtime.dispose()` 先关闭调度与 manual 新 admission、停止轮询 timer，并等待全部在途 `tick` 与 `dispatchRun`/`dispatchManualRun`（含成功 `markManualRunDispatched` 与失败 `settleManualDispatchFailureBestEffort` 写库）结算后再清理终态监听与心跳、等待在途 `outcome` 写库完成，保证调用方在关闭 Agent 与 SQLite 句柄后不再发生悬空写库。
