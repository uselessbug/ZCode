import { randomUUID } from "node:crypto";
import { createManagedCdpBrowserRuntime } from "@zcode/adapters/browser";
import type { BrowserControlExecutor } from "@zcode/services/node";
import {
  browserBackendDescriptorSchema,
  browserCommandResultSchema,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
} from "@zcode/shared";
import type { ServerBrowserControlHandle, ServerBrowserControlOptions } from "./contract.js";
import { loadServerPlaywrightChromium } from "./playwrightLoader.js";

export type { ServerBrowserControlHandle, ServerBrowserControlOptions } from "./contract.js";
export {
  loadServerPlaywrightChromium,
  resolvePackagedAgentEntryPath,
  type ServerPlaywrightLoaderOptions,
} from "./playwrightLoader.js";

type ExecuteInput = Parameters<BrowserControlExecutor["execute"]>[0];
type ManagedCdpRuntimeOptions = Parameters<typeof createManagedCdpBrowserRuntime>[0] & {
  maxReleasedSessions?: number;
  releasedSessionIdleTtlMs?: number;
};
type ManagedCdpRuntime = ReturnType<typeof createManagedCdpBrowserRuntime> & {
  releaseSession?(sessionId: string): Promise<void>;
};
interface BrowserLease {
  id: string;
  descriptor: BrowserBackendDescriptor;
}
interface TrackedSession {
  key: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}
interface PendingRequest {
  controller: AbortController;
  sessionKey: string;
  turnId?: string;
}

function sessionKey(input: {
  workspaceKey: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
  sessionId: string;
}): string {
  return JSON.stringify([
    input.workspaceKey,
    input.remoteSessionId ?? null,
    input.clientMode,
    input.sessionId,
  ]);
}

function reject(input: ExecuteInput, message: string) {
  return browserCommandResultSchema.parse({
    ok: false,
    ...(input.command.method === "openScope" && input.controlScopeId
      ? { scope: { id: input.controlScopeId, state: "rejected" } }
      : {}),
    error: { code: "backend_unavailable", message, sideEffect: "none" },
    elapsedMs: 0,
  });
}

export function isStandaloneBrowserControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.ZCODE_STANDALONE_BROWSER_USE?.trim();
  if (explicit === "0") return false;
  if (explicit === "1") return true;
  return env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS?.trim() === "1";
}

