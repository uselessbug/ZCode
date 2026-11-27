import { randomUUID } from "node:crypto";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserControlExecuteInput,
  BrowserControlListInput,
  BrowserControlPort,
  BrowserErrorCode,
} from "@zcode/contracts";
import type { Browser, BrowserContextOptions } from "playwright-core";
import { createManagedCdpDescriptor } from "./descriptor.js";
import {
  loadPlaywrightChromium,
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
  type BrowserExecutableResolutionOptions,
  type PlaywrightChromiumModule,
} from "./executable.js";
import { executeManagedPageCommand } from "./page-command.js";
import { abortError, classifyError, hasSideEffects, raceWithAbort } from "./request.js";
import { ManagedCdpSession } from "./session.js";
import { loadBrowserStorageState } from "./storage-state.js";

export interface ManagedCdpBrowserRuntimeOptions extends BrowserExecutableResolutionOptions {
  closeTimeoutMs?: number;
  loadPlaywright?: () => Promise<PlaywrightChromiumModule>;
  storageStatePath?: string;
  /** 允许缓存的已释放空闲会话上限，默认 16。 */
  maxReleasedSessions?: number;
  /** 已释放空闲会话的回收 TTL（毫秒），默认 30 分钟。 */
  releasedSessionIdleTtlMs?: number;
}

export interface ManagedCdpBrowserRuntime {
  browserControlPort: BrowserControlPort;
  close(): Promise<void>;
  /** 释放会话租约并进入空闲缓存池，保留页面与 Cookie，超出上限或 TTL 到期后再回收。 */
  releaseSession?(sessionId: string): Promise<void>;
}

interface PendingRequest {
  controller: AbortController;
  sessionId: string;
  turnId?: string;
}

interface ReleasedSessionState {
  timer: NodeJS.Timeout;
}

const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_RELEASED_SESSIONS = 16;
const DEFAULT_RELEASED_SESSION_IDLE_TTL_MS = 30 * 60_000;

class ManagedCdpBrowserControlPort implements BrowserControlPort {
  readonly #browserId = `cdp:${randomUUID()}`;
  readonly #loadPlaywright: () => Promise<PlaywrightChromiumModule>;
  readonly #options: ManagedCdpBrowserRuntimeOptions;
  readonly #closeTimeoutMs: number;
  readonly #maxReleasedSessions: number;
  readonly #releasedSessionIdleTtlMs: number;
  readonly #closingSessionIds = new Set<string>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #releasedSessions = new Map<string, ReleasedSessionState>();
  readonly #sessionEpochs = new Map<string, number>();
  readonly #sessionOpChains = new Map<string, Promise<void>>();
  readonly #sessionPromises = new Map<string, Promise<ManagedCdpSession>>();
  readonly #sessions = new Map<string, ManagedCdpSession>();
  #browser: Browser | undefined;
  #disposed = false;
  #generation = 1;
  #launchPromise: Promise<Browser> | undefined;

