import type {
  ModelSelection,
  TraceId,
  ZCodeAutomation,
  ZCodeAutomationBotDeliveryTarget,
  ZCodeAutomationRun,
  ZCodeAutomationRunDispatchStatus,
  ZCodeAutomationRunOutcome,
  ZCodeAutomationTrigger,
  ZCodeTaskMode,
} from "@zcode/shared";

export const AUTOMATION_POLL_INTERVAL_MS = 20_000;
export const AUTOMATION_MISFIRE_GRACE_MS = 5 * 60_000;
export const AUTOMATION_MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export class AutomationPermanentDispatchError extends Error {
  readonly failureKind = "permanent" as const;

  constructor(message: string) {
    super(message);
    this.name = "AutomationPermanentDispatchError";
  }
}

export interface AutomationDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

export type AutomationDispatchSettlement =
  | {
      ok: true;
      taskId?: string;
      sessionId?: string;
    }
  | {
      ok: false;
      error: string;
      failureKind?: "transient" | "permanent";
    };

export interface AutomationTimersPort {
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

export interface AutomationLoggerPort {
  info: (message: string, details?: unknown) => void;
  warn: (message: string, error?: unknown) => void;
  error: (message: string, error?: unknown) => void;
}

export interface AutomationModelSelectionPort {
  getView: (input?: { selection: ModelSelection | null }) => Promise<{
    selectionIssue?: unknown;
    effectiveSelection?: ModelSelection | null;
    preferredSelection?: ModelSelection | null;
  }>;
}

export interface AutomationBotDeliveryPort {
  watchAutomationRun: (params: {
    target: ZCodeAutomationBotDeliveryTarget;
    runId?: string;
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}

export interface AutomationTaskServicePort {
  createTask: (params: {
    projectId?: string | null;
    workspacePath: string;
    workspaceIdentity?: string;
    additionalDirectories?: string[];
    model?: string;
    mode?: ZCodeTaskMode;
    thoughtLevel?: string;
    automationId?: string;
  }) => Promise<{ taskId: string }>;
  resumeTask: (params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    additionalDirectories?: string[];
    model?: string;
    thoughtLevel?: string;
    automationId?: string;
  }) => Promise<unknown>;
  setAutomationSessionConfig: (params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: ZCodeTaskMode;
  }) => Promise<unknown>;
  setConfigOption: (params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }) => Promise<unknown>;
  sendPrompt: (params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    clientMode?: "desktop-continuous" | "web-remote-replayable";
    automationId: string;
  }) => Promise<unknown>;
  setTaskUnread: (params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
  }) => Promise<unknown>;
  onDynamicTaskTerminalOutcome: (taskId: string) => (
    listener: (event: {
      taskId: string;
      inputId?: string;
      outcome: "succeeded" | "failed" | "stopped";
      error?: string;
    }) => void,
  ) => {
    dispose: () => void;
  };
}

export interface AutomationRunExecutorTargetServices {
  taskService: AutomationTaskServicePort;
  modelSelectionService: AutomationModelSelectionPort;
  botsService?: AutomationBotDeliveryPort;
}

export interface AutomationRepoPort {
  ensureReady?: () => Promise<void>;
  list: () => Promise<ZCodeAutomation[]>;
  get: (automationId: string, workspaceKey?: string) => Promise<ZCodeAutomation | null>;
  getRun: (runId: string) => Promise<ZCodeAutomationRun | null>;
  getModelSelectionForDispatch: (
    automationId: string,
    workspaceKey: string,
  ) => Promise<ModelSelection | undefined>;
  fixRunModelSelection: (runId: string, selection: ModelSelection) => Promise<ModelSelection>;
  getBotDeliveryTarget: (
    automationId: string,
    workspaceKey?: string,
  ) => Promise<ZCodeAutomationBotDeliveryTarget | undefined>;
  claimDue: (now: number) => Promise<ZCodeAutomation[]>;
  claimManualRuns: (
    now: number,
  ) => Promise<Array<{ automation: ZCodeAutomation; run: ZCodeAutomationRun }>>;
  upsertRunClaimed: (params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }) => Promise<void>;
  ensureRunClaimed: (params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }) => Promise<void>;
  markRunDispatch: (params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }) => Promise<void>;
  markScheduleRunDispatched: (params: {
    runId: string;
    automationId: string;
    sessionId?: string | null;
    dispatchedAt: number;
    nextRunAt: number | null;
  }) => Promise<boolean>;
  markManualRunDispatched: (params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }) => Promise<boolean>;
  markDispatchFailed: (
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      nextRunAt?: number | null;
    },
  ) => Promise<void>;
  markRunOutcome: (
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ) => Promise<void>;
  skipAndReschedule: (params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }) => Promise<void>;
  releaseClaim: (automationId: string) => Promise<void>;
  releaseManualClaim: (automationId: string, workspaceKey: string) => Promise<void>;
  touchManualClaim: (automationId: string, workspaceKey: string) => Promise<void>;
  alignStandaloneWorkspaceIdentity?: (params: {
    automationId: string;
    expectedOldWorkspaceKey: string;
    canonicalWorkspaceKey: string;
    hostId: string;
  }) => Promise<boolean>;
}

export interface AutomationCronPort {
  computeNextRunAt: (
    automation: Pick<ZCodeAutomation, "cronExpr" | "scheduleRule">,
    from?: number,
  ) => number | null;
  isOneShotAutomation: (automation: Pick<ZCodeAutomation, "recurring" | "maxRuns">) => boolean;
}

export interface AutomationExecutorHandle {
  /** 执行单次 schedule / manual run；先注册终态与 Bot 监听再 sendPrompt。 */
  dispatchRun: (
    request: AutomationDispatchRequest,
  ) => Promise<{ taskId: string; sessionId: string }>;
  /** 立即执行 manual run，结算 run 台账与失败回滚；disposing/disposed 后立即拒绝且不写库。 */
  dispatchManualRun: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** 停止接纳新派发并同步释放所有在途终态监听与心跳。 */
  dispose: () => void;
  /** 停止新派发 admission，等待全部在途派发 ACK 与结果写库完成后清理监听。 */
  disposeAndWait: () => Promise<void>;
}

export interface AutomationSchedulerHandle {
  start: () => void;
  wake: () => void;
  settleDispatchResult: (msg: { runId: string } & AutomationDispatchSettlement) => Promise<void>;
  dispose: () => Promise<void>;
  disposeSync: () => void;
}

export interface AutomationRuntimeHandle {
  /** 执行可选启动身份对齐后开启 20s 轮询与首次 tick。 */
  start(): Promise<void>;
  /** 合并并发唤醒，tick 完成后立即补跑。 */
  wake(): void;
  /** 是否仍接纳新的 manual run 派发。 */
  canAcceptManualRun(): boolean;
  dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }): Promise<void>;
  /** 停新 admission 与 timer，等待在途派发 ACK 结算后清理监听与心跳。 */
  dispose(): Promise<void>;
  disposeSync(): void;
}
