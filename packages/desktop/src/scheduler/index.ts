// 常驻 cron scheduler 进程：由 desktop main 通过 electronUtilityProcess.fork 拉起。
// 职责：
//   - 复用 @zcode/services/node 的 createAutomationScheduler 维护 cron 轮询、misfire、认领与幂等结算
//   - 把到期任务的派发请求发回 main（main 再翻译成 CronRun 转给 workspace host 执行）
//   - 闲时任务（off_peak_tasks）：启动回收中断任务，认领 schedulable=1 的 queued 任务派发
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  createAutomationScheduler,
  isOneShotAutomation,
  OffPeakTaskRepo,
} from "@zcode/services/node";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { settleOffPeakDispatchResult } from "./offPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

const { parentPort } = process;

const repo = new AutomationRepo();

// ---- 闲时任务（off-peak）----
const offPeakRepo = new OffPeakTaskRepo();
/** 进程内退避表：offPeakTaskId → 下次允许派发时间/已失败次数。scheduler 重启即重置，无害。 */
const offPeakRetryAt = new Map<string, number>();
const offPeakRetryAttempts = new Map<string, number>();
/** 在途派发集合：仅用于退出时释放认领；迟到结果凭 offPeakTaskId 即可结算，不依赖它。 */
const offPeakInFlight = new Set<string>();

let disposed = false;
/** 资源遥测：本进程唯一的自采定时器。 */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // 兜底：parentPort 不可用（非 utilityProcess 调试运行）时仍留痕。
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler 调试兜底
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

/** 执行中计数上报（keep-awake）：仅在值变化时发消息，减噪。 */
let lastOffPeakActiveCount = -1;
async function reportOffPeakActiveCount(): Promise<void> {
  try {
    const count = await offPeakRepo.countActive();
    if (count === lastOffPeakActiveCount) return;
    lastOffPeakActiveCount = count;
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  } catch (error) {
    log(
      "warn",
      `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- 闲时任务派发 ----

async function handleOffPeakClaimed(task: ZCodeOffPeakTask, now: number): Promise<void> {
  const retryAt = offPeakRetryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  if (!task.modelSelection) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    log(
      "warn",
      `off-peak task claimed without model selection, released task=${task.offPeakTaskId}`,
    );
    return;
  }
  offPeakInFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    workspacePath: task.workspacePath,
    projectId: task.projectId,
    hostId: task.hostId,
    additionalDirectories: task.additionalDirectories,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
  log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`);
}

const scheduler = createAutomationScheduler({
  repo,
  cron: {
    computeNextRunAt: computeAutomationNextRunAt,
    isOneShotAutomation,
  },
  logger: {
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message),
  },
  submitDispatch: async (request) => {
    const msg: SchedulerToMainMessage = {
      type: "cron-dispatch-request",
      automationId: request.automationId,
      runId: request.runId,
      prompt: request.prompt,
      ...(request.targetTaskId ? { targetTaskId: request.targetTaskId } : {}),
      ...(request.modelSelection ? { modelSelection: request.modelSelection } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      workspacePath: request.workspacePath,
      projectId: request.projectId,
      hostId: request.hostId,
      additionalDirectories: request.additionalDirectories,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    };
    parentPort?.postMessage(msg);
    return { settled: false };
  },
  onAfterAutomationTick: async (now) => {
    const offPeakClaimed = await offPeakRepo.claimDue(now);
    for (const task of offPeakClaimed) {
      await handleOffPeakClaimed(task, now);
    }
    // keep-awake：上报执行中计数，main 据此 + 设置决定 powerSaveBlocker。
    await reportOffPeakActiveCount();
  },
});

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  await scheduler.dispose();
  for (const offPeakTaskId of offPeakInFlight) {
    try {
      await offPeakRepo.releaseClaim(offPeakTaskId);
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }
  offPeakInFlight.clear();
  try {
    repo.close();
  } catch {
    // 忽略。
  }
  try {
    offPeakRepo.close();
  } catch {
    // 忽略。
  }
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    const settlement = msg.ok
      ? {
          runId: msg.runId,
          ok: true as const,
          taskId: msg.taskId,
          sessionId: msg.sessionId,
        }
      : {
          runId: msg.runId,
          ok: false as const,
          error: msg.error ?? "cron dispatch failed",
          failureKind: msg.failureKind,
        };
    void scheduler
      .settleDispatchResult(settlement)
      .then(() => {
        // manual run 可能因同一 automation 已有派发在途而暂时无法认领。
        // 前一轮结算释放 single-flight 锁后主动 tick，避免再次等待 20 秒轮询。
        scheduler.wake();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    offPeakInFlight.delete(msg.offPeakTaskId);
    void settleOffPeakDispatchResult(
      {
        repo: offPeakRepo,
        retryAt: offPeakRetryAt,
        retryAttempts: offPeakRetryAttempts,
        now: Date.now,
        log,
      },
      msg,
    ).catch((error) => {
      log(
        "error",
        `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    log("info", `manual run wake requested automation=${msg.automationId}`);
    scheduler.wake();
  }
});

async function main(): Promise<void> {
  await repo.ensureReady();
  // 闲时任务中断恢复：scheduler 是 app 单例、先于任何派发启动——此刻 DB 里的
  // running 必属上一个 app 实例残留，安全置回 queued（session 保留供 resume 续跑）。
  try {
    const recovered = await offPeakRepo.recoverInterrupted(Date.now());
    if (recovered > 0) {
      log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
    }
  } catch (error) {
    log(
      "error",
      `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  log("info", "cron scheduler started");
  scheduler.start();
  // 资源遥测：60 秒自采一次 CPU / 内存发给 main（heap 只有本进程读得到）。
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