  constructor(options: ManagedCdpBrowserRuntimeOptions) {
    this.#options = options;
    this.#loadPlaywright = options.loadPlaywright ?? loadPlaywrightChromium;
    this.#closeTimeoutMs = Math.max(
      1,
      Math.trunc(options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS),
    );
    this.#maxReleasedSessions = Math.max(
      0,
      Math.trunc(options.maxReleasedSessions ?? DEFAULT_MAX_RELEASED_SESSIONS),
    );
    this.#releasedSessionIdleTtlMs = Math.max(
      0,
      Math.trunc(options.releasedSessionIdleTtlMs ?? DEFAULT_RELEASED_SESSION_IDLE_TTL_MS),
    );
  }

  async list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]> {
    await this.ensureBrowser(input.signal);
    await this.reactivateReleasedSession(input.sessionId);
    return [this.descriptor()];
  }

  async execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    if (input.browserId !== this.#browserId || input.browserGeneration !== this.#generation) {
      return this.errorResult(
        "backend_unavailable",
        `Browser backend '${input.browserId}' generation ${input.browserGeneration} is stale`,
        startedAt,
      );
    }

    const requestId = randomUUID();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(input.signal?.reason ?? abortError());
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    this.#pending.set(requestId, {
      controller,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });

    let dispatched = false;
    try {
      if (controller.signal.aborted) throw abortError();
      await this.ensureBrowser(controller.signal);
      const session = await this.ensureSession(input.sessionId, controller.signal);
      if (controller.signal.aborted) throw abortError();
      dispatched = true;
      const partial = await raceWithAbort(
        this.executeSessionCommand(session, input.command),
        controller.signal,
      );
      return await this.withMeta(session, input.command, partial, startedAt);
    } catch (error) {
      const code = classifyError(error);
      return this.errorResult(
        code,
        error instanceof Error ? error.message : String(error),
        startedAt,
        code === "cancelled" && dispatched && hasSideEffects(input.command)
          ? "uncertain"
          : undefined,
      );
    } finally {
      input.signal?.removeEventListener("abort", forwardAbort);
      this.#pending.delete(requestId);
    }
  }

  async turnEnded(input: BrowserControlListInput): Promise<void> {
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === input.sessionId && pending.turnId === input.turnId) {
        pending.controller.abort(abortError());
      }
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    if (this.#disposed) return;
    // 先中止当前会话在途请求，再串行化将已有 BrowserContext 迁入已释放空闲池。
    this.abortPendingForSession(sessionId);
    const evictions: Promise<void>[] = [];
    await this.runSerializedSessionOp(sessionId, async () => {
      if (this.#disposed || this.#closingSessionIds.has(sessionId)) return;
      const session = this.#sessions.get(sessionId);
      if (!session) return;
      // 已处于 released 空闲态且无新活跃操作的会话重复 release 时直接幂等返回。
      if (this.#releasedSessions.has(sessionId)) return;
      if (this.#maxReleasedSessions <= 0) {
        this.#sessions.delete(sessionId);
        await waitForPromise(session.close(), this.#closeTimeoutMs);
        if (this.#sessions.size === 0) await this.closeBrowser();
        return;
      }
      const timer = setTimeout(() => {
        void this.evictIdleSession(sessionId);
      }, this.#releasedSessionIdleTtlMs);
      timer.unref?.();
      this.#releasedSessions.set(sessionId, { timer });

      // 仅在当前 session 队列内同步摘除待 LRU 驱逐条目并从 #sessions 移除，退出当前队列锁后再关闭过期 context，避免跨 session 死锁与并发重入。
      while (this.#releasedSessions.size > this.#maxReleasedSessions) {
        const oldestSessionId = this.#releasedSessions.keys().next().value;
        if (!oldestSessionId) break;
        this.clearReleasedState(oldestSessionId);
        const evictedSession = this.#sessions.get(oldestSessionId);
        this.#sessions.delete(oldestSessionId);
        if (evictedSession) {
          evictions.push(this.evictDetachedReleasedSession(oldestSessionId, evictedSession));
        }
      }
    });
    if (evictions.length > 0) {
      await Promise.all(evictions);
    }
  }

  async closeSession(input: BrowserControlListInput): Promise<void> {
    this.#closingSessionIds.add(input.sessionId);
    this.#sessionEpochs.set(input.sessionId, (this.#sessionEpochs.get(input.sessionId) ?? 0) + 1);
    this.abortPendingForSession(input.sessionId);
    this.clearReleasedState(input.sessionId);
    try {
      const pendingChain = this.#sessionOpChains.get(input.sessionId);
      if (pendingChain) {
        await waitForPromise(pendingChain, this.#closeTimeoutMs);
      }
      const creating = this.#sessionPromises.get(input.sessionId);
      if (creating) {
        const settled = await waitForPromise(creating, this.#closeTimeoutMs);
        if (!settled) {
          // late launch/context 创建完成后仍需再次回收；epoch 递增防止它重新登记 session。
          void creating.then(
            async () => {
              if (this.#sessions.size === 0) await this.closeBrowser();
            },
            async () => {
              if (this.#sessions.size === 0) await this.closeBrowser();
            },
          );
        }
      }
      const session = this.#sessions.get(input.sessionId);
      this.#sessions.delete(input.sessionId);
      if (session) await waitForPromise(session.close(), this.#closeTimeoutMs);
      if (this.#sessions.size === 0) await this.closeBrowser();
    } finally {
      this.#closingSessionIds.delete(input.sessionId);
    }
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const launchPromise = this.#launchPromise;
    for (const pending of this.#pending.values()) pending.controller.abort(abortError());
    this.#pending.clear();
    this.clearAllReleasedStates();
    this.#closingSessionIds.clear();
    await Promise.all(
      [...this.#sessionOpChains.values()].map(async (chain) => {
        await waitForPromise(chain, this.#closeTimeoutMs);
      }),
    );
    await Promise.all(
      [...this.#sessionPromises.values()].map(async (promise) => {
        await waitForPromise(promise, this.#closeTimeoutMs);
      }),
    );
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        await waitForPromise(session.close(), this.#closeTimeoutMs);
      }),
    );
    this.#sessions.clear();
    await this.closeBrowser();
    // Playwright launch 可能仍在异步创建子进程；只关闭当前 #browser 会漏掉迟到进程。
    if (launchPromise) {
      await waitForPromise(
        launchPromise.then(async (browser) => this.closeBrowserInstance(browser)),
        this.#closeTimeoutMs,
      );
    }
  }

  private descriptor(): BrowserBackendDescriptor {
    return createManagedCdpDescriptor(this.#browserId, this.#generation);
  }

  private async ensureBrowser(signal?: AbortSignal): Promise<Browser> {
    if (this.#disposed) throw new Error("Managed CDP browser runtime is closed");
    if (signal?.aborted) throw abortError();
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launchPromise ??= (async () => {
      let playwright: PlaywrightChromiumModule;
      try {
        playwright = await this.#loadPlaywright();
      } catch (error) {
        throw new Error(
          "Managed headless Chromium is unavailable: failed to load the pinned Playwright runtime.",
          { cause: error },
        );
      }
      const executablePath = resolveInstalledBrowserExecutable(playwright, this.#options);
      let browser: Browser;
      try {
        browser = await playwright.chromium.launch({
          executablePath,
          headless: true,
          args: ["--no-first-run", "--no-default-browser-check"],
        });
      } catch (error) {
        // 底层 Playwright 错误可能包含临时 profile/CDP endpoint；对外只保留可操作分类，cause 供调试。
        throw new Error(
          "Managed headless Chromium is unavailable: launch failed. " +
            "Verify the browser executable and OS sandbox/runtime dependencies.",
          { cause: error },
        );
      }
      if (this.#disposed) {
        await this.closeBrowserInstance(browser);
        throw new Error("Managed CDP browser runtime is closed");
      }
      browser.on("disconnected", () => {
        if (this.#browser !== browser) return;
        this.#browser = undefined;
        this.clearAllReleasedStates();
        this.#sessions.clear();
        this.#generation += 1;
      });
      this.#browser = browser;
      return browser;
    })().finally(() => {
      this.#launchPromise = undefined;
    });
    const browser = signal
      ? await raceWithAbort(this.#launchPromise, signal)
      : await this.#launchPromise;
    if (signal?.aborted) {
      await this.closeBrowserInstance(browser);
      throw abortError();
    }
    return browser;
  }

  private abortPendingForSession(sessionId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === sessionId) pending.controller.abort(abortError());
    }
  }

  private hasPendingForSession(sessionId: string): boolean {
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === sessionId && !pending.controller.signal.aborted) return true;
    }
    return false;
  }

  private clearReleasedState(sessionId: string): void {
    const state = this.#releasedSessions.get(sessionId);
    if (!state) return;
    clearTimeout(state.timer);
    this.#releasedSessions.delete(sessionId);
  }

  private clearAllReleasedStates(): void {
    for (const state of this.#releasedSessions.values()) {
      clearTimeout(state.timer);
    }
    this.#releasedSessions.clear();
  }

  private runSerializedSessionOp<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#sessionOpChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionOpChains.set(sessionId, tail);
    return next.finally(() => {
      if (this.#sessionOpChains.get(sessionId) === tail) {
        this.#sessionOpChains.delete(sessionId);
      }
    });
  }

  private async reactivateReleasedSession(sessionId: string): Promise<void> {
    const hasChain = this.#sessionOpChains.has(sessionId);
    this.clearReleasedState(sessionId);
    if (!hasChain) return;
    await this.runSerializedSessionOp(sessionId, async () => {
      this.clearReleasedState(sessionId);
    });
  }

  private async evictIdleSession(sessionId: string): Promise<void> {
    await this.runSerializedSessionOp(sessionId, async () => {
      const released = this.#releasedSessions.get(sessionId);
      if (!released || this.#disposed || this.hasPendingForSession(sessionId)) return;
      this.clearReleasedState(sessionId);
      const session = this.#sessions.get(sessionId);
      this.#sessions.delete(sessionId);
      if (session) await waitForPromise(session.close(), this.#closeTimeoutMs);
      if (this.#sessions.size === 0 && !this.#disposed) await this.closeBrowser();
    });
  }

  private async evictDetachedReleasedSession(
    sessionId: string,
    session: ManagedCdpSession,
  ): Promise<void> {
    await this.runSerializedSessionOp(sessionId, async () => {
      await waitForPromise(session.close(), this.#closeTimeoutMs);
      if (this.#sessions.size === 0 && !this.#disposed) await this.closeBrowser();
    });
  }

  private async ensureSession(sessionId: string, signal?: AbortSignal): Promise<ManagedCdpSession> {
    this.clearReleasedState(sessionId);
    return await this.runSerializedSessionOp(sessionId, async () => {
      if (signal?.aborted) throw abortError();
      if (this.#closingSessionIds.has(sessionId)) {
        throw new Error(`Browser session '${sessionId}' is closing`);
      }
      const existing = this.#sessions.get(sessionId);
      if (existing) {
        // 同一 sessionId 再次活跃时取消空闲回收定时器并复用原 BrowserContext。
        this.clearReleasedState(sessionId);
        return existing;
      }
      const creating = this.#sessionPromises.get(sessionId);
      if (creating) return await creating;

      const startEpoch = this.#sessionEpochs.get(sessionId) ?? 0;
      const promise = (async () => {
        const browser = await this.ensureBrowser(signal);
        const generation = this.#generation;
        const storageStatePath = this.#options.storageStatePath;
        const storageState = storageStatePath
          ? (await loadBrowserStorageState(storageStatePath)).state
          : undefined;
        const context = await browser.newContext({
          acceptDownloads: false,
          viewport: { width: 1280, height: 720 },
          ...(storageState
            ? { storageState: storageState as BrowserContextOptions["storageState"] }
            : {}),
        });
        if (
          this.#disposed ||
          signal?.aborted ||
          this.#closingSessionIds.has(sessionId) ||
          (this.#sessionEpochs.get(sessionId) ?? 0) !== startEpoch ||
          this.#browser !== browser ||
          this.#generation !== generation ||
          !browser.isConnected()
        ) {
          await waitForPromise(context.close(), this.#closeTimeoutMs);
          if (signal?.aborted) throw abortError();
          throw new Error("Managed CDP browser context became unavailable during creation");
        }
        const session = new ManagedCdpSession(context);
        this.#sessions.set(sessionId, session);
        return session;
      })();
      this.#sessionPromises.set(sessionId, promise);
      try {
        return await promise;
      } finally {
        if (this.#sessionPromises.get(sessionId) === promise) {
          this.#sessionPromises.delete(sessionId);
        }
      }
    });
  }

  private async executeSessionCommand(
    session: ManagedCdpSession,
    command: BrowserCommand,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    switch (command.method) {
      case "list":
        return { ok: true, tabs: await session.listTabs() };
      case "newTab": {
        const tab = await session.createTab();
        return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
      }
      case "activateTab": {
        const tab = await session.activateTab(command.tabId);
        return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
      }
      case "close":
        await session.closeTab(command.tabId);
        return { ok: true };
      case "browserViewportSet":
        await session.setViewport(command.tabId, { width: command.width, height: command.height });
        return { ok: true };
      case "browserViewportReset":
        await session.setViewport(command.tabId, null);
        return { ok: true };
      case "getDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        const type = dialog?.type();
        return {
          ok: true,
          dialog:
            dialog && type && ["alert", "confirm", "prompt", "beforeunload"].includes(type)
              ? {
                  type: type as "alert" | "confirm" | "prompt" | "beforeunload",
                  message: dialog.message(),
                  ...(dialog.defaultValue() ? { defaultPrompt: dialog.defaultValue() } : {}),
                }
              : null,
        };
      }
      case "handleDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        if (!dialog) throw new Error("No JavaScript dialog is pending for this tab");
        if (command.accept) await dialog.accept(command.promptText);
        else await dialog.dismiss();
        session.clearDialog(tab.id);
        return { ok: true };
      }
      case "nameSession":
        return { ok: true };
      case "listUserTabs":
        return { ok: true, userTabs: [] };
      case "browserVisibilityGet":
      case "browserVisibilitySet":
      case "capabilities":
      case "claimTab":
      case "finalize":
      case "finalizeTabs":
      case "markDeliverable":
      case "markHandoff":
      case "turnEnded":
      case "closeSession":
      case "cancelRequest":
        return {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: `Browser command '${command.method}' is unavailable in managed headless CDP`,
          },
        };
      default: {
        const tab = await session.ensureTab("tabId" in command ? command.tabId : undefined);
        return await executeManagedPageCommand(tab.page, command);
      }
    }
  }

  private async withMeta(
    session: ManagedCdpSession,
    command: BrowserCommand,
    partial: Omit<BrowserCommandResult, "elapsedMs">,
    startedAt: number,
  ): Promise<BrowserCommandResult> {
    const tabId = "tabId" in command ? command.tabId : session.activeTabId;
    const active = tabId ? await session.ensureTab(tabId).catch(() => undefined) : undefined;
    return {
      ...partial,
      elapsedMs: Date.now() - startedAt,
      meta: {
        browserUse: true,
        backendType: "cdp",
        browserId: this.#browserId,
        browserGeneration: this.#generation,
        openTabIds: session.tabIds,
        ...(active ? { tabId: active.id, currentUrl: active.page.url(), lifecycle: "active" } : {}),
      },
    };
  }

  private errorResult(
    code: BrowserErrorCode,
    message: string,
    startedAt: number,
    sideEffect?: "uncertain",
  ): BrowserCommandResult {
    return {
      ok: false,
      error: { code, message, ...(sideEffect ? { sideEffect } : {}) },
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser) await this.closeBrowserInstance(browser);
  }

  private async closeBrowserInstance(browser: Browser): Promise<void> {
    if (!browser.isConnected()) return;
    // WebSocket/SSE 页面可能让 Playwright 的 context/browser close 永不 settle。
    // adapter 只能有限等待；外层 session cleanup 和 CLI watchdog 会继续回收其它资源。
    await waitForPromise(browser.close(), this.#closeTimeoutMs);
  }
}

export function createManagedCdpBrowserRuntime(
  options: ManagedCdpBrowserRuntimeOptions = {},
): ManagedCdpBrowserRuntime {
  const normalizedOptions = {
    ...options,
    executablePath: validateExplicitBrowserExecutable(options.executablePath, options.platform),
  };
  const port = new ManagedCdpBrowserControlPort(normalizedOptions);
  return {
    browserControlPort: port,
    close: async () => port.close(),
    releaseSession: async (sessionId) => port.releaseSession(sessionId),
  };
}

export {
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
} from "./executable.js";
export type { BrowserExecutableResolutionOptions, PlaywrightChromiumModule } from "./executable.js";
export { isAllowedManagedBrowserUrl } from "./page-command.js";
export {
  BrowserStateFileError,
  loadBrowserStorageState,
  resolveDefaultBrowserStatePath,
} from "./storage-state.js";
export type {
  BrowserStateCookie,
  BrowserStateFileErrorCode,
  BrowserStateLoadResult,
  BrowserStateOrigin,
  BrowserStorageState,
  LoadBrowserStorageStateOptions,
} from "./storage-state.js";

function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