export function createServerBrowserControl(
  options: ServerBrowserControlOptions = {},
): ServerBrowserControlHandle {
  const env = options.env ?? process.env;
  const runtimeOptions: ManagedCdpRuntimeOptions = {
    env,
    executablePath:
      options.executablePath?.trim() || env.CHROME_EXECUTABLE_PATH?.trim() || undefined,
    closeTimeoutMs: options.closeTimeoutMs,
    ...(options.maxReleasedSessions !== undefined
      ? { maxReleasedSessions: options.maxReleasedSessions }
      : {}),
    ...(options.releasedSessionIdleTtlMs !== undefined
      ? { releasedSessionIdleTtlMs: options.releasedSessionIdleTtlMs }
      : {}),
    loadPlaywright: options.loadPlaywright ?? (() => loadServerPlaywrightChromium()),
  };
  const runtime = createManagedCdpBrowserRuntime(runtimeOptions) as ManagedCdpRuntime;
  const leases = new Map<string, BrowserLease>();
  const trackedSessions = new Map<string, TrackedSession>();
  const sessionEpochs = new Map<string, number>();
  const pending = new Map<string, PendingRequest>();
  // 同一 sessionKey 上的 list / closeSession / closeTaskSessions 共享同一串行链，
  // 防止迟到旧 list 在 closeTaskSessions 之后误关新租约刚建好的上下文。
  const sessionOpChains = new Map<string, Promise<void>>();
  let disposed = false;
  let closePromise: Promise<void> | undefined;
  const requestKey = (key: string, requestId: string) => JSON.stringify([key, requestId]);
  const currentEpoch = (key: string) => sessionEpochs.get(key) ?? 0;
  const bumpEpoch = (key: string) => {
    const next = currentEpoch(key) + 1;
    sessionEpochs.set(key, next);
    return next;
  };
  const hasPendingForKey = (key: string) => {
    for (const entry of pending.values()) {
      if (entry.sessionKey === key) return true;
    }
    return false;
  };
  const abortPending = (key: string, turnId?: string, all = false) => {
    for (const entry of pending.values()) {
      if (entry.sessionKey === key && (all || entry.turnId === turnId)) {
        entry.controller.abort();
      }
    }
  };
  const success = () => browserCommandResultSchema.parse({ ok: true, elapsedMs: 0 });
  const runSerializedSessionOp = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = sessionOpChains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    sessionOpChains.set(key, tail);
    return next.finally(() => {
      if (sessionOpChains.get(key) === tail) {
        sessionOpChains.delete(key);
      }
    });
  };
  const destroySessionContext = async (key: string): Promise<void> => {
    bumpEpoch(key);
    leases.delete(key);
    trackedSessions.delete(key);
    abortPending(key, undefined, true);
    await runSerializedSessionOp(key, async () => {
      await runtime.browserControlPort.closeSession?.({ sessionId: key });
    });
  };
  const releaseSessionContext = async (key: string): Promise<void> => {
    const hadLease = leases.delete(key);
    abortPending(key, undefined, true);
    if (!hadLease) return;
    // 普通关闭仅释放租约并把 BrowserContext 放入空闲驻留池，保留页面与 Cookie；
    // 底层尚不支持 releaseSession 时降级走 closeSession。
    await runSerializedSessionOp(key, async () => {
      if (typeof runtime.releaseSession === "function") {
        await runtime.releaseSession(key);
      } else {
        await runtime.browserControlPort.closeSession?.({ sessionId: key });
      }
    });
  };

  const executor: BrowserControlExecutor = {
    async list(input) {
      if (disposed) throw new Error("Server browser control runtime is closed");
      if (input.sessionContext === "cached") return [];
      const key = sessionKey(input);
      const id = requestKey(key, input.requestId);
      if (pending.has(id)) throw new Error("Browser request is already running");
      const entry = { controller: new AbortController(), sessionKey: key, turnId: input.turnId };
      const listEpoch = currentEpoch(key);
      // 在进入异步串行队列前同步登记追踪条目与 pending，确保同一事件循环紧接着调用的
      // closeTaskSessions（无 await 间隔）也能立即命中、递增代次并取消本次首次发现。
      trackedSessions.set(key, {
        key,
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        sessionId: input.sessionId,
      });
      pending.set(id, entry);
      try {
        return await runSerializedSessionOp(key, async () => {
          if (disposed || entry.controller.signal.aborted || currentEpoch(key) !== listEpoch) {
            throw new Error("Browser discovery was cancelled");
          }
          try {
            const descriptors = await runtime.browserControlPort.list({
              sessionId: key,
              turnId: input.turnId,
              signal: entry.controller.signal,
            });
            if (disposed || entry.controller.signal.aborted || currentEpoch(key) !== listEpoch) {
              // 若因 closeTaskSessions 递增代次而失效，紧随本槽位之后排队的销毁操作会负责关闭上下文；
              // 本次旧请求自身不再越权调用 closeSession，避免跨代次误关后续新租约。
              throw new Error("Browser discovery was cancelled");
            }
            return descriptors.map((value) => {
              const descriptor = browserBackendDescriptorSchema.parse(value);
              let lease = leases.get(key);
              if (
                !lease ||
                lease.descriptor.id !== descriptor.id ||
                lease.descriptor.generation !== descriptor.generation
              ) {
                lease = { id: `${descriptor.id}:${randomUUID()}`, descriptor };
                leases.set(key, lease);
              }
              return { ...descriptor, id: lease.id };
            });
          } catch (error) {
            if (currentEpoch(key) === listEpoch && !leases.has(key)) {
              if (pending.get(id) === entry) pending.delete(id);
              if (!hasPendingForKey(key)) trackedSessions.delete(key);
            }
            throw error;
          }
        });
      } finally {
        if (pending.get(id) === entry) pending.delete(id);
      }
    },
    async execute(input) {
      if (disposed) return reject(input, "Server browser control runtime is closed");
      const key = sessionKey(input);
      const lease = leases.get(key);
      const matches =
        lease &&
        (!input.browserId || input.browserId === lease.id) &&
        (input.browserGeneration === undefined ||
          input.browserGeneration === lease.descriptor.generation);
      const { command } = input;
      // 生命周期先分流；迟到的旧租约清理不能关闭重新恢复的会话。
      if (command.method === "cancelRequest") {
        const target = pending.get(requestKey(key, command.requestId));
        const cancelled = Boolean(target && (!input.browserId || matches));
        if (cancelled) target?.controller.abort();
        return browserCommandResultSchema.parse({ ok: true, value: { cancelled }, elapsedMs: 0 });
      }
      if (command.method === "turnEnded") {
        if (!input.browserId || matches) {
          const turnId = command.turnId ?? input.turnId;
          abortPending(key, turnId);
          if (lease) await runtime.browserControlPort.turnEnded?.({ sessionId: key, turnId });
        }
        return success();
      }
      if (command.method === "closeSession") {
        if (input.browserId && !matches) return success();
        if (command.closeTabs === true) {
          await destroySessionContext(key);
        } else {
          await releaseSessionContext(key);
        }
        return success();
      }
      if (
        input.controlScopeId ||
        command.method === "openScope" ||
        command.method === "releaseScope"
      ) {
        return reject(input, "Browser control scopes are not supported by standalone headless CDP");
      }
      if (input.sessionContext === "cached") return reject(input, "Browser session is cached");
      if (!lease || !matches || !input.browserId || input.browserGeneration === undefined) {
        return reject(input, "Browser lease is unavailable; discover the backend again");
      }
      const id = requestKey(key, input.requestId);
      if (pending.has(id))
        return browserCommandResultSchema.parse({
          ok: false,
          error: { code: "duplicate_request_id", message: "Browser request is already running" },
          elapsedMs: 0,
        });
      const entry = { controller: new AbortController(), sessionKey: key, turnId: input.turnId };
      pending.set(id, entry);
      try {
        const result = browserCommandResultSchema.parse(
          await runtime.browserControlPort.execute({
            browserId: lease.descriptor.id,
            browserGeneration: lease.descriptor.generation,
            sessionId: key,
            turnId: input.turnId,
            signal: entry.controller.signal,
            command,
          }),
        );
        return {
          ...result,
          ...(result.meta ? { meta: { ...result.meta, browserId: lease.id } } : {}),
        };
      } finally {
        if (pending.get(id) === entry) pending.delete(id);
      }
    },
    async closeTaskSessions(params) {
      if (disposed || params.sessionIds.length === 0) return;
      const sessionIds = new Set(params.sessionIds);
      const targetWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      const targetIdentity = params.workspaceIdentity?.trim();
      const matchedKeys = [...trackedSessions.values()]
        .filter((entry) => {
          if (!sessionIds.has(entry.sessionId)) return false;
          if (entry.workspaceKey === targetWorkspaceKey) return true;
          if (entry.workspacePath !== params.workspacePath) return false;
          const entryIdentity =
            entry.workspaceIdentity?.trim() ||
            (entry.workspaceKey !== entry.workspacePath ? entry.workspaceKey : undefined);
          return !targetIdentity || !entryIdentity || entryIdentity === targetIdentity;
        })
        .map((entry) => entry.key);
      if (matchedKeys.length === 0) return;
      await Promise.all(matchedKeys.map((key) => destroySessionContext(key)));
    },
  };
  return {
    executor,
    close() {
      if (!closePromise) {
        disposed = true;
        for (const entry of pending.values()) entry.controller.abort();
        pending.clear();
        leases.clear();
        trackedSessions.clear();
        sessionEpochs.clear();
        closePromise = runtime.close();
      }
      return closePromise;
    },
  };
}
