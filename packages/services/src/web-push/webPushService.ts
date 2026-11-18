import { join } from "node:path";
import {
  buildAutomationNotificationTag,
  buildInteractionNotificationTag,
  buildTerminalTaskNotificationTag,
  formatWebPushNotificationCopy,
  type WebPushConfigResponse,
  type WebPushNotificationMessage,
  type WebPushSubscribeRequest,
  type WebPushSubscribeResponse,
  type WebPushSupportedLocale,
  type WebPushUnsubscribeResponse,
} from "@zcode/shared/web-push";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir } from "#src/paths.js";
import {
  type CreateWebPushServiceOptions,
  type IWebPushService,
  type WebPushAutomationEventInput,
  type WebPushSessionEventInput,
} from "./contract.js";
import {
  encodeWebPushMessageWithBudget,
  encryptWebPushPayload,
  loadOrCreateVapidKeys,
  signVapidJwt,
  validateSubscriptionKeys,
  type VapidKeyMaterial,
} from "./crypto.js";
import { validatePushEndpoint } from "./endpointPolicy.js";
import { createSafeWebPushTransport } from "./outboundTransport.js";
import { WebPushSubscriptionStore, type StoredWebPushSubscription } from "./subscriptionStore.js";

const DEFAULT_VAPID_SUBJECT = "mailto:noreply@zcode.local";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const INTERACTION_TTL_SECONDS = 3600;
const TERMINAL_TTL_SECONDS = 86_400;
const MAX_DELIVERED_EVENT_IDS = 1024;
const AUTOMATION_OWNED_TURN_TTL_MS = 2 * 60 * 60 * 1000;

const logger = createServiceLogger("web-push");

class BoundedEventDeduplicator {
  private readonly ids = new Set<string>();

  remember(eventId: string): boolean {
    if (this.ids.has(eventId)) {
      // Refresh LRU position.
      this.ids.delete(eventId);
      this.ids.add(eventId);
      return false;
    }
    this.ids.add(eventId);
    if (this.ids.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
      }
    }
    return true;
  }
}

interface PendingInteractionToken {
  cancelled: boolean;
}

