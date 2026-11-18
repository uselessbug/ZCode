import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationTrigger,
} from "@zcode/shared";
import {
  AUTOMATION_MISFIRE_GRACE_MS,
  AUTOMATION_POLL_INTERVAL_MS,
  type AutomationCronPort,
  type AutomationDispatchRequest,
  type AutomationDispatchSettlement,
  type AutomationLoggerPort,
  type AutomationRepoPort,
  type AutomationRunNotificationEvent,
  type AutomationSchedulerHandle,
  type AutomationTimersPort,
} from "./contract.js";
import { settleManualClaimForDispatchResult } from "./runLifecycle.js";

export type AutomationSchedulerRepoPort = Pick<
  AutomationRepoPort,
  | "claimDue"
  | "claimManualRuns"
  | "skipAndReschedule"
  | "upsertRunClaimed"
  | "getRun"
  | "get"
  | "markScheduleRunDispatched"
  | "markManualRunDispatched"
  | "markRunDispatch"
  | "markDispatchFailed"
  | "releaseClaim"
  | "releaseManualClaim"
>;

export type AutomationSchedulerDispatchPort = (
  request: AutomationDispatchRequest,
  trigger: ZCodeAutomationTrigger,
) => Promise<{ settled: true; result: AutomationDispatchSettlement } | { settled: false }>;

/** 派发时间戳：优先用 next_run_at（重试期间不变，保证 runId 稳定），退到 retry_at / now。 */
export function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

export function buildScheduleRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

function buildDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): AutomationDispatchRequest {
  const modelSelection = fixedSelection ?? automation.modelSelection;
  return {
    automationId: automation.automationId,
    ...(automation.title ? { automationTitle: automation.title } : {}),
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    projectId: automation.projectId,
    hostId: automation.hostId,
    additionalDirectories: automation.additionalDirectories,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
}

export interface CreateAutomationSchedulerOptions {
  repo: AutomationSchedulerRepoPort;
  cron: AutomationCronPort;
  submitDispatch: AutomationSchedulerDispatchPort;
  logger: Pick<AutomationLoggerPort, "info" | "warn" | "error">;
  pollIntervalMs?: number;
  misfireGraceMs?: number;
  timers?: AutomationTimersPort;
  onAfterAutomationTick?: (now: number) => Promise<void>;
  onDispatchFailed?: (event: AutomationRunNotificationEvent) => void;
}

export function createAutomationScheduler(
  options: CreateAutomationSchedulerOptions,
): AutomationSchedulerHandle {
  const { repo, cron, submitDispatch, logger } = options;
  const pollIntervalMs = options.pollIntervalMs ?? AUTOMATION_POLL_INTERVAL_MS;
  const misfireGraceMs = options.misfireGraceMs ?? AUTOMATION_MISFIRE_GRACE_MS;
  const now = () => options.timers?.now?.() ?? Date.now();
  const setTimer = options.timers?.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTimer =
    options.timers?.clearInterval ??
    ((id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>));

  type InFlight = {
    automationId: string;
    automationTitle?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId?: string;
    trigger: ZCodeAutomationTrigger;
  };
  const inFlight = new Map<string, InFlight>();
  const activeWork = new Set<Promise<void>>();

  let ticking = false;
  let tickRequested = false;
  let started = false;
  let disposed = false;
  let pollTimer: unknown = null;
  let tickPromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;

  const trackWork = <T>(promise: Promise<T>): Promise<T> => {
    const tracked = promise.then(
      () => undefined,
      () => undefined,
    );
    activeWork.add(tracked);
    void tracked.finally(() => {
      activeWork.delete(tracked);
    });
    return promise;
  };

  const settleDispatchResult = async (
    msg: { runId: string } & AutomationDispatchSettlement,
  ): Promise<void> => {
    return trackWork(settleDispatchResultInternal(msg));
  };

  const settleDispatchResultInternal = async (
    msg: { runId: string } & AutomationDispatchSettlement,
  ): Promise<void> => {
    const context = inFlight.get(msg.runId);
    inFlight.delete(msg.runId);
    const settledAt = now();
    // 从 runId 还原 automationId（context 丢失时兜底，如 scheduler 重启后收到迟到回报）。
    const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
    const workspaceKey = context?.workspaceKey;
    const trigger: ZCodeAutomationTrigger =
      context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
    const settleManualClaim = async (ok: boolean): Promise<void> => {
      await settleManualClaimForDispatchResult({
        repo,
        automationId,
        runId: msg.runId,
        workspaceKey,
        ok,
        logError: (message) => logger.error(message),
      });
    };

    if (msg.ok) {
      if (trigger === "manual") {
        await repo.markManualRunDispatched({
          runId: msg.runId,
          sessionId: msg.sessionId ?? null,
          dispatchedAt: settledAt,
        });
        await settleManualClaim(true);
        return;
      }
      const automation = await repo.get(automationId);
      const nextRunAt = automation ? cron.computeNextRunAt(automation, settledAt) : null;
      await repo.markScheduleRunDispatched({
        runId: msg.runId,
        automationId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: settledAt,
        nextRunAt,
      });
      return;
    }

    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "failed_to_dispatch",
      error: msg.error ?? "dispatch failed",
    });
    if (trigger === "manual") {
      await settleManualClaim(false);
      const automation = context?.automationTitle ? null : await repo.get(automationId);
      const workspacePath = context?.workspacePath ?? automation?.workspacePath ?? "";
      const automationTitle = context?.automationTitle ?? automation?.title;
      const workspaceIdentity = context?.workspaceIdentity ?? automation?.workspaceIdentity;
      const sessionId = msg.sessionId ?? context?.targetTaskId ?? automation?.targetTaskId;
      options.onDispatchFailed?.({
        kind: "automation_failed",
        runId: msg.runId,
        automationId,
        ...(automationTitle ? { automationTitle } : {}),
        ...(msg.error ? { detail: msg.error } : {}),
        ...(sessionId ? { sessionId } : {}),
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      return;
    }
    const kind = msg.failureKind ?? "transient";
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? cron.computeNextRunAt(automation, settledAt) : null;
    const failedOutcome = await repo.markDispatchFailed(automationId, {
      failedAt: settledAt,
      error: msg.error ?? "dispatch failed",
      kind,
      nextRunAt,
    });
    const after = failedOutcome?.terminal !== undefined ? null : await repo.get(automationId);
    const isTerminalFailure =
      kind === "permanent" ||
      failedOutcome?.terminal === true ||
      (failedOutcome?.terminal === undefined &&
        (after?.lifecycleStatus === "failed" ||
          (automation?.dispatchStatus === "failed_to_dispatch" &&
            after?.dispatchStatus === "idle")));
    if (!isTerminalFailure) {
      return;
    }
    const workspacePath = context?.workspacePath ?? automation?.workspacePath ?? "";
    const automationTitle = context?.automationTitle ?? automation?.title;
    const workspaceIdentity = context?.workspaceIdentity ?? automation?.workspaceIdentity;
    const sessionId = msg.sessionId ?? context?.targetTaskId ?? automation?.targetTaskId;
    options.onDispatchFailed?.({
      kind: "automation_failed",
      runId: msg.runId,
      automationId,
      ...(automationTitle ? { automationTitle } : {}),
      ...(msg.error ? { detail: msg.error } : {}),
      ...(sessionId ? { sessionId } : {}),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
  };

  const dispatchClaimed = async (
    request: AutomationDispatchRequest,
    trigger: ZCodeAutomationTrigger,
    workspaceKey: string,
  ): Promise<void> => {
    inFlight.set(request.runId, {
      automationId: request.automationId,
      ...(request.automationTitle ? { automationTitle: request.automationTitle } : {}),
      workspaceKey,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      ...(request.targetTaskId ? { targetTaskId: request.targetTaskId } : {}),
      trigger,
    });
    const dispatchOutcome = await trackWork(submitDispatch(request, trigger));
    if (dispatchOutcome.settled) {
      await settleDispatchResult({ runId: request.runId, ...dispatchOutcome.result });
    }
  };

  const handleClaimed = async (automation: ZCodeAutomation, currentNow: number): Promise<void> => {
    const scheduledAt = resolveScheduledAt(automation, currentNow);
    const runId = buildScheduleRunId(automation.automationId, scheduledAt);
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    const isRetry = automation.dispatchAttempts > 0;

    // misfire：首轮（非重试）且计划触发时间已远早于 now → 认定错过窗口，跳过不补跑。
    const missed =
      !isRetry &&
      automation.nextRunAt != null &&
      automation.nextRunAt <= currentNow - misfireGraceMs;
    if (missed) {
      const finalize = cron.isOneShotAutomation(automation);
      const nextRunAt = finalize ? null : cron.computeNextRunAt(automation, currentNow);
      await repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "computer_asleep_or_app_not_running",
        nextRunAt,
        finalize,
      });
      logger.info(
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
      );
      return;
    }

    // 正常派发：先落/更新 run 台账（claimed），再提交派发。
    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey,
      scheduledAt,
      trigger: "schedule",
    });
    const run = await repo.getRun(runId);
    await dispatchClaimed(
      buildDispatchRequest(automation, runId, run?.modelSelection),
      "schedule",
      workspaceKey,
    );
  };

  const handleClaimedManual = async (
    automation: ZCodeAutomation,
    run: ZCodeAutomationRun,
  ): Promise<void> => {
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    });
    await dispatchClaimed(
      buildDispatchRequest(automation, run.runId, run.modelSelection),
      "manual",
      workspaceKey,
    );
  };

  const runTick = async (): Promise<void> => {
    if (disposed || !started || ticking) return;
    ticking = true;
    let tickSettled = false;
    let currentTick: Promise<void> | null = null;
    currentTick = (async () => {
      try {
        do {
          tickRequested = false;
          try {
            const currentNow = now();
            const claimed = await repo.claimDue(currentNow);
            for (const automation of claimed) {
              if (disposed) {
                await repo.releaseClaim(automation.automationId);
                continue;
              }
              await handleClaimed(automation, currentNow);
            }
            if (disposed) break;
            const manualRuns = await repo.claimManualRuns(currentNow);
            for (const manualRun of manualRuns) {
              if (disposed) {
                await repo.releaseManualClaim(
                  manualRun.automation.automationId,
                  resolveWorkspaceKey(manualRun.automation),
                );
                continue;
              }
              await handleClaimedManual(manualRun.automation, manualRun.run);
            }
            if (!disposed) {
              await options.onAfterAutomationTick?.(currentNow);
            }
          } catch (error) {
            logger.error(
              `tick failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
          }
          // wake 可能与当前 tick 重叠；记录 pending 并在本轮完成后立即补跑，避免干等下一轮轮询。
        } while (tickRequested && !disposed);
      } finally {
        tickSettled = true;
        ticking = false;
        if (currentTick !== null && tickPromise === currentTick) tickPromise = null;
      }
    })();
    tickPromise = tickSettled ? null : currentTick;
    await currentTick;
  };

  const wake = (): void => {
    if (disposed) return;
    if (!started || ticking) {
      tickRequested = true;
      return;
    }
    void runTick();
  };

  const stopTimer = (): void => {
    if (pollTimer !== null) {
      clearTimer(pollTimer);
      pollTimer = null;
    }
  };

  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      wake();
      pollTimer = setTimer(wake, pollIntervalMs);
    },
    wake,
    settleDispatchResult,
    disposeSync(): void {
      disposed = true;
      stopTimer();
    },
    async dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposed = true;
      stopTimer();
      disposePromise = (async () => {
        if (tickPromise) {
          await tickPromise.catch(() => undefined);
        }
        while (activeWork.size > 0) {
          await Promise.allSettled(activeWork);
        }
        for (const [, context] of inFlight) {
          try {
            if (context.trigger === "manual") {
              await repo.releaseManualClaim(context.automationId, context.workspaceKey);
            } else {
              await repo.releaseClaim(context.automationId);
            }
          } catch {
            // 退出路径尽力释放认领。
          }
        }
        inFlight.clear();
      })();
      return disposePromise;
    },
  };
}
