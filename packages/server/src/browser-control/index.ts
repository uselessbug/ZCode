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
interface BrowserLease {
  id: string;
  descriptor: BrowserBackendDescriptor;
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
  const runtime = createManagedCdpBrowserRuntime({
    env,
    executablePath:
      options.executablePath?.trim() || env.CHROME_EXECUTABLE_PATH?.trim() || undefined,
    closeTimeoutMs: options.closeTimeoutMs,
    loadPlaywright: options.loadPlaywright ?? (() => loadServerPlaywrightChromium()),
  });
  const leases = new Map<string, BrowserLease>();
  const pending = new Map<string, PendingRequest>();
  const closing = new Map<string, Promise<void>>();
  let disposed = false;
  let closePromise: Promise<void> | undefined;
  const requestKey = (key: string, requestId: string) => JSON.stringify([key, requestId]);
  const abortPending = (key: string, turnId?: string, all = false) => {
    for (const entry of pending.values()) {
      if (entry.sessionKey === key && (all || entry.turnId === turnId)) {
        entry.controller.abort();
      }
    }
  };
  const success = () => browserCommandResultSchema.parse({ ok: true, elapsedMs: 0 });

  const executor: BrowserControlExecutor = {
    async list(input) {
      if (disposed) throw new Error("Server browser control runtime is closed");
      if (input.sessionContext === "cached") return [];
      const key = sessionKey(input);
      await closing.get(key);
      if (disposed) throw new Error("Server browser control runtime is closed");
      const id = requestKey(key, input.requestId);
      if (pending.has(id)) throw new Error("Browser request is already running");
      const entry = { controller: new AbortController(), sessionKey: key, turnId: input.turnId };
      pending.set(id, entry);
      try {
        const descriptors = await runtime.browserControlPort.list({
          sessionId: key,
          turnId: input.turnId,
          signal: entry.controller.signal,
        });
        if (disposed || entry.controller.signal.aborted) {
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
          if (lease) await runtime.browserControlPort.turnEnded?.({ sessionId: lease.id, turnId });
        }
        return success();
      }
      if (command.method === "closeSession") {
        if (input.browserId && !matches) return success();
        leases.delete(key);
        abortPending(key, undefined, true);
        if (lease) {
          const flight =
            runtime.browserControlPort.closeSession?.({ sessionId: lease.id }) ?? Promise.resolve();
          closing.set(key, flight);
          try {
            await flight;
          } finally {
            if (closing.get(key) === flight) closing.delete(key);
          }
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
            sessionId: lease.id,
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
  };
  return {
    executor,
    close() {
      if (!closePromise) {
        disposed = true;
        for (const entry of pending.values()) entry.controller.abort();
        pending.clear();
        leases.clear();
        closePromise = runtime.close();
      }
      return closePromise;
    },
  };
}