export function createWebPushService(options: CreateWebPushServiceOptions = {}): IWebPushService {
  const storageDir = options.storageDir ?? join(getAppConfigDir(), "web-push");
  const vapidFilePath = join(storageDir, "vapid.json");
  const subscriptionsFilePath = join(storageDir, "subscriptions.json");
  const subject =
    options.subject?.trim() || process.env.ZCODE_WEB_PUSH_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;
  const allowLoopbackEndpoint = options.allowLoopbackEndpoint === true;
  const sendImpl = options.sendImpl ?? createSafeWebPushTransport({ allowLoopbackEndpoint });
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const store = new WebPushSubscriptionStore(subscriptionsFilePath, now);
  const deliveredEvents = new BoundedEventDeduplicator();
  const automationOwnedTurns = new Map<string, Map<string, number>>();
  const pendingInteractionTokens = new Map<string, Set<PendingInteractionToken>>();
  const inFlight = new Set<Promise<void>>();

  let vapidPromise: Promise<VapidKeyMaterial> | null = null;
  let disposed = false;

  const getVapidKeys = (): Promise<VapidKeyMaterial> => {
    if (!vapidPromise) {
      vapidPromise = loadOrCreateVapidKeys(vapidFilePath).catch((error: unknown) => {
        vapidPromise = null;
        throw error;
      });
    }
    return vapidPromise;
  };

  const pruneExpiredAutomationTurns = (currentNow: number): void => {
    for (const [sessionId, runs] of automationOwnedTurns) {
      for (const [runId, markedAt] of runs) {
        if (currentNow - markedAt >= AUTOMATION_OWNED_TURN_TTL_MS) {
          runs.delete(runId);
        }
      }
      if (runs.size === 0) {
        automationOwnedTurns.delete(sessionId);
      }
    }
  };

  const consumeAutomationOwnedSessionTurn = (sessionId: string): boolean => {
    const cleanSessionId = sessionId.trim();
    if (!cleanSessionId) return false;
    const currentNow = now();
    pruneExpiredAutomationTurns(currentNow);
    const runs = automationOwnedTurns.get(cleanSessionId);
    if (!runs || runs.size === 0) return false;
    const oldestRunId = runs.keys().next().value;
    if (oldestRunId === undefined) return false;
    runs.delete(oldestRunId);
    if (runs.size === 0) {
      automationOwnedTurns.delete(cleanSessionId);
    }
    return true;
  };

  const enqueueDelivery = (task: () => Promise<void>): void => {
    if (disposed) return;
    const promise = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        logger.warn(undefined, "Web Push 异步投递失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
  };

  const sendToSubscription = async (
    subscription: StoredWebPushSubscription,
    vapid: VapidKeyMaterial,
    message: WebPushNotificationMessage,
    ttlSeconds: number,
    isCancelled?: () => boolean,
  ): Promise<"ok" | "gone" | "error" | "cancelled"> => {
    if (isCancelled?.() || disposed) {
      return "cancelled";
    }

    let endpointUrl: URL;
    let uaPublic: Buffer;
    let authSecret: Buffer;
    try {
      endpointUrl = validatePushEndpoint(subscription.endpoint, { allowLoopbackEndpoint });
      ({ uaPublic, authSecret } = validateSubscriptionKeys(subscription.keys));
    } catch (error) {
      logger.warn(undefined, "跳过无效 Web Push 订阅", {
        endpoint: subscription.endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
      return "gone";
    }

    try {
      const plaintext = encodeWebPushMessageWithBudget(message);
      const encryptedBody = encryptWebPushPayload({
        plaintext,
        uaPublic,
        authSecret,
      });
      const jwt = signVapidJwt({
        endpoint: endpointUrl.toString(),
        subject,
        privateKey: vapid.privateKey,
        nowSeconds: Math.floor(now() / 1000),
      });

      if (isCancelled?.() || disposed) {
        return "cancelled";
      }

      const response = await sendImpl({
        url: endpointUrl.toString(),
        headers: {
          Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(ttlSeconds),
          Urgency: "high",
        },
        body: new Uint8Array(encryptedBody),
        timeoutMs: requestTimeoutMs,
      });

      if (response.status === 404 || response.status === 410) {
        return "gone";
      }
      if (response.status < 200 || response.status >= 300) {
        logger.warn(undefined, "Web Push 投递返回非成功状态", {
          endpoint: endpointUrl.origin,
          status: response.status,
          eventId: message.eventId,
        });
        return "error";
      }
      return "ok";
    } catch (error) {
      logger.warn(undefined, "Web Push 投递请求异常", {
        endpoint: endpointUrl.origin,
        eventId: message.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "error";
    }
  };

  const broadcastMessage = async (
    buildForLocale: (locale: WebPushSupportedLocale) => WebPushNotificationMessage,
    ttlSeconds: number,
    isCancelled?: () => boolean,
  ): Promise<void> => {
    if (isCancelled?.() || disposed) return;
    const subscriptions = await store.list();
    if (subscriptions.length === 0 || isCancelled?.() || disposed) return;

    const vapid = await getVapidKeys();
    if (isCancelled?.() || disposed) return;

    const messageCache = new Map<string, WebPushNotificationMessage>();
    const getMessage = (
      locale: WebPushSupportedLocale,
      soundEnabled: boolean,
    ): WebPushNotificationMessage => {
      const cacheKey = `${locale}:${soundEnabled ? "1" : "0"}`;
      let cached = messageCache.get(cacheKey);
      if (!cached) {
        const base = buildForLocale(locale);
        cached = soundEnabled ? base : { ...base, silent: true };
        messageCache.set(cacheKey, cached);
      }
      return cached;
    };

    const goneTargets: Array<{ endpoint: string; expectedRevision: string }> = [];
    await Promise.all(
      subscriptions.map(async (sub) => {
        const result = await sendToSubscription(
          sub,
          vapid,
          getMessage(sub.locale, sub.soundEnabled),
          ttlSeconds,
          isCancelled,
        );
        if (result === "gone") {
          goneTargets.push({ endpoint: sub.endpoint, expectedRevision: sub.revision });
        }
      }),
    );

    if (goneTargets.length > 0) {
      await store.removeManyIfUnchanged(goneTargets).catch((error: unknown) => {
        logger.warn(undefined, "清理失效 Web Push 订阅失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  return {
    async getConfig(): Promise<WebPushConfigResponse> {
      const vapid = await getVapidKeys();
      return {
        enabled: true,
        vapidPublicKey: vapid.publicKey,
      };
    },

    async upsertSubscription(request: WebPushSubscribeRequest): Promise<WebPushSubscribeResponse> {
      const endpointUrl = validatePushEndpoint(request.subscription.endpoint, {
        allowLoopbackEndpoint,
      });
      validateSubscriptionKeys(request.subscription.keys);
      const normalizedEndpoint = endpointUrl.toString();
      await store.upsert({
        ...request,
        subscription: {
          ...request.subscription,
          endpoint: normalizedEndpoint,
        },
      });
      return {
        ok: true,
        endpoint: normalizedEndpoint,
      };
    },

    async removeSubscription(endpoint: string): Promise<WebPushUnsubscribeResponse> {
      const trimmed = endpoint.trim();
      let normalized = trimmed;
      try {
        normalized = new URL(trimmed).toString();
      } catch {
        // Allow best-effort exact match removal if non-URL string was passed.
      }
      const removed =
        (await store.remove(normalized)) ||
        (normalized !== trimmed && (await store.remove(trimmed)));
      return {
        ok: true,
        removed,
      };
    },

    markAutomationOwnedSessionTurn(sessionId: string, runId: string): void {
      const cleanSessionId = sessionId.trim();
      const cleanRunId = runId.trim();
      if (!cleanSessionId || !cleanRunId) return;
      const currentNow = now();
      pruneExpiredAutomationTurns(currentNow);
      let runs = automationOwnedTurns.get(cleanSessionId);
      if (!runs) {
        runs = new Map();
        automationOwnedTurns.set(cleanSessionId, runs);
      }
      runs.set(cleanRunId, currentNow);
    },

    clearAutomationOwnedSessionTurn(sessionId: string, runId?: string): void {
      const cleanSessionId = sessionId.trim();
      if (!cleanSessionId) return;
      if (runId !== undefined) {
        const cleanRunId = runId.trim();
        const runs = automationOwnedTurns.get(cleanSessionId);
        if (!runs) return;
        runs.delete(cleanRunId);
        if (runs.size === 0) {
          automationOwnedTurns.delete(cleanSessionId);
        }
        return;
      }
      automationOwnedTurns.delete(cleanSessionId);
    },

    consumeAutomationOwnedSessionTurn(sessionId: string): boolean {
      return consumeAutomationOwnedSessionTurn(sessionId);
    },

    notifySessionEvent(event: WebPushSessionEventInput): void {
      if (disposed) return;
      if (
        !event.skipAutomationTurnCheck &&
        (event.kind === "task_completed" || event.kind === "task_failed") &&
        consumeAutomationOwnedSessionTurn(event.sessionId)
      ) {
        return;
      }

      const occurredAt = event.occurredAt ?? now();
      const isInteraction =
        event.kind === "approval" || event.kind === "question" || event.kind === "plan";
      const interactionId = event.interactionId?.trim();
      if (isInteraction && !interactionId) {
        logger.warn(undefined, "交互类 Web Push 事件缺少 interactionId，跳过投递", {
          eventId: event.eventId,
          kind: event.kind,
          sessionId: event.sessionId,
        });
        return;
      }
      if (!deliveredEvents.remember(event.eventId)) return;

      const tag = isInteraction
        ? buildInteractionNotificationTag(interactionId!)
        : buildTerminalTaskNotificationTag(event.sessionId);
      const ttlSeconds = isInteraction ? INTERACTION_TTL_SECONDS : TERMINAL_TTL_SECONDS;

      let token: PendingInteractionToken | undefined;
      if (isInteraction && interactionId) {
        token = { cancelled: false };
        let set = pendingInteractionTokens.get(interactionId);
        if (!set) {
          set = new Set();
          pendingInteractionTokens.set(interactionId, set);
        }
        set.add(token);
      }

      enqueueDelivery(async () => {
        try {
          await broadcastMessage(
            (locale) => {
              const copy = formatWebPushNotificationCopy({
                kind: event.kind,
                locale,
                sessionTitle: event.sessionTitle,
                detail: event.detail,
              });
              return {
                version: 1,
                action: "show",
                eventId: event.eventId,
                tag,
                kind: event.kind,
                title: copy.title,
                body: copy.body,
                taskId: event.sessionId,
                ...(event.workspacePath ? { workspacePath: event.workspacePath } : {}),
                ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
                occurredAt,
              };
            },
            ttlSeconds,
            token ? () => token.cancelled : undefined,
          );
        } finally {
          if (token && interactionId) {
            const set = pendingInteractionTokens.get(interactionId);
            if (set) {
              set.delete(token);
              if (set.size === 0) {
                pendingInteractionTokens.delete(interactionId);
              }
            }
          }
        }
      });
    },

    cancelPendingInteractionNotification(interactionId: string): void {
      const cleanId = interactionId.trim();
      if (!cleanId) return;
      const set = pendingInteractionTokens.get(cleanId);
      if (!set) return;
      for (const token of set) {
        token.cancelled = true;
      }
      pendingInteractionTokens.delete(cleanId);
    },

    notifyAutomationEvent(event: WebPushAutomationEventInput): void {
      if (disposed) return;
      const eventId = `automation:${event.runId}:${event.kind}`;
      if (!deliveredEvents.remember(eventId)) return;

      const occurredAt = event.occurredAt ?? now();
      const tag = buildAutomationNotificationTag(event.runId);
      const secondaryTag = event.sessionId
        ? buildTerminalTaskNotificationTag(event.sessionId)
        : undefined;

      enqueueDelivery(() =>
        broadcastMessage((locale) => {
          const copy = formatWebPushNotificationCopy({
            kind: event.kind,
            locale,
            sessionTitle: event.automationTitle,
            detail: event.detail,
          });
          return {
            version: 1,
            action: "show",
            eventId,
            tag,
            ...(secondaryTag ? { secondaryTag } : {}),
            kind: event.kind,
            title: copy.title,
            body: copy.body,
            ...(event.sessionId ? { taskId: event.sessionId } : {}),
            ...(event.workspacePath ? { workspacePath: event.workspacePath } : {}),
            ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
            occurredAt,
          };
        }, TERMINAL_TTL_SECONDS),
      );
    },

    async dispose(): Promise<void> {
      disposed = true;
      automationOwnedTurns.clear();
      for (const set of pendingInteractionTokens.values()) {
        for (const token of set) {
          token.cancelled = true;
        }
      }
      pendingInteractionTokens.clear();
      while (inFlight.size > 0) {
        await Promise.allSettled(Array.from(inFlight));
      }
    },
  };
}
