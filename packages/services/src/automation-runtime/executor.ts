import {
  formatModelPickerValue,
  resolveWorkspaceKey,
  type ModelSelection,
  type TraceId,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { watchCronRunBotDelivery } from "./botDelivery.js";
import type {
  AutomationDispatchRequest,
  AutomationExecutorHandle,
  AutomationLoggerPort,
  AutomationRepoPort,
  AutomationRunExecutorTargetServices,
  AutomationRunNotificationEvent,
  AutomationTaskServicePort,
  AutomationTimersPort,
} from "./contract.js";
import { resolveAutomationSubmissionModelSelection } from "./modelSelection.js";
import {
  recordCronRunOutcomeBestEffort,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
  startManualClaimHeartbeat,
} from "./runLifecycle.js";

export function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

export function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: Pick<
    AutomationTaskServicePort,
    "setAutomationSessionConfig" | "setConfigOption"
  >;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

export type AutomationExecutorRepoPort = Pick<
  AutomationRepoPort,
  | "getRun"
  | "getModelSelectionForDispatch"
  | "fixRunModelSelection"
  | "ensureRunClaimed"
  | "markRunOutcome"
  | "markRunDispatch"
  | "touchManualClaim"
  | "releaseManualClaim"
  | "markManualRunDispatched"
  | "getBotDeliveryTarget"
>;

export interface CreateAutomationExecutorOptions {
  repo: AutomationExecutorRepoPort;
  resolveTargetServices: (
    request: AutomationDispatchRequest,
  ) => AutomationRunExecutorTargetServices | Promise<AutomationRunExecutorTargetServices>;
  assertAutomationOwned?: (request: AutomationDispatchRequest) => Promise<void> | void;
  onSessionCreated?: (event: {
    sessionId: string;
    messageId: TraceId;
    workspaceIdentity?: string;
  }) => void;
  onTurnDispatched?: (event: { sessionId: string; runId: string }) => void;
  onTurnCleared?: (event: { sessionId: string; runId: string }) => void;
  onRunSettled?: (event: AutomationRunNotificationEvent) => void;
  emitDispatchRunFailureNotification?: boolean;
  onDispatchSessionResolved?: (event: { runId: string; sessionId: string }) => void;
  onManualClaimReleased?: () => void;
  logger: Pick<AutomationLoggerPort, "info" | "warn">;
  timers?: AutomationTimersPort;
  heartbeatIntervalMs?: number;
}

export function createAutomationExecutor(
  options: CreateAutomationExecutorOptions,
): AutomationExecutorHandle {
  const { repo, logger } = options;
  const now = () => options.timers?.now?.() ?? Date.now();
  const cronRunSubscriptions = new Map<string, { dispose(): void }>();
  const inFlightDispatches = new Set<Promise<void>>();
  const inFlightOutcomeWrites = new Set<Promise<void>>();
  let disposing = false;
  let disposed = false;
  let disposeAndWaitPromise: Promise<void> | null = null;

  const trackOutcomeWrite = (write: Promise<void>): void => {
    inFlightOutcomeWrites.add(write);
    void write.finally(() => {
      inFlightOutcomeWrites.delete(write);
    });
  };

  const trackDispatch = <T>(fn: () => Promise<T>): Promise<T> => {
    if (disposing || disposed) {
      return Promise.reject(new Error("Automation executor is disposed."));
    }
    const promise = fn();
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    inFlightDispatches.add(settled);
    void settled.finally(() => {
      inFlightDispatches.delete(settled);
    });
    return promise;
  };

  const disposeCronRunSubscription = (key: string): void => {
    const disposable = cronRunSubscriptions.get(key);
    if (!disposable) return;
    cronRunSubscriptions.delete(key);
    disposable.dispose();
  };

  const markCronRunOutcome = (params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
  }): void => {
    if (disposed) return;
    trackOutcomeWrite(
      recordCronRunOutcomeBestEffort({
        ...params,
        repo,
        logWarn: (message, error) => logger.warn(message, error),
      }),
    );
  };

  const trackCronRunOutcome = (params: {
    zcodeTaskService: AutomationTaskServicePort;
    taskId: string;
    traceId: TraceId;
    workspacePath: string;
    workspaceIdentity?: string;
    runId: string;
    automationId: string;
    automationTitle?: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: "schedule" | "manual";
  }): void => {
    const key = cronRunSubscriptionKey(params.taskId, params.traceId);
    disposeCronRunSubscription(key);
    markCronRunOutcome({ ...params, outcome: "running" });
    const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
      (result) => {
        if (disposing || disposed || result.inputId !== params.traceId) return;
        trackOutcomeWrite(
          settleCronRunTerminalOutcome({
            ...params,
            outcome: result.outcome,
            error: result.error,
            repo,
            logWarn: (message, error) => logger.warn(message, error),
            onManualClaimReleased: options.onManualClaimReleased,
          }),
        );
        if (
          (result.outcome === "succeeded" && !result.interrupted) ||
          result.outcome === "failed"
        ) {
          options.onRunSettled?.({
            kind: result.outcome === "succeeded" ? "automation_completed" : "automation_failed",
            runId: params.runId,
            automationId: params.automationId,
            ...(params.automationTitle ? { automationTitle: params.automationTitle } : {}),
            ...(result.error ? { detail: result.error } : {}),
            sessionId: params.taskId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(result.terminalAt !== undefined ? { sessionTerminalAt: result.terminalAt } : {}),
          });
        } else {
          options.onTurnCleared?.({ sessionId: params.taskId, runId: params.runId });
        }
        // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
        void params.zcodeTaskService.setTaskUnread({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          unread: true,
        });
        disposeCronRunSubscription(key);
      },
    );
    const claimHeartbeat =
      params.trigger === "manual"
        ? startManualClaimHeartbeat({
            ...params,
            repo,
            logWarn: (message, error) => logger.warn(message, error),
            intervalMs: options.heartbeatIntervalMs,
            timers: options.timers,
            onTouchSettled: trackOutcomeWrite,
          })
        : null;
    cronRunSubscriptions.set(key, {
      dispose() {
        claimHeartbeat?.dispose();
        disposable.dispose();
      },
    });
  };

  const dispatchRunCore = async (
    request: AutomationDispatchRequest,
    dispatchOptions?: {
      emitRunFailedOnThrow?: boolean;
      onSessionResolved?: (sessionId: string) => void;
    },
  ): Promise<{ taskId: string; sessionId: string }> => {
    if (disposing || disposed) {
      throw new Error("Automation executor is disposed.");
    }
    await options.assertAutomationOwned?.(request);
    if (disposing || disposed) {
      throw new Error("Automation executor is disposed.");
    }
    const targetServices = await options.resolveTargetServices(request);
    const { taskService: zcodeTaskService, modelSelectionService, botsService } = targetServices;
    const workspaceKey = resolveWorkspaceKey(request);
    // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
    // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
    const existingRun = await repo.getRun(request.runId);
    const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
      selection: request.modelSelection,
      fixedSelection: existingRun?.modelSelection,
      modelSelectionService,
      readSelection: () => repo.getModelSelectionForDispatch(request.automationId, workspaceKey),
    });
    const submissionModelSelection = await repo.fixRunModelSelection(
      request.runId,
      resolvedSubmissionModelSelection,
    );
    let trackedKey: string | null = null;
    let dispatchedTurnSessionId: string | null = null;
    let resolvedSessionId: string | undefined = request.targetTaskId;
    const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
    const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
    try {
      const task = request.targetTaskId
        ? { taskId: request.targetTaskId }
        : await zcodeTaskService.createTask({
            projectId: request.projectId,
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity,
            additionalDirectories: request.additionalDirectories,
            model: formatModelPickerValue(submissionModelSelection),
            mode: request.mode,
            thoughtLevel: submissionModelSelection.options?.reasoningLevel,
            automationId: request.automationId,
          });
      resolvedSessionId = task.taskId;
      dispatchOptions?.onSessionResolved?.(task.taskId);
      options.onDispatchSessionResolved?.({ runId: request.runId, sessionId: task.taskId });
      // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
      const promptTraceId = request.runId as TraceId;
      if (request.targetTaskId) {
        // 绑定会话在重启或切换 workspace 后通常不处于 active；必须先恢复再应用运行配置。
        await zcodeTaskService.resumeTask({
          taskId: task.taskId,
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          additionalDirectories: request.additionalDirectories,
          model: formatModelPickerValue(submissionModelSelection),
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
        await applyCronRunConfigToExistingTask({
          zcodeTaskService,
          taskId: task.taskId,
          traceId: promptTraceId,
          modelSelection: submissionModelSelection,
          mode: request.mode,
        });
      }
      if (botsService) {
        try {
          await watchCronRunBotDelivery({
            automationId: request.automationId,
            runId: promptTraceId,
            workspaceKey,
            workspacePath: request.workspacePath,
            ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
            taskId: task.taskId,
            repo,
            botsService,
          });
        } catch (error) {
          // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
          logger.warn(
            `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
            error,
          );
        }
      }
      if (disposing || disposed) {
        throw new Error("Automation executor is disposed.");
      }
      trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
      // 先注册终态与 Bot 监听再 sendPrompt，避免快速任务在 sendPrompt 返回前完成而漏接终态。
      trackCronRunOutcome({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        runId: request.runId,
        automationId: request.automationId,
        automationTitle: request.automationTitle,
        workspaceKey,
        scheduledAt,
        trigger,
      });
      dispatchedTurnSessionId = task.taskId;
      options.onTurnDispatched?.({ sessionId: task.taskId, runId: request.runId });
      await zcodeTaskService.sendPrompt({
        taskId: task.taskId,
        traceId: promptTraceId,
        content: request.prompt,
        clientMode: "desktop-continuous",
        automationId: request.automationId,
      });
      if (!request.targetTaskId) {
        options.onSessionCreated?.({
          sessionId: task.taskId,
          messageId: promptTraceId,
          workspaceIdentity: request.workspaceIdentity,
        });
      }
      return { taskId: task.taskId, sessionId: task.taskId };
    } catch (error) {
      if (trackedKey) disposeCronRunSubscription(trackedKey);
      if (dispatchedTurnSessionId) {
        options.onTurnCleared?.({ sessionId: dispatchedTurnSessionId, runId: request.runId });
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      markCronRunOutcome({
        runId: request.runId,
        automationId: request.automationId,
        workspaceKey,
        scheduledAt,
        trigger,
        outcome: "failed",
        error: errorMessage,
      });
      if (
        dispatchOptions?.emitRunFailedOnThrow ??
        options.emitDispatchRunFailureNotification ??
        true
      ) {
        options.onRunSettled?.({
          kind: "automation_failed",
          runId: request.runId,
          automationId: request.automationId,
          ...(request.automationTitle ? { automationTitle: request.automationTitle } : {}),
          detail: errorMessage,
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        });
      }
      throw error;
    }
  };

  const dispatchRun = (
    request: AutomationDispatchRequest,
  ): Promise<{ taskId: string; sessionId: string }> =>
    trackDispatch(() => dispatchRunCore(request));

  const dispatchManualRun = (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void> =>
    trackDispatch(async () => {
      logger.info(
        `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
      );
      let result: { taskId: string; sessionId: string };
      let resolvedSessionId: string | undefined = params.automation.targetTaskId;
      try {
        result = await dispatchRunCore(
          {
            automationId: params.automation.automationId,
            ...(params.automation.title ? { automationTitle: params.automation.title } : {}),
            runId: params.run.runId,
            prompt: params.automation.prompt,
            targetTaskId: params.automation.targetTaskId,
            modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
            mode: params.automation.mode,
            workspacePath: params.automation.workspacePath,
            workspaceIdentity: params.automation.workspaceIdentity,
            projectId: params.automation.projectId,
            hostId: params.automation.hostId,
            additionalDirectories: params.automation.additionalDirectories,
          },
          {
            emitRunFailedOnThrow: false,
            onSessionResolved: (sessionId) => {
              resolvedSessionId = sessionId;
            },
          },
        );
      } catch (error) {
        logger.warn(
          `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
          error,
        );
        await settleManualDispatchFailureBestEffort({
          repo,
          automationId: params.automation.automationId,
          runId: params.run.runId,
          workspaceKey: params.automation.workspaceKey,
          scheduledAt: params.run.scheduledAt ?? null,
          trigger: "manual",
          dispatchError: error,
          logWarn: (message, releaseError) => logger.warn(message, releaseError),
        });
        options.onRunSettled?.({
          kind: "automation_failed",
          runId: params.run.runId,
          automationId: params.automation.automationId,
          ...(params.automation.title ? { automationTitle: params.automation.title } : {}),
          detail: error instanceof Error ? error.message : String(error),
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
          workspacePath: params.automation.workspacePath,
          ...(params.automation.workspaceIdentity
            ? { workspaceIdentity: params.automation.workspaceIdentity }
            : {}),
        });
        throw error;
      }

      try {
        await repo.markManualRunDispatched({
          runId: params.run.runId,
          sessionId: result.sessionId,
          dispatchedAt: now(),
        });
      } catch (error) {
        // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
        // 真实终态仍由 trackCronRunOutcome 收口，避免同一 automation 重复排队。
        logger.warn(
          `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
          error,
        );
      }
      logger.info(
        `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
      );
    });

  const stopAdmission = (): void => {
    disposing = true;
  };

  const dispose = (): void => {
    disposing = true;
    disposed = true;
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
  };

  const disposeAndWait = (): Promise<void> => {
    if (disposeAndWaitPromise) return disposeAndWaitPromise;
    stopAdmission();
    disposeAndWaitPromise = (async () => {
      // 先等待全部在途 dispatchRun / dispatchManualRun（含 ACK 后的写库/失败回写）完成，
      // 再清理终态监听与 60s 心跳，最后等待已在途的 outcome 写库完成，防止关库后写库竞态。
      while (inFlightDispatches.size > 0) {
        await Promise.allSettled(inFlightDispatches);
      }
      dispose();
      while (inFlightOutcomeWrites.size > 0) {
        await Promise.allSettled(inFlightOutcomeWrites);
      }
    })();
    return disposeAndWaitPromise;
  };

  return {
    dispatchRun,
    dispatchManualRun,
    dispose,
    disposeAndWait,
  };
}
