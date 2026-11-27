import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WebPushSubscribeRequest, WebPushSupportedLocale } from "@zcode/shared/web-push";
import { withAtomicFileLock, writeFileAtomically } from "#src/fs/atomicFileUtils.js";

const MAX_SUBSCRIPTIONS = 64;

export interface StoredWebPushSubscription {
  endpoint: string;
  revision: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
  locale: WebPushSupportedLocale;
  soundEnabled: boolean;
  userAgent?: string;
  createdAt: number;
  updatedAt: number;
}

interface PersistedSubscriptionsFile {
  version: 1;
  subscriptions: StoredWebPushSubscription[];
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function normalizeSubscriptionRecord(raw: unknown): StoredWebPushSubscription | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const keys = item.keys as Record<string, unknown> | undefined;
  if (
    typeof item.endpoint !== "string" ||
    !item.endpoint.trim() ||
    !keys ||
    typeof keys.p256dh !== "string" ||
    typeof keys.auth !== "string"
  ) {
    return null;
  }
  const locale: WebPushSupportedLocale = item.locale === "en-US" ? "en-US" : "zh-CN";
  const soundEnabled = typeof item.soundEnabled === "boolean" ? item.soundEnabled : true;
  const createdAt = typeof item.createdAt === "number" ? item.createdAt : Date.now();
  const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : createdAt;
  const revision =
    typeof item.revision === "string" && item.revision.trim()
      ? item.revision.trim()
      : `legacy:${createdAt}:${updatedAt}`;
  return {
    endpoint: item.endpoint,
    revision,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
    ...(item.expirationTime === null || typeof item.expirationTime === "number"
      ? { expirationTime: item.expirationTime }
      : {}),
    locale,
    soundEnabled,
    ...(typeof item.userAgent === "string" && item.userAgent.trim()
      ? { userAgent: item.userAgent.trim() }
      : {}),
    createdAt,
    updatedAt,
  };
}

export class WebPushSubscriptionStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private lock: Promise<void> = Promise.resolve();

  constructor(filePath: string, now: () => number = Date.now) {
    this.filePath = filePath;
    this.now = now;
  }

  private withInProcessLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lock.then(operation, operation);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureParentDir(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
  }

  private withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withInProcessLock(async () => {
      await this.ensureParentDir();
      return withAtomicFileLock(this.filePath, operation);
    });
  }

  private async readAllUnlocked(): Promise<StoredWebPushSubscription[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedSubscriptionsFile>;
      if (!Array.isArray(parsed.subscriptions)) {
        return [];
      }
      return parsed.subscriptions
        .map(normalizeSubscriptionRecord)
        .filter((item): item is StoredWebPushSubscription => item !== null);
    } catch (error) {
      if (isEnoentError(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeAllUnlocked(subscriptions: StoredWebPushSubscription[]): Promise<void> {
    await this.ensureParentDir();
    const payload: PersistedSubscriptionsFile = {
      version: 1,
      subscriptions,
    };
    await writeFileAtomically(
      this.filePath,
      Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"),
      0o600,
    );
  }

  async list(): Promise<StoredWebPushSubscription[]> {
    return this.withInProcessLock(() => this.readAllUnlocked());
  }

  async upsert(request: WebPushSubscribeRequest): Promise<StoredWebPushSubscription> {
    return this.withFileLock(async () => {
      const current = await this.readAllUnlocked();
      const existing = current.find((item) => item.endpoint === request.subscription.endpoint);
      const rawNow = this.now();
      const timestamp = existing ? Math.max(rawNow, existing.updatedAt + 1) : rawNow;
      const nextRecord: StoredWebPushSubscription = {
        endpoint: request.subscription.endpoint,
        revision: randomUUID(),
        keys: {
          p256dh: request.subscription.keys.p256dh,
          auth: request.subscription.keys.auth,
        },
        ...(request.subscription.expirationTime !== undefined
          ? { expirationTime: request.subscription.expirationTime }
          : {}),
        locale: request.locale ?? existing?.locale ?? "zh-CN",
        soundEnabled: request.soundEnabled ?? existing?.soundEnabled ?? true,
        ...(request.userAgent?.trim() ? { userAgent: request.userAgent.trim() } : {}),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      const filtered = current.filter((item) => item.endpoint !== nextRecord.endpoint);
      filtered.push(nextRecord);
      if (filtered.length > MAX_SUBSCRIPTIONS) {
        filtered.sort((a, b) => a.updatedAt - b.updatedAt);
        filtered.splice(0, filtered.length - MAX_SUBSCRIPTIONS);
      }

      await this.writeAllUnlocked(filtered);
      return nextRecord;
    });
  }

  async remove(endpoint: string): Promise<boolean> {
    return this.removeMany([endpoint]).then((count) => count > 0);
  }

  async removeMany(endpoints: readonly string[]): Promise<number> {
    if (endpoints.length === 0) return 0;
    const targetSet = new Set(endpoints);
    return this.withFileLock(async () => {
      const current = await this.readAllUnlocked();
      const filtered = current.filter((item) => !targetSet.has(item.endpoint));
      const removedCount = current.length - filtered.length;
      if (removedCount > 0) {
        await this.writeAllUnlocked(filtered);
      }
      return removedCount;
    });
  }

  async removeManyIfUnchanged(
    targets: ReadonlyArray<{ endpoint: string; expectedRevision: string }>,
  ): Promise<number> {
    if (targets.length === 0) return 0;
    const expectedByEndpoint = new Map<string, string>();
    for (const target of targets) {
      expectedByEndpoint.set(target.endpoint, target.expectedRevision);
    }
    return this.withFileLock(async () => {
      const current = await this.readAllUnlocked();
      const filtered = current.filter((item) => {
        const expectedRevision = expectedByEndpoint.get(item.endpoint);
        return expectedRevision === undefined || item.revision !== expectedRevision;
      });
      const removedCount = current.length - filtered.length;
      if (removedCount > 0) {
        await this.writeAllUnlocked(filtered);
      }
      return removedCount;
    });
  }
}
