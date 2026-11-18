import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import { alignStandaloneAutomations, assertStandaloneAutomationOwnership } from "./alignment.js";
import {
  AutomationPermanentDispatchError,
  type AutomationCronPort,
  type AutomationDispatchRequest,
  type AutomationLoggerPort,
  type AutomationRepoPort,
  type AutomationRunExecutorTargetServices,
  type AutomationRunNotificationEvent,
  type AutomationRuntimeHandle,
  type AutomationTimersPort,
} from "./contract.js";
import { createAutomationExecutor } from "./executor.js";
import { createAutomationScheduler } from "./scheduler.js";

export interface CreateAutomationRuntimeOptions {
  repo: AutomationRepoPort;
  cron: AutomationCronPort;
  resolveTargetServices: (
    request: AutomationDispatchRequest,
  ) => AutomationRunExecutorTargetServices | Promise<AutomationRunExecutorTargetServices>;
  logger: AutomationLoggerPort;
  timers?: AutomationTimersPort;
  pollIntervalMs?: number;
  misfireGraceMs?: number;
  heartbeatIntervalMs?: number;
  onSessionCreated?: (event: {
    sessionId: string;
    messageId: string;
    workspaceIdentity?: string;
  }) => void;
  onTurnDispatched?: (event: { sessionId: string; runId: string }) => void;
  onTurnCleared?: (event: { sessionId: string; runId: string }) => void;
  onRunSettled?: (event: AutomationRunNotificationEvent) => void;
  /** standalone-server 传入权威 Host 身份解析，开启启动对齐与派发前归属校验。 */
  standaloneAuthority?: {
    projectStorageHostId: string;
    localWorkspaceAliasEnabled?: boolean;
    resolveWorkspace: (workspacePath: string) => Promise<{ canonicalWorkspaceKey: string }>;
  };
}

export function createAutomationRuntime(
  options: CreateAutomationRuntimeOptions,
): AutomationRuntimeHandle {
  const { repo, cron, logger } = options;
  const inFlightManualDispatches = new Set<Promise<void>>();
  let disposed = false;
  let startPromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;

  let schedulerRef: ReturnType<typeof createAutomationScheduler> | null = null;

  const assertAutomationOwned = options.standaloneAuthority
    ? (request: AutomationDispatchRequest) =>
        assertStandaloneAutomationOwnership({
          request,
          projectStorageHostId: options.standaloneAuthority!.projectStorageHostId,
          localWorkspaceAliasEnabled: options.standaloneAuthority!.localWorkspaceAliasEnabled,
          resolveWorkspace: options.standaloneAuthority!.resolveWorkspace,
        })
    : undefined;

  const resolvedSessionIdByRunId = new Map<string, string>();
  const executor = createAutomationExecutor({
    repo,
    resolveTargetServices: options.resolveTargetServices,
    assertAutomationOwned,
    onSessionCreated: options.onSessionCreated,
    onTurnDispatched: options.onTurnDispatched,
    onTurnCleared: options.onTurnCleared,
    onRunSettled: options.onRunSettled,
    emitDispatchRunFailureNotification: false,
    onDispatchSessionResolved: ({ runId, sessionId }) => {
      resolvedSessionIdByRunId.set(runId, sessionId);
    },
    onManualClaimReleased: () => schedulerRef?.wake(),
    logger,
    timers: options.timers,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
  });

  const scheduler = createAutomationScheduler({
    repo,
    cron,
    pollIntervalMs: options.pollIntervalMs,
    misfireGraceMs: options.misfireGraceMs,
    timers: options.timers,
    logger,
    onDispatchFailed: options.onRunSettled,
    submitDispatch: async (request) => {
      try {
        const result = await executor.dispatchRun(request);
        resolvedSessionIdByRunId.delete(request.runId);
        return {
          settled: true,
          result: { ok: true, taskId: result.taskId, sessionId: result.sessionId },
        };
      } catch (error) {
        const sessionId = resolvedSessionIdByRunId.get(request.runId);
        resolvedSessionIdByRunId.delete(request.runId);
        return {
          settled: true,
          result: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            failureKind:
              error instanceof AutomationPermanentDispatchError ? "permanent" : "transient",
            ...(sessionId ? { sessionId } : {}),
          },
        };
      }
    },
  });
  schedulerRef = scheduler;

  const start = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    startPromise ??= (async () => {
      await repo.ensureReady?.();
      if (disposed) return;
      if (options.standaloneAuthority) {
        await alignStandaloneAutomations({
          repo,
          projectStorageHostId: options.standaloneAuthority.projectStorageHostId,
          localWorkspaceAliasEnabled: options.standaloneAuthority.localWorkspaceAliasEnabled,
          resolveWorkspace: options.standaloneAuthority.resolveWorkspace,
          logger,
        });
      }
      if (disposed) return;
      scheduler.start();
    })();
    return startPromise;
  };

  const dispatchManualRun = async (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void> => {
    if (disposed) {
      throw new Error("Automation runtime is disposed.");
    }
    const flight = executor.dispatchManualRun(params);
    const settled = flight.then(
      () => undefined,
      () => undefined,
    );
    inFlightManualDispatches.add(settled);
    try {
      await flight;
    } finally {
      inFlightManualDispatches.delete(settled);
    }
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    scheduler.disposeSync();
    disposePromise = (async () => {
      if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      await scheduler.dispose();
      await Promise.allSettled(inFlightManualDispatches);
      await executor.disposeAndWait();
    })();
    return disposePromise;
  };

  return {
    start,
    wake: () => scheduler.wake(),
    canAcceptManualRun: () => !disposed,
    dispatchManualRun,
    dispose,
    disposeSync: () => {
      disposed = true;
      scheduler.disposeSync();
      executor.dispose();
    },
  };
}
