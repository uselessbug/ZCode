import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createAutomationRuntime,
  createWebPushService,
  createZCodeAgentService,
  type AutomationRepoPort,
  type AutomationTaskServicePort,
} from "@zcode/services/node";
import { IWebPushService, ServiceCollection, WebPushValidationError } from "@zcode/services";
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import {
  WEB_PUSH_API_CONFIG_PATH,
  WEB_PUSH_API_SUBSCRIPTIONS_PATH,
  WEB_PUSH_API_UNSUBSCRIBE_PATH,
  WEB_PUSH_MANIFEST_PATH,
  WEB_PUSH_SERVICE_WORKER_PATH,
  buildAutomationNotificationTag,
  buildInteractionNotificationTag,
  buildTerminalTaskNotificationTag,
  buildTerminalTurnEventKey,
  webPushNotificationMessageSchema,
  type WebPushNotificationMessage,
} from "@zcode/shared/web-push";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeTaskIndexSyncer } from "../../services/src/zcode-agent/zcodeTaskIndexSyncer.js";
import { getInProcessPendingInteractionDetail } from "../../services/src/zcode-agent/zcodeAgentService.js";
import { TaskIndexRepo } from "../../services/src/session/taskIndexRepo.js";
import { AutomationPermanentDispatchError } from "../../services/src/automation-runtime/contract.js";
import {
  encodeWebPushMessageWithBudget,
  encryptWebPushPayload,
  loadOrCreateVapidKeys,
} from "../../services/src/web-push/crypto.js";
import {
  isBlockedIpAddress,
  resolveAndValidatePushAddresses,
} from "../../services/src/web-push/endpointPolicy.js";
import { createSafeWebPushTransport } from "../../services/src/web-push/outboundTransport.js";
import { WebPushSubscriptionStore } from "../../services/src/web-push/subscriptionStore.js";
import { createHttpServer } from "../src/http.js";

function createSimulatedBrowserSubscription() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const uaPublic = ecdh.getPublicKey(null, "uncompressed");
  const authSecret = randomBytes(16);
  return {
    ecdh,
    uaPublic,
    authSecret,
    p256dh: uaPublic.toString("base64url"),
    auth: authSecret.toString("base64url"),
  };
}

/** Browser-side RFC 8291 (aes128gcm) decryption to verify byte-level compliance. */
function decryptAes128GcmPayload(
  encrypted: Buffer,
  uaEcdh: ReturnType<typeof createECDH>,
  uaPublic: Buffer,
  authSecret: Buffer,
): Buffer {
  assert.ok(encrypted.length > 86, "Encrypted payload must contain 86-byte aes128gcm header");
  const salt = encrypted.subarray(0, 16);
  const rs = encrypted.readUInt32BE(16);
  assert.equal(rs, 4096);
  const idlen = encrypted.readUInt8(20);
  assert.equal(idlen, 65);
  const asPublic = encrypted.subarray(21, 21 + idlen);
  assert.equal(asPublic[0], 0x04);

  const ecdhSecret = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12),
  );

  const ciphertextAndTag = encrypted.subarray(21 + idlen);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Remove trailing 0x02 delimiter and any 0x00 padding.
  let end = decrypted.length;
  while (end > 0 && decrypted[end - 1] === 0x00) {
    end -= 1;
  }
  assert.ok(end > 0 && decrypted[end - 1] === 0x02, "Expected final record delimiter 0x02");
  return decrypted.subarray(0, end - 1);
}

function importUncompressedP256PublicKey(base64urlKey: string) {
  const raw = Buffer.from(base64urlKey, "base64url");
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

function verifyVapidAuthorizationHeader(
  authHeader: string,
  expectedOrigin: string,
  expectedPublicKey: string,
  expectedSubject = "mailto:noreply@zcode.local",
) {
  const match = /^vapid\s+t=([^,\s]+),\s*k=([^,\s]+)$/i.exec(authHeader.trim());
  assert.ok(match && match[1] && match[2], `Invalid Authorization header format: ${authHeader}`);
  const jwt = match[1];
  const key = match[2];
  assert.equal(key, expectedPublicKey);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const sigB64 = parts[2]!;
  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
    typ: string;
    alg: string;
  };
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
    aud: string;
    exp: number;
    sub: string;
  };
  assert.equal(payload.aud, expectedOrigin);
  assert.equal(payload.sub, expectedSubject);
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));

  const pubKey = importUncompressedP256PublicKey(expectedPublicKey);
  const sig = Buffer.from(sigB64, "base64url");
  assert.equal(sig.length, 64);
  const ok = verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`, "ascii"),
    { key: pubKey, dsaEncoding: "ieee-p1363" },
    sig,
  );
  assert.equal(ok, true, "VAPID ES256 JWT signature must verify with VAPID public key");
}

async function startMockPushServer(
  handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void,
) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      handler(req, Buffer.concat(chunks), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function waitListening(server: ReturnType<typeof createHttpServer>): Promise<string> {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
  }
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return `http://127.0.0.1:${addr.port}`;
}

async function waitFor<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

describe("Web Push backend service & HTTP endpoints", () => {
  const cleanupDirs: string[] = [];
  const cleanupClosers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupClosers.length > 0) {
      const close = cleanupClosers.pop()!;
      await close().catch(() => undefined);
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()!;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  it("persists and reuses VAPID keys with 0600/0700 permissions and valid ES256 JWT", async () => {
    const storageDir = join(await makeTempDir("web-push-vapid-"), "web-push");
    const svc1 = createWebPushService({ storageDir, subject: "mailto:ops@zcode.test" });
    cleanupClosers.push(() => svc1.dispose());

    const cfg1 = await svc1.getConfig();
    assert.equal(cfg1.enabled, true);
    assert.ok(cfg1.vapidPublicKey);
    assert.equal(cfg1.vapidPublicKey.length, 87);
    const decodedPub = Buffer.from(cfg1.vapidPublicKey, "base64url");
    assert.equal(decodedPub.length, 65);
    assert.equal(decodedPub[0], 0x04);

    const dirStat = await stat(storageDir);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const fileStat = await stat(join(storageDir, "vapid.json"));
    assert.equal(fileStat.mode & 0o777, 0o600);

    // Reload with a second service instance — must reuse the exact same VAPID key.
    const svc2 = createWebPushService({ storageDir, subject: "mailto:ops@zcode.test" });
    cleanupClosers.push(() => svc2.dispose());
    const cfg2 = await svc2.getConfig();
    assert.equal(cfg2.vapidPublicKey, cfg1.vapidPublicKey);
  });

  it("encrypts RFC 8291 aes128gcm payload per subscriber locale and verifies browser decryption & JWT", async () => {
    const storageDir = await makeTempDir("web-push-crypto-");
    const received: Array<{
      path: string;
      headers: IncomingMessage["headers"];
      body: Buffer;
    }> = [];
    const mockPush = await startMockPushServer((req, body, res) => {
      received.push({ path: req.url ?? "/", headers: req.headers, body });
      res.writeHead(201);
      res.end();
    });
    cleanupClosers.push(() => mockPush.close());

    const service = createWebPushService({
      storageDir,
      allowLoopbackEndpoint: true,
    });
    cleanupClosers.push(() => service.dispose());
    const { vapidPublicKey } = await service.getConfig();
    assert.ok(vapidPublicKey);

    const subZh = createSimulatedBrowserSubscription();
    const subEn = createSimulatedBrowserSubscription();
    await service.upsertSubscription({
      subscription: {
        endpoint: `${mockPush.origin}/push/zh`,
        keys: { p256dh: subZh.p256dh, auth: subZh.auth },
      },
      locale: "zh-CN",
    });
    await service.upsertSubscription({
      subscription: {
        endpoint: `${mockPush.origin}/push/en`,
        keys: { p256dh: subEn.p256dh, auth: subEn.auth },
      },
      locale: "en-US",
    });

    service.notifySessionEvent({
      kind: "approval",
      eventId: "evt-approval-1",
      sessionId: "sess-1",
      sessionTitle: "重构构建流程",
      detail: "Bash: rm -rf dist",
      interactionId: "req-1",
      workspacePath: "/workspace/app",
    });

    // Duplicate eventId must not send again.
    service.notifySessionEvent({
      kind: "approval",
      eventId: "evt-approval-1",
      sessionId: "sess-1",
      sessionTitle: "重构构建流程",
      detail: "Bash: rm -rf dist",
      interactionId: "req-1",
    });

    await waitFor(() => (received.length === 2 ? true : undefined));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 2);

    const zhReq = received.find((r) => r.path === "/push/zh")!;
    const enReq = received.find((r) => r.path === "/push/en")!;
    assert.ok(zhReq && enReq);

    for (const req of [zhReq, enReq]) {
      assert.equal(req.headers["content-encoding"], "aes128gcm");
      assert.equal(req.headers["content-type"], "application/octet-stream");
      assert.equal(req.headers["ttl"], "3600");
      assert.equal(req.headers["urgency"], "high");
      assert.equal(req.headers["crypto-key"], undefined);
      verifyVapidAuthorizationHeader(
        String(req.headers["authorization"]),
        mockPush.origin,
        vapidPublicKey,
      );
    }

    const zhJson = webPushNotificationMessageSchema.parse(
      JSON.parse(
        decryptAes128GcmPayload(zhReq.body, subZh.ecdh, subZh.uaPublic, subZh.authSecret).toString(
          "utf8",
        ),
      ),
    );
    const enJson = webPushNotificationMessageSchema.parse(
      JSON.parse(
        decryptAes128GcmPayload(enReq.body, subEn.ecdh, subEn.uaPublic, subEn.authSecret).toString(
          "utf8",
        ),
      ),
    );

    assert.equal(zhJson.action, "show");
    assert.equal(zhJson.tag, buildInteractionNotificationTag("req-1"));
    assert.equal(zhJson.title, "需要你的确认");
    assert.ok(zhJson.body?.includes("任务：重构构建流程"));
    assert.ok(zhJson.body?.includes("Bash: rm -rf dist"));

    assert.equal(enJson.action, "show");
    assert.equal(enJson.tag, buildInteractionNotificationTag("req-1"));
    assert.equal(enJson.title, "Your confirmation is needed");
    assert.ok(enJson.body?.includes("Task: 重构构建流程"));
  });

  it("enforces SSRF guards, rejects redirects, and removes 410 Gone subscriptions", async () => {
    const storageDir = await makeTempDir("web-push-ssrf-");
    const prodService = createWebPushService({ storageDir });
    cleanupClosers.push(() => prodService.dispose());

    const browserSub = createSimulatedBrowserSubscription();
    const invalidEndpoints = [
      "http://push.example.com/1",
      "https://127.0.0.1/push",
      "https://10.0.0.5/push",
      "https://169.254.169.254/latest",
      "https://[::1]/push",
      "https://localhost/push",
      "https://push.local/push",
      "https://service.internal/push",
      "https://user:pass@push.example.com/1",
      "https://intranet/push",
    ];
    for (const endpoint of invalidEndpoints) {
      await assert.rejects(
        () =>
          prodService.upsertSubscription({
            subscription: {
              endpoint,
              keys: { p256dh: browserSub.p256dh, auth: browserSub.auth },
            },
          }),
        WebPushValidationError,
        `Should reject SSRF endpoint ${endpoint}`,
      );
    }

    // Invalid P-256 curve point must fail validation.
    await assert.rejects(
      () =>
        prodService.upsertSubscription({
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            keys: {
              p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xff)]).toString(
                "base64url",
              ),
              auth: browserSub.auth,
            },
          },
        }),
      WebPushValidationError,
    );

    // Loopback test mode: test 302 redirect rejection (redirect: "error") & 410 Gone auto-cleanup.
    let goneCount = 0;
    let redirectAttempted = 0;
    const mockPush = await startMockPushServer((req, _body, res) => {
      if (req.url === "/gone") {
        goneCount += 1;
        res.writeHead(410);
        res.end();
        return;
      }
      if (req.url === "/redirect") {
        redirectAttempted += 1;
        res.writeHead(302, { Location: `${mockPush.origin}/target` });
        res.end();
        return;
      }
      res.writeHead(201);
      res.end();
    });
    cleanupClosers.push(() => mockPush.close());

    const loopbackService = createWebPushService({
      storageDir: await makeTempDir("web-push-gone-"),
      allowLoopbackEndpoint: true,
    });
    cleanupClosers.push(() => loopbackService.dispose());

    await loopbackService.upsertSubscription({
      subscription: {
        endpoint: `${mockPush.origin}/gone`,
        keys: { p256dh: browserSub.p256dh, auth: browserSub.auth },
      },
    });
    await loopbackService.upsertSubscription({
      subscription: {
        endpoint: `${mockPush.origin}/redirect`,
        keys: { p256dh: browserSub.p256dh, auth: browserSub.auth },
      },
    });

    loopbackService.notifySessionEvent({
      kind: "task_completed",
      eventId: "evt-gone-1",
      sessionId: "sess-gone",
      sessionTitle: "Test",
    });

    await waitFor(() => (goneCount === 1 && redirectAttempted === 1 ? true : undefined));
    // Wait for 410 removal persistence to settle.
    await new Promise((r) => setTimeout(r, 80));

    // Second notification must NOT hit /gone again because 410 deleted it.
    loopbackService.notifySessionEvent({
      kind: "task_completed",
      eventId: "evt-gone-2",
      sessionId: "sess-gone",
      sessionTitle: "Test 2",
    });
    await waitFor(() => (redirectAttempted === 2 ? true : undefined));
    assert.equal(goneCount, 1);
  });

  it("serves HTTP config, subscribe/unsubscribe, auth/Origin enforcement, and static headers", async () => {
    const staticRoot = await makeTempDir("web-push-static-");
    await writeFile(join(staticRoot, "index.html"), "<html>ok</html>");
    await mkdir(join(staticRoot, "assets"), { recursive: true });
    await writeFile(join(staticRoot, "assets", "app-abc123.js"), "console.log(1);");

    // 1. Without IWebPushService registered: config returns enabled=false
    const emptyServices = new ServiceCollection();
    const emptyServer = createHttpServer(emptyServices, 0, {
      host: "127.0.0.1",
      staticRoot,
      spaFallback: true,
    });
    cleanupClosers.push(() => new Promise<void>((resolve) => emptyServer.close(() => resolve())));
    const emptyOrigin = await waitListening(emptyServer);

    const disabledCfgRes = await fetch(`${emptyOrigin}${WEB_PUSH_API_CONFIG_PATH}`);
    assert.equal(disabledCfgRes.status, 200);
    assert.deepEqual(await disabledCfgRes.json(), { enabled: false, vapidPublicKey: null });

    // Missing SW and manifest MUST return 404 (not SPA index.html fallback).
    const missingSwRes = await fetch(`${emptyOrigin}${WEB_PUSH_SERVICE_WORKER_PATH}`);
    assert.equal(missingSwRes.status, 404);
    const missingManifestRes = await fetch(`${emptyOrigin}${WEB_PUSH_MANIFEST_PATH}`);
    assert.equal(missingManifestRes.status, 404);

    // Present SW & manifest get no-cache + correct MIME; hashed asset gets immutable.
    await writeFile(join(staticRoot, "zcode-push-sw.js"), "self.addEventListener('push',()=>{});");
    await writeFile(join(staticRoot, "manifest.webmanifest"), '{"name":"ZCode"}');

    const swRes = await fetch(`${emptyOrigin}${WEB_PUSH_SERVICE_WORKER_PATH}`);
    assert.equal(swRes.status, 200);
    assert.equal(swRes.headers.get("cache-control"), "no-cache");

    const manifestRes = await fetch(`${emptyOrigin}${WEB_PUSH_MANIFEST_PATH}`);
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers.get("cache-control"), "no-cache");
    assert.equal(
      manifestRes.headers.get("content-type"),
      "application/manifest+json; charset=utf-8",
    );

    const indexRes = await fetch(`${emptyOrigin}/some/spa/route`);
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.headers.get("cache-control"), "no-cache");

    const assetRes = await fetch(`${emptyOrigin}/assets/app-abc123.js`);
    assert.equal(assetRes.status, 200);
    assert.equal(assetRes.headers.get("cache-control"), "public, max-age=31536000, immutable");

    // 2. With IWebPushService & authToken registered
    const storageDir = await makeTempDir("web-push-http-");
    const webPushService = createWebPushService({
      storageDir,
      allowLoopbackEndpoint: true,
    });
    cleanupClosers.push(() => webPushService.dispose());
    const services = new ServiceCollection().register(IWebPushService, webPushService);
    const authToken = "test-secret-token";
    const authedServer = createHttpServer(services, 0, {
      host: "127.0.0.1",
      authToken,
      authRequired: true,
    });
    cleanupClosers.push(() => new Promise<void>((resolve) => authedServer.close(() => resolve())));
    const origin = await waitListening(authedServer);

    // Unauthenticated request -> 401
    const unauthCfg = await fetch(`${origin}${WEB_PUSH_API_CONFIG_PATH}`);
    assert.equal(unauthCfg.status, 401);

    // Authenticated GET /api/web-push/config -> 200
    const authHeaders = {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    };
    const cfgRes = await fetch(`${origin}${WEB_PUSH_API_CONFIG_PATH}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(cfgRes.status, 200);
    const cfgJson = (await cfgRes.json()) as { enabled: boolean; vapidPublicKey: string | null };
    assert.equal(cfgJson.enabled, true);
    assert.ok(cfgJson.vapidPublicKey && cfgJson.vapidPublicKey.length === 87);

    const browserSub = createSimulatedBrowserSubscription();
    const validBody = JSON.stringify({
      subscription: {
        endpoint: "https://push.example.com/sub/123",
        keys: { p256dh: browserSub.p256dh, auth: browserSub.auth },
      },
      locale: "en-US",
    });

    // Cross-origin Origin header -> 403
    const crossOriginRes = await fetch(`${origin}${WEB_PUSH_API_SUBSCRIPTIONS_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, Origin: "https://evil.example.com" },
      body: validBody,
    });
    assert.equal(crossOriginRes.status, 403);

    // Invalid endpoint / SSRF -> 400
    const badEndpointRes = await fetch(`${origin}${WEB_PUSH_API_SUBSCRIPTIONS_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, Origin: origin },
      body: JSON.stringify({
        subscription: {
          endpoint: "https://10.0.0.1/push",
          keys: { p256dh: browserSub.p256dh, auth: browserSub.auth },
        },
      }),
    });
    assert.equal(badEndpointRes.status, 400);

    // Same-origin valid subscribe -> 200
    const subRes = await fetch(`${origin}${WEB_PUSH_API_SUBSCRIPTIONS_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, Origin: origin },
      body: validBody,
    });
    assert.equal(subRes.status, 200);
    assert.deepEqual(await subRes.json(), {
      ok: true,
      endpoint: "https://push.example.com/sub/123",
    });

    // Cross-origin unsubscribe -> 403
    const crossUnsubRes = await fetch(`${origin}${WEB_PUSH_API_UNSUBSCRIBE_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, Origin: "https://evil.example.com" },
      body: JSON.stringify({ endpoint: "https://push.example.com/sub/123" }),
    });
    assert.equal(crossUnsubRes.status, 403);

    // Valid unsubscribe -> 200 removed=true, then removed=false
    const unsubRes1 = await fetch(`${origin}${WEB_PUSH_API_UNSUBSCRIBE_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, Origin: origin },
      body: JSON.stringify({ endpoint: "https://push.example.com/sub/123" }),
    });
    assert.equal(unsubRes1.status, 200);
    assert.deepEqual(await unsubRes1.json(), { ok: true, removed: true });

    const unsubRes2 = await fetch(`${origin}${WEB_PUSH_API_UNSUBSCRIBE_PATH}`, {
      method: "POST",
      headers: { ...authHeaders, Origin: origin },
      body: JSON.stringify({ endpoint: "https://push.example.com/sub/123" }),
    });
    assert.equal(unsubRes2.status, 200);
    assert.deepEqual(await unsubRes2.json(), { ok: true, removed: false });
  });

  it("delivers end-to-end pushes for agent interactions, pre-send cancellation, session terminal states, and automation deduplication", async () => {
    const storageDir = await makeTempDir("web-push-e2e-");
    const dataBaseDir = await makeTempDir("web-push-data-");
    const workspaceDir = await makeTempDir("web-push-ws-");
    const deliveredMessages: WebPushNotificationMessage[] = [];
    const browserSub = createSimulatedBrowserSubscription();

    const mockPush = await startMockPushServer((_req, body, res) => {
      const decrypted = decryptAes128GcmPayload(
        body,
        browserSub.ecdh,
        browserSub.uaPublic,
        browserSub.authSecret,
      );
      deliveredMessages.push(
        webPushNotificationMessageSchema.parse(JSON.parse(decrypted.toString("utf8"))),
      );
      res.writeHead(201);
      res.end();
    });
    cleanupClosers.push(() => mockPush.close());

    const webPushService = createWebPushService({
      storageDir,
      allowLoopbackEndpoint: true,
    });
    cleanupClosers.push(() => webPushService.dispose());
    await webPushService.upsertSubscription({
      subscription: {
        endpoint: `${mockPush.origin}/sub`,
        keys: { p256dh: browserSub.p256dh, auth: browserSub.auth },
      },
      locale: "zh-CN",
    });

    // Spawn an inline fake stdio ZCode CLI to exercise real ZCodeAgentService + ZCodeTaskIndexSyncer!
    const fakeCliScript = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let subId = null;
      let topic = null;
      let ordinal = 0;
      const emitFrame = (deliveryKind, frame) => {
        ordinal += 1;
        send({
          method: "v4/conversation/frame",
          params: {
            wireVersion: ${V4_WIRE_PROTOCOL_VERSION},
            kind: "complete",
            deliveryKind,
            logicalFrameId: "lf-" + ordinal,
            logicalFrameOrdinal: ordinal,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
            frame,
          },
        });
      };
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "runtime/capabilities") {
          send({ id: msg.id, result: {} });
          return;
        }
        if (msg.method === "v4/conversation/subscribe") {
          if (msg.params.topic.startsWith("sessions-index/")) {
            subId = "sub-idx-1";
            topic = msg.params.topic;
            send({ id: msg.id, result: { ack: { subscriptionId: subId, mode: "snapshot", logEpoch: "ep-1" } } });
            emitFrame("initial", {
              topic,
              subscriptionId: subId,
              fromSeq: 0,
              toSeq: 1,
              sentAt: Date.now(),
              payload: {
                kind: "snapshot",
                snapshot: {
                  protocolVersion: 1,
                  workspaceId: msg.params.topic.slice("sessions-index/".length),
                  logEpoch: "ep-1",
                  sessions: []
                }
              }
            });
            return;
          }
          if (msg.params.topic.startsWith("workspace-config/")) {
            const cfgTopic = msg.params.topic;
            const cfgSubId = "sub-cfg-1";
            send({ id: msg.id, result: { ack: { subscriptionId: cfgSubId, mode: "snapshot", logEpoch: "ep-1" } } });
            emitFrame("initial", {
              topic: cfgTopic,
              subscriptionId: cfgSubId,
              fromSeq: 0,
              toSeq: 1,
              sentAt: Date.now(),
              payload: {
                kind: "snapshot",
                snapshot: {
                  protocolVersion: 1,
                  workspaceId: cfgTopic.slice("workspace-config/".length),
                  logEpoch: "ep-1",
                  config: { configOptions: [], slashCommands: [] }
                }
              }
            });
            return;
          }
          send({ id: msg.id, result: { ack: { subscriptionId: "sub-other", mode: "snapshot", logEpoch: "ep-1" } } });
          return;
        }
        if (msg.method === "v4/command") {
          const env = msg.params;
          send({ id: msg.id, result: { status: "accepted", commandId: env.commandId, revisionAtDecision: 1 } });
          if (env.type === "sendText" && env.payload.text === "trigger-flow") {
            const sid = env.sessionId;
            // 1) Session running in sessions-index with perm-1 active
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 1, toSeq: 2, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: sid, workspaceId: topic.slice("sessions-index/".length),
                    title: "修复构建", phase: "running", sessionEnded: false,
                    hasBackgroundWork: false, lastActivityAt: 1000, createdAt: 900,
                    pendingInteraction: {
                      interactionId: "perm-1", kind: "permission", toolName: "Bash"
                    }
                  }
                }]
              }
            });
            // 2) Permission request (should emit approval)
            send({
              id: "srv-perm-1",
              method: "interaction/requestPermission",
              params: {
                requestId: "perm-1", sessionId: sid, toolCallId: "tc-1",
                toolName: "Bash", reason: "Run build script", riskLevel: "medium",
                input: { command: "pnpm build" },
                options: [{ optionId: "allowOnce", name: "Allow", kind: "allow_once", response: { decision: "allow" } }]
              }
            });
            // 3) ExitPlanMode userInput request (queued behind perm-1 until perm-1 resolves)
            send({
              id: "srv-plan-1",
              method: "interaction/requestUserInput",
              params: {
                requestId: "plan-1", sessionId: sid, toolCallId: "tc-2",
                toolName: "ExitPlanMode", prompt: "Review implementation plan",
                schema: { interaction: "plan_approval", toolName: "ExitPlanMode" }
              }
            });
            // 4) AskUserQuestion WITH autoResolution (should be skipped!)
            send({
              id: "srv-ask-auto",
              method: "interaction/requestUserInput",
              params: {
                requestId: "ask-auto-1", sessionId: sid, toolCallId: "tc-3",
                toolName: "AskUserQuestion", prompt: "Auto-resolving question"
              }
            });
            // 5) workspaceHookReview (should be skipped!)
            send({
              id: "srv-hook-1",
              method: "interaction/requestPermission",
              params: {
                requestId: "hook-1", sessionId: sid, toolCallId: "tc-4",
                toolName: "workspaceHookReview", reason: "Hook review", riskLevel: "low",
                input: {},
                options: [{ optionId: "allowOnce", name: "Allow", kind: "allow_once", response: { decision: "allow" } }]
              }
            });
          } else if (env.type === "resolveInteraction" && env.payload.interactionId === "perm-1") {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 2, toSeq: 3, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: env.sessionId, workspaceId: topic.slice("sessions-index/".length),
                    title: "修复构建", phase: "running", sessionEnded: false,
                    hasBackgroundWork: false, lastActivityAt: 1050, createdAt: 900,
                    pendingInteraction: {
                      interactionId: "plan-1", kind: "userInput", toolName: "ExitPlanMode"
                    }
                  }
                }]
              }
            });
          } else if (env.type === "sendText" && env.payload.text === "complete-normal") {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 3, toSeq: 4, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: env.sessionId, workspaceId: topic.slice("sessions-index/".length),
                    title: "修复构建", phase: "completedSuccess", sessionEnded: true,
                    hasBackgroundWork: false, lastActivityAt: 2050, terminalAt: 2000, createdAt: 900
                  }
                }]
              }
            });
          } else if (env.type === "sendText" && env.payload.text === "interrupt-turn") {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 4, toSeq: 5, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: env.sessionId, workspaceId: topic.slice("sessions-index/".length),
                    title: "修复构建", phase: "running", sessionEnded: false,
                    hasBackgroundWork: false, lastActivityAt: 2100, createdAt: 900
                  }
                }]
              }
            });
            setTimeout(() => {
              emitFrame("online", {
                topic, subscriptionId: subId, fromSeq: 5, toSeq: 6, sentAt: Date.now(),
                payload: {
                  kind: "deltas",
                  deltas: [{
                    op: "session.upserted",
                    session: {
                      sessionId: env.sessionId, workspaceId: topic.slice("sessions-index/".length),
                      title: "修复构建", phase: "completedInterrupted", sessionEnded: true,
                      hasBackgroundWork: false, lastActivityAt: 2200, createdAt: 900
                    }
                  }]
                }
              });
            }, 30);
          } else if (env.type === "sendText" && env.payload.text === "run-automation-turn") {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 6, toSeq: 7, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: env.sessionId, workspaceId: topic.slice("sessions-index/".length),
                    title: "每日巡检", phase: "running", sessionEnded: false,
                    hasBackgroundWork: false, lastActivityAt: 3000, createdAt: 900
                  }
                }]
              }
            });
            setTimeout(() => {
              emitFrame("online", {
                topic, subscriptionId: subId, fromSeq: 7, toSeq: 8, sentAt: Date.now(),
                payload: {
                  kind: "deltas",
                  deltas: [{
                    op: "session.upserted",
                    session: {
                      sessionId: env.sessionId, workspaceId: topic.slice("sessions-index/".length),
                      title: "每日巡检", phase: "completedSuccess", sessionEnded: true,
                      hasBackgroundWork: false, lastActivityAt: 3100, createdAt: 900
                    }
                  }]
                }
              });
            }, 30);
          }
          return;
        }
        send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
      });
    `;

    // Use a separate TaskIndexRepo with isolated dataBaseDir via ZCODE_DATA_BASE_DIR?
    // Even simpler: TaskIndexRepo takes default path, so let's not fail if DB isn't initialized or mock getTaskMeta?
    // Actually zcodeTaskIndexSyncer works with a real TaskIndexRepo; let's check if TaskIndexRepo writes to ~/.zcode unless setDataBaseDir is called.
    const { getDataBaseDir, setDataBaseDir } = await import("@zcode/services/node");
    const prevDataBaseDir = getDataBaseDir();
    setDataBaseDir(dataBaseDir);
    cleanupClosers.push(async () => {
      setDataBaseDir(prevDataBaseDir);
    });

    const taskIndexRepo = new TaskIndexRepo();
    await taskIndexRepo.ensureReady();
    cleanupClosers.push(async () => taskIndexRepo.close());

    let resolveSummaryFn:
      | ReturnType<typeof createZCodeTaskIndexSyncer>["getSessionSummary"]
      | undefined;

    const agentService = createZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", fakeCliScript],
        cwd: workspaceDir,
      }),
      modelSelectionReadinessSource: {
        getView: async () => ({
          revision: "rev-1",
          providers: [{ providerId: "glm", models: [{ modelId: "glm-5" }] }],
        }),
      } as never,
      webPushService,
      resolveSessionSummary: (ws, sid) => resolveSummaryFn?.(ws, sid),
      webPushInteractionCheckDelayMs: 25,
    });
    cleanupClosers.push(() => agentService.disposeAllAndWait());

    const syncer = createZCodeTaskIndexSyncer({
      agentService,
      taskIndexRepo,
      webPushService,
      resolveInteractionDetail: (interactionId) =>
        getInProcessPendingInteractionDetail(agentService, interactionId),
    });
    resolveSummaryFn = syncer.getSessionSummary;
    cleanupClosers.push(async () => syncer.disposeAll());

    syncer.ensureWorkspaceSubscription({ workspacePath: workspaceDir });
    await agentService.initialize({ workspacePath: workspaceDir });
    await new Promise((r) => setTimeout(r, 150));

    // Send command to trigger interactions
    await agentService.sendConversationCommandV4({
      workspacePath: workspaceDir,
      envelope: {
        commandId: "cmd-1",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-e2e-1",
        payload: { text: "trigger-flow" },
        issuedAt: Date.now(),
      },
    });

    // Should deliver approval ("perm-1") and skip "ask-auto-1" and "hook-1"
    await waitFor(() =>
      deliveredMessages.some((m) => m.tag === buildInteractionNotificationTag("perm-1"))
        ? true
        : undefined,
    );
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(
      deliveredMessages.some((m) => m.tag === buildInteractionNotificationTag("ask-auto-1")),
      false,
      "autoResolution interaction must be skipped",
    );
    assert.equal(
      deliveredMessages.some((m) => m.tag === buildInteractionNotificationTag("hook-1")),
      false,
      "workspaceHookReview must be skipped",
    );

    const permMsg = deliveredMessages.find(
      (m) => m.tag === buildInteractionNotificationTag("perm-1"),
    )!;
    assert.equal(permMsg.kind, "approval");
    assert.equal(permMsg.action, "show");
    assert.ok(permMsg.body?.includes("修复构建"));
    assert.ok(permMsg.body?.includes("Run build script"));

    // Resolve perm-1 via v4 resolveInteraction -> must NOT emit silent dismiss push,
    // and advancing pendingInteraction to plan-1 emits plan push!
    const countBeforeResolve = deliveredMessages.length;
    await agentService.sendConversationCommandV4({
      workspacePath: workspaceDir,
      envelope: {
        commandId: "cmd-2",
        clientId: "test-client",
        type: "resolveInteraction",
        sessionId: "sess-e2e-1",
        payload: { interactionId: "perm-1", answer: { optionId: "allowOnce" } },
        issuedAt: Date.now(),
      },
    });
    const planMsg = await waitFor(() =>
      deliveredMessages.find((m) => m.tag === buildInteractionNotificationTag("plan-1")),
    );
    assert.equal(planMsg.kind, "plan");
    assert.equal(planMsg.action, "show");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(deliveredMessages.length, countBeforeResolve + 1);

    // Transition ask-auto-1 from autoResolution (hiddenGrace) to manual confirmation -> must emit question push!
    // (Simulated by clearing autoResolution on the pending interaction in sessions-index.)
    // First confirm normal turn -> task_completed
    await agentService.sendConversationCommandV4({
      workspacePath: workspaceDir,
      envelope: {
        commandId: "cmd-3",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-e2e-1",
        payload: { text: "complete-normal" },
        issuedAt: Date.now(),
      },
    });
    const completedMsg = await waitFor(() =>
      deliveredMessages.find(
        (m) =>
          m.tag === buildTerminalTaskNotificationTag("sess-e2e-1") && m.kind === "task_completed",
      ),
    );
    assert.ok(completedMsg.body?.includes("修复构建"));
    assert.equal(
      completedMsg.eventKey,
      buildTerminalTurnEventKey("sess-e2e-1", 2000),
      "eventKey must use canonical terminalAt rather than mutable lastActivityAt",
    );

    // User interrupted turn -> NO task_completed / task_failed push!
    const countBeforeInterrupt = deliveredMessages.length;
    await agentService.sendConversationCommandV4({
      workspacePath: workspaceDir,
      envelope: {
        commandId: "cmd-4",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-e2e-1",
        payload: { text: "interrupt-turn" },
        issuedAt: Date.now(),
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(deliveredMessages.length, countBeforeInterrupt);

    // Automation runtime deduplication + pre-session dispatch failure
    const runOutcomeMarks: Array<{ runId: string; outcome: string }> = [];
    const automation: ZCodeAutomation = {
      automationId: "auto-1",
      title: "每日巡检",
      cronExpr: "0 9 * * *",
      prompt: "run-automation-turn",
      workspacePath: workspaceDir,
      workspaceKey: workspaceDir,
      locationKind: "local",
      enabled: true,
      lifecycleStatus: "active",
      recurring: true,
      dispatchStatus: "idle",
      dispatchAttempts: 0,
      runCount: 0,
      createdAt: 100,
      updatedAt: 100,
    };
    const manualRun: ZCodeAutomationRun = {
      runId: "auto-1:manual:1",
      automationId: "auto-1",
      workspaceKey: workspaceDir,
      trigger: "manual",
      dispatchStatus: "claimed",
      outcome: "running",
      attempts: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    const fakeRepo: AutomationRepoPort = {
      list: async () => [automation],
      get: async () => automation,
      getRun: async () => manualRun,
      getModelSelectionForDispatch: async () => ({
        providerId: "glm",
        modelId: "glm-5",
        options: { reasoningLevel: "medium" },
      }),
      fixRunModelSelection: async (_id, sel) => sel,
      getBotDeliveryTarget: async () => undefined,
      claimDue: async () => [],
      claimManualRuns: async () => [],
      upsertRunClaimed: async () => {},
      ensureRunClaimed: async () => {},
      markRunDispatch: async () => {},
      markScheduleRunDispatched: async () => true,
      markManualRunDispatched: async () => true,
      markDispatchFailed: async () => {},
      markRunOutcome: async (runId, outcome) => {
        runOutcomeMarks.push({ runId, outcome });
      },
      skipAndReschedule: async () => {},
      releaseClaim: async () => {},
      releaseManualClaim: async () => {},
      touchManualClaim: async () => {},
    };

    let terminalOutcomeListener:
      | ((ev: {
          taskId: string;
          inputId?: string;
          outcome: "succeeded" | "failed" | "stopped";
          error?: string;
          interrupted?: boolean;
        }) => void)
      | undefined;

    let failCreateTask = false;
    let failSendPrompt = false;
    const fakeTaskService: AutomationTaskServicePort = {
      createTask: async () => {
        if (failCreateTask) {
          throw new Error("workspace unavailable");
        }
        return { taskId: "sess-e2e-1" };
      },
      resumeTask: async () => ({}),
      setAutomationSessionConfig: async () => ({}),
      setConfigOption: async () => ({}),
      sendPrompt: async ({ taskId }) => {
        if (failSendPrompt) {
          throw new Error("prompt rejected");
        }
        await agentService.sendConversationCommandV4({
          workspacePath: workspaceDir,
          envelope: {
            commandId: "cmd-auto-1",
            clientId: "test-client",
            type: "sendText",
            sessionId: taskId,
            payload: { text: "run-automation-turn" },
            issuedAt: Date.now(),
          },
        });
      },
      setTaskUnread: async () => {},
      onDynamicTaskTerminalOutcome: () => (listener) => {
        terminalOutcomeListener = listener;
        return { dispose() {} };
      },
    };

    const runtime = createAutomationRuntime({
      repo: fakeRepo,
      cron: {
        computeNextRunAt: () => null,
        isOneShotAutomation: () => false,
      },
      resolveTargetServices: () => ({
        taskService: fakeTaskService,
        modelSelectionService: {
          getView: async () => ({
            effectiveSelection: {
              providerId: "glm",
              modelId: "glm-5",
              options: { reasoningLevel: "medium" },
            },
          }),
        },
      }),
      logger: { info() {}, warn() {}, error() {} },
      onTurnDispatched: ({ sessionId, runId }) => {
        webPushService.markAutomationOwnedSessionTurn?.(sessionId, runId);
      },
      onTurnCleared: ({ sessionId, runId }) => {
        webPushService.clearAutomationOwnedSessionTurn?.(sessionId, runId);
      },
      onRunSettled: (event) => {
        webPushService.notifyAutomationEvent(event);
      },
    });
    cleanupClosers.push(() => runtime.dispose());

    const countBeforeAuto = deliveredMessages.length;
    await runtime.dispatchManualRun({ automation, run: manualRun });
    terminalOutcomeListener?.({
      taskId: "sess-e2e-1",
      inputId: manualRun.runId,
      outcome: "succeeded",
      // syncer 终态迁移那一帧的 lastActivityAt，与会话终态推送、页内通知共用为同一回合事件键。
      terminalAt: 1_700_000_000_123,
    });

    const completedAutoMsg = await waitFor(() =>
      deliveredMessages.find(
        (m) =>
          m.tag === buildAutomationNotificationTag(manualRun.runId) &&
          m.kind === "automation_completed",
      ),
    );
    assert.equal(completedAutoMsg.secondaryTag, buildTerminalTaskNotificationTag("sess-e2e-1"));
    assert.equal(
      completedAutoMsg.eventKey,
      buildTerminalTurnEventKey("sess-e2e-1", 1_700_000_000_123),
    );
    await new Promise((r) => setTimeout(r, 120));

    const autoMessages = deliveredMessages.slice(countBeforeAuto);
    assert.equal(
      autoMessages.filter((m) => m.kind === "task_completed").length,
      0,
      "Ordinary task_completed must be suppressed for automation-owned turn",
    );
    assert.equal(autoMessages.filter((m) => m.kind === "automation_completed").length, 1);
    assert.ok(
      runOutcomeMarks.some((m) => m.runId === manualRun.runId && m.outcome === "succeeded"),
    );

    // Interrupted automation turn (completedInterrupted) -> NO automation_completed, AND releases ownership!
    const interruptedRun: ZCodeAutomationRun = {
      ...manualRun,
      runId: "auto-1:manual:interrupted",
    };
    const countBeforeAutoInterrupt = deliveredMessages.length;
    await runtime.dispatchManualRun({ automation, run: interruptedRun });
    terminalOutcomeListener?.({
      taskId: "sess-e2e-1",
      inputId: interruptedRun.runId,
      outcome: "succeeded",
      interrupted: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      deliveredMessages
        .slice(countBeforeAutoInterrupt)
        .some((m) => m.tag === buildAutomationNotificationTag(interruptedRun.runId)),
      false,
      "Interrupted automation run must NOT emit automation_completed",
    );
    assert.ok(
      runOutcomeMarks.some((m) => m.runId === interruptedRun.runId && m.outcome === "succeeded"),
      "DB settlement preserves compatibility outcome=succeeded",
    );

    // Subsequent ordinary human turn on same session MUST still deliver task_completed!
    webPushService.notifySessionEvent({
      kind: "task_completed",
      eventId: "sess-e2e-1:after-interrupted-auto:completed",
      sessionId: "sess-e2e-1",
      sessionTitle: "后续人工回合",
      workspacePath: workspaceDir,
    });
    await waitFor(() =>
      deliveredMessages.find((m) => m.eventId === "sess-e2e-1:after-interrupted-auto:completed"),
    );

    // sendPrompt failure after onTurnDispatched -> automation_failed + releases ownership!
    failSendPrompt = true;
    const sendFailRun: ZCodeAutomationRun = {
      ...manualRun,
      runId: "auto-1:manual:send-fail",
    };
    await assert.rejects(() =>
      runtime.dispatchManualRun({
        automation: { ...automation, targetTaskId: "sess-e2e-1" },
        run: sendFailRun,
      }),
    );
    failSendPrompt = false;
    const sendFailMsg = await waitFor(() =>
      deliveredMessages.find(
        (m) =>
          m.tag === buildAutomationNotificationTag(sendFailRun.runId) &&
          m.kind === "automation_failed",
      ),
    );
    assert.equal(sendFailMsg.secondaryTag, buildTerminalTaskNotificationTag("sess-e2e-1"));
    webPushService.notifySessionEvent({
      kind: "task_completed",
      eventId: "sess-e2e-1:after-send-fail:completed",
      sessionId: "sess-e2e-1",
      sessionTitle: "派发失败后人工回合",
      workspacePath: workspaceDir,
    });
    await waitFor(() =>
      deliveredMessages.find((m) => m.eventId === "sess-e2e-1:after-send-fail:completed"),
    );

    // Newly created session (createTask succeeds) followed by sendPrompt failure -> preserves real sessionId & clears (sessionId, runId)
    let createdFailSessionId = "sess-created-fail-1";
    const createdFailTaskService: AutomationTaskServicePort = {
      ...fakeTaskService,
      createTask: async () => ({ taskId: createdFailSessionId }),
      sendPrompt: async () => {
        throw new Error("prompt rejected after create");
      },
    };
    const createdFailRuntime = createAutomationRuntime({
      repo: fakeRepo,
      cron: {
        computeNextRunAt: () => null,
        isOneShotAutomation: () => false,
      },
      resolveTargetServices: () => ({
        taskService: createdFailTaskService,
        modelSelectionService: {
          getView: async () => ({
            effectiveSelection: {
              providerId: "glm",
              modelId: "glm-5",
              options: { reasoningLevel: "medium" },
            },
          }),
        },
      }),
      logger: { info() {}, warn() {}, error() {} },
      onTurnDispatched: ({ sessionId, runId }) => {
        webPushService.markAutomationOwnedSessionTurn?.(sessionId, runId);
      },
      onTurnCleared: ({ sessionId, runId }) => {
        webPushService.clearAutomationOwnedSessionTurn?.(sessionId, runId);
      },
      onRunSettled: (event) => {
        webPushService.notifyAutomationEvent(event);
      },
    });
    cleanupClosers.push(() => createdFailRuntime.dispose());
    const createdFailRun: ZCodeAutomationRun = {
      ...manualRun,
      runId: "auto-1:manual:created-send-fail",
    };
    await assert.rejects(() =>
      createdFailRuntime.dispatchManualRun({
        automation: { ...automation, targetTaskId: undefined },
        run: createdFailRun,
      }),
    );
    const createdFailMsg = await waitFor(() =>
      deliveredMessages.find(
        (m) =>
          m.tag === buildAutomationNotificationTag(createdFailRun.runId) &&
          m.kind === "automation_failed",
      ),
    );
    assert.equal(createdFailMsg.taskId, createdFailSessionId);
    assert.equal(
      createdFailMsg.secondaryTag,
      buildTerminalTaskNotificationTag(createdFailSessionId),
    );
    webPushService.notifySessionEvent({
      kind: "task_completed",
      eventId: `${createdFailSessionId}:after-created-send-fail:completed`,
      sessionId: createdFailSessionId,
      sessionTitle: "新建会话派发失败后人工回合",
      workspacePath: workspaceDir,
    });
    await waitFor(() =>
      deliveredMessages.find(
        (m) => m.eventId === `${createdFailSessionId}:after-created-send-fail:completed`,
      ),
    );

    // Pre-session dispatch failure -> automation_failed
    failCreateTask = true;
    const failedRun: ZCodeAutomationRun = {
      ...manualRun,
      runId: "auto-1:manual:2",
    };
    await assert.rejects(() => runtime.dispatchManualRun({ automation, run: failedRun }));
    const failedMsg = await waitFor(() =>
      deliveredMessages.find(
        (m) =>
          m.tag === buildAutomationNotificationTag(failedRun.runId) &&
          m.kind === "automation_failed",
      ),
    );
    assert.ok(failedMsg.body?.includes("workspace unavailable"));

    // Scheduled automation permanent dispatch failure before session creation -> automation_failed once
    const scheduledAutomation: ZCodeAutomation = {
      ...automation,
      automationId: "auto-sched-1",
      title: "定时日报",
      nextRunAt: Date.now() - 1000,
    };
    let claimedOnce = false;
    const schedRepo: AutomationRepoPort = {
      ...fakeRepo,
      get: async () => scheduledAutomation,
      getRun: async () => null,
      claimDue: async () => {
        if (claimedOnce) return [];
        claimedOnce = true;
        return [scheduledAutomation];
      },
    };
    const schedRuntime = createAutomationRuntime({
      repo: schedRepo,
      cron: {
        computeNextRunAt: () => Date.now() + 60_000,
        isOneShotAutomation: () => false,
      },
      resolveTargetServices: () => {
        throw new AutomationPermanentDispatchError("host target unavailable");
      },
      logger: { info() {}, warn() {}, error() {} },
      pollIntervalMs: 60_000,
      onRunSettled: (event) => {
        webPushService.notifyAutomationEvent(event);
      },
    });
    cleanupClosers.push(() => schedRuntime.dispose());
    await schedRuntime.start();
    const expectedSchedRunId = `${scheduledAutomation.automationId}:${scheduledAutomation.nextRunAt}`;
    const schedFailedMsg = await waitFor(() =>
      deliveredMessages.find(
        (m) =>
          m.tag === buildAutomationNotificationTag(expectedSchedRunId) &&
          m.kind === "automation_failed",
      ),
    );
    assert.ok(schedFailedMsg.body?.includes("定时日报"));
    assert.ok(schedFailedMsg.body?.includes("host target unavailable"));

    // Disposing workspace while plan-1 is still pending -> NO silent dismiss push!
    const countBeforeDispose = deliveredMessages.length;
    await agentService.disposeWorkspace({ workspacePath: workspaceDir });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(deliveredMessages.length, countBeforeDispose);
  });

  it("blocks private/metadata/IPv4-mapped DNS resolutions and prevents DNS rebinding in transport", async () => {
    const blockedIps = [
      "127.0.0.1",
      "127.255.0.1",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:0a00:0001",
      "2001:db8::1",
      "3fff::1",
      "3fff:0fff:ffff::1",
    ];
    for (const ip of blockedIps) {
      assert.equal(isBlockedIpAddress(ip), true, `Expected ${ip} to be blocked`);
    }
    assert.equal(isBlockedIpAddress("93.184.216.34"), false);
    assert.equal(isBlockedIpAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
    assert.equal(isBlockedIpAddress("3fff:1000::1"), false);

    for (const badResolvedIp of ["127.0.0.1", "169.254.169.254", "::ffff:10.0.0.1"]) {
      await assert.rejects(
        () =>
          resolveAndValidatePushAddresses("push.attacker.test", {
            lookupImpl: async () => [
              { address: badResolvedIp, family: badResolvedIp.includes(":") ? 6 : 4 },
            ],
          }),
        WebPushValidationError,
      );
      const transport = createSafeWebPushTransport({
        lookupImpl: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: badResolvedIp, family: badResolvedIp.includes(":") ? 6 : 4 },
        ],
      });
      await assert.rejects(
        () =>
          transport({
            url: "https://push.attacker.test/send",
            headers: {},
            body: new Uint8Array([1, 2, 3]),
            timeoutMs: 2000,
          }),
        WebPushValidationError,
      );
    }
  });

  it("handles concurrent VAPID init, transient init retry, concurrent subscriptions, soundEnabled, and stale 410 protection", async () => {
    // 1. Concurrent VAPID key generation across two service instances -> identical public key
    const concurrentDir = join(await makeTempDir("web-push-concurrent-vapid-"), "web-push");
    const svcA = createWebPushService({ storageDir: concurrentDir });
    const svcB = createWebPushService({ storageDir: concurrentDir });
    cleanupClosers.push(() => svcA.dispose());
    cleanupClosers.push(() => svcB.dispose());
    const [cfgA, cfgB] = await Promise.all([svcA.getConfig(), svcB.getConfig()]);
    assert.equal(cfgA.vapidPublicKey, cfgB.vapidPublicKey);

    // 2. Transient VAPID init error clears cached promise so retry succeeds
    const blockedParent = await makeTempDir("web-push-transient-");
    const blockerPath = join(blockedParent, "not-a-dir");
    await writeFile(blockerPath, "occupied");
    const retrySvc = createWebPushService({ storageDir: blockerPath });
    cleanupClosers.push(() => retrySvc.dispose());
    await assert.rejects(() => retrySvc.getConfig());
    await rm(blockerPath, { force: true });
    const recoveredCfg = await retrySvc.getConfig();
    assert.equal(recoveredCfg.enabled, true);
    assert.ok(recoveredCfg.vapidPublicKey);

    // 3. Concurrent subscription upserts across two stores -> both persisted without lost write
    const storeDir = await makeTempDir("web-push-concurrent-subs-");
    const subFile = join(storeDir, "subscriptions.json");
    const store1 = new WebPushSubscriptionStore(subFile);
    const store2 = new WebPushSubscriptionStore(subFile);
    const sub1 = createSimulatedBrowserSubscription();
    const sub2 = createSimulatedBrowserSubscription();
    await Promise.all([
      store1.upsert({
        subscription: {
          endpoint: "https://push.example.com/1",
          keys: { p256dh: sub1.p256dh, auth: sub1.auth },
        },
        soundEnabled: false,
      }),
      store2.upsert({
        subscription: {
          endpoint: "https://push.example.com/2",
          keys: { p256dh: sub2.p256dh, auth: sub2.auth },
        },
      }),
    ]);
    const list = await store1.list();
    assert.equal(list.length, 2);
    assert.equal(list.find((s) => s.endpoint.endsWith("/1"))?.soundEnabled, false);
    assert.equal(list.find((s) => s.endpoint.endsWith("/2"))?.soundEnabled, true);

    // Preserving soundEnabled=false when re-upserting without soundEnabled
    await store1.upsert({
      subscription: {
        endpoint: "https://push.example.com/1",
        keys: { p256dh: sub1.p256dh, auth: sub1.auth },
      },
      locale: "en-US",
    });
    const listAfterUpdate = await store1.list();
    assert.equal(listAfterUpdate.find((s) => s.endpoint.endsWith("/1"))?.soundEnabled, false);

    // 4. soundEnabled: false -> silent: true, pre-send cancellation, and late 410 does not delete newer upsert
    let resolveFirstSend!: (res: { status: number }) => void;
    let firstSendStarted!: () => void;
    const firstSendGate = new Promise<void>((r) => {
      firstSendStarted = r;
    });
    let sendCallCount = 0;
    const capturedBodies: Array<{ body: Uint8Array }> = [];
    const customSvc = createWebPushService({
      storageDir: await makeTempDir("web-push-stale410-"),
      sendImpl: async (req) => {
        sendCallCount += 1;
        capturedBodies.push({ body: req.body });
        if (sendCallCount === 1) {
          firstSendStarted();
          return new Promise<{ status: number }>((resolve) => {
            resolveFirstSend = resolve;
          });
        }
        return { status: 201 };
      },
    });
    cleanupClosers.push(() => customSvc.dispose());

    await customSvc.upsertSubscription({
      subscription: {
        endpoint: "https://push.example.com/device-a",
        keys: { p256dh: sub1.p256dh, auth: sub1.auth },
      },
      soundEnabled: false,
    });

    // Cancelled before send -> never hits sendImpl!
    customSvc.notifySessionEvent({
      kind: "approval",
      eventId: "interaction:cancel-before-send:open",
      interactionId: "cancel-before-send",
      sessionId: "sess-c",
      detail: "Bash",
    });
    customSvc.cancelPendingInteractionNotification("cancel-before-send");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sendCallCount, 0);

    // First send starts, pauses in-flight; re-upsert same endpoint; then first send returns 410!
    customSvc.notifySessionEvent({
      kind: "task_completed",
      eventId: "evt-stale-1",
      sessionId: "sess-s",
      sessionTitle: "测试静音",
    });
    await firstSendGate;
    const decryptedSilent = webPushNotificationMessageSchema.parse(
      JSON.parse(
        decryptAes128GcmPayload(
          Buffer.from(capturedBodies[0]!.body),
          sub1.ecdh,
          sub1.uaPublic,
          sub1.authSecret,
        ).toString("utf8"),
      ),
    );
    assert.equal(decryptedSilent.silent, true);

    await customSvc.upsertSubscription({
      subscription: {
        endpoint: "https://push.example.com/device-a",
        keys: { p256dh: sub1.p256dh, auth: sub1.auth },
      },
      soundEnabled: true,
    });
    resolveFirstSend({ status: 410 });
    await new Promise((r) => setTimeout(r, 50));

    // Must still be subscribed and receive next notification with silent !== true
    customSvc.notifySessionEvent({
      kind: "task_completed",
      eventId: "evt-stale-2",
      sessionId: "sess-s",
      sessionTitle: "恢复铃声",
    });
    await waitFor(() => (sendCallCount === 2 ? true : undefined));
    const decryptedAudible = webPushNotificationMessageSchema.parse(
      JSON.parse(
        decryptAes128GcmPayload(
          Buffer.from(capturedBodies[1]!.body),
          sub1.ecdh,
          sub1.uaPublic,
          sub1.authSecret,
        ).toString("utf8"),
      ),
    );
    assert.equal(decryptedAudible.silent, undefined);
  });

  it("enforces UTF-8 byte budget <= 3600B (<= 4096B encrypted single record) and Origin port/HTTPS rules", async () => {
    // 1. UTF-8 byte budget
    const giantText = "🚀构建日志".repeat(1200);
    const encoded = encodeWebPushMessageWithBudget({
      version: 1,
      action: "show",
      eventId: "evt-budget-1",
      tag: "zcode:task:s1:terminal",
      kind: "task_failed",
      title: giantText,
      body: giantText,
      taskId: "s1",
      workspacePath: "/workspace/very/long/project/path",
      occurredAt: Date.now(),
    });
    assert.ok(encoded.length <= 3600, `Encoded UTF-8 length ${encoded.length} must be <= 3600`);
    const parsed = webPushNotificationMessageSchema.parse(JSON.parse(encoded.toString("utf8")));
    assert.ok(parsed.title.length >= 1);

    // Oversized taskId / secondaryTag / workspacePath / workspaceIdentity / tag / eventId -> still <= 3600B
    const giantId = "x🚀".repeat(2500);
    const encodedHugeFields = encodeWebPushMessageWithBudget({
      version: 1,
      action: "show",
      eventId: giantId,
      tag: giantId,
      secondaryTag: giantId,
      kind: "automation_failed",
      title: giantText,
      body: giantText,
      taskId: giantId,
      workspacePath: giantId,
      workspaceIdentity: giantId,
      occurredAt: Date.now(),
    });
    assert.ok(
      encodedHugeFields.length <= 3600,
      `Encoded UTF-8 length with giant metadata ${encodedHugeFields.length} must be <= 3600`,
    );
    const parsedHuge = webPushNotificationMessageSchema.parse(
      JSON.parse(encodedHugeFields.toString("utf8")),
    );
    assert.ok(parsedHuge.title.length >= 1);
    const subForSize = createSimulatedBrowserSubscription();
    const encryptedHuge = encryptWebPushPayload({
      plaintext: encodedHugeFields,
      uaPublic: subForSize.uaPublic,
      authSecret: subForSize.authSecret,
    });
    assert.ok(encryptedHuge.byteLength <= 4096);

    const sub = createSimulatedBrowserSubscription();
    const budgetBodies: Uint8Array[] = [];
    const budgetSvc = createWebPushService({
      storageDir: await makeTempDir("web-push-budget-"),
      sendImpl: async (req) => {
        budgetBodies.push(req.body);
        return { status: 201 };
      },
    });
    cleanupClosers.push(() => budgetSvc.dispose());
    await budgetSvc.upsertSubscription({
      subscription: {
        endpoint: "https://push.example.com:8443/v2/sub?token=1",
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
    });
    budgetSvc.notifySessionEvent({
      kind: "task_failed",
      eventId: "evt-budget-push",
      sessionId: "sess-b",
      sessionTitle: giantText,
      detail: giantText,
    });
    await waitFor(() => (budgetBodies.length === 1 ? true : undefined));
    assert.ok(budgetBodies[0]!.byteLength <= 4096);
    const decrypted = decryptAes128GcmPayload(
      Buffer.from(budgetBodies[0]!),
      sub.ecdh,
      sub.uaPublic,
      sub.authSecret,
    );
    assert.ok(decrypted.length <= 3600);

    // 2. Origin normalization & X-Forwarded-Proto HTTPS downgrade check
    const originSvc = createWebPushService({
      storageDir: await makeTempDir("web-push-origin-http-"),
    });
    cleanupClosers.push(() => originSvc.dispose());
    const services = new ServiceCollection().register(IWebPushService, originSvc);
    const server = createHttpServer(services, 0, { host: "127.0.0.1" });
    cleanupClosers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const origin = await waitListening(server);

    const validSubPayload = JSON.stringify({
      subscription: {
        endpoint: "https://push.example.com/sub/origin-test",
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
    });

    // https://example.com:443 matches Host: example.com (and vice versa)
    const sendWithCustomHost = (headers: Record<string, string>, body: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${origin}${WEB_PUSH_API_SUBSCRIPTIONS_PATH}`,
          { method: "POST", headers },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(body);
      });

    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Host: "example.com",
          "X-Forwarded-Proto": "https",
          Origin: "https://example.com:443",
        },
        validSubPayload,
      ),
      200,
    );

    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Host: "example.com:443",
          "X-Forwarded-Proto": "https",
          Origin: "https://example.com",
        },
        validSubPayload,
      ),
      200,
    );

    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Host: "example.com",
          Origin: "http://example.com:80",
        },
        validSubPayload,
      ),
      200,
    );

    // X-Forwarded-Proto: https rejects downgraded http:// Origin
    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Host: "example.com",
          "X-Forwarded-Proto": "https",
          Origin: "http://example.com",
        },
        validSubPayload,
      ),
      403,
    );

    // Explicit non-default port mismatch -> 403
    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Host: "example.com",
          "X-Forwarded-Proto": "https",
          Origin: "https://example.com:8443",
        },
        validSubPayload,
      ),
      403,
    );

    // Direct http:// request rejects https:// Origin -> 403
    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Host: "example.com",
          Origin: "https://example.com",
        },
        validSubPayload,
      ),
      403,
    );
    assert.equal(
      await sendWithCustomHost(
        {
          "Content-Type": "application/json",
          Origin: origin.replace("http://", "https://"),
        },
        validSubPayload,
      ),
      403,
    );
  });

  it("recovers task_failed push when mirrorSummary throws and emits open when autoResolution transitions to manual", async () => {
    const storageDir = await makeTempDir("web-push-syncer-edge-");
    const delivered: WebPushNotificationMessage[] = [];
    const sub = createSimulatedBrowserSubscription();
    const webPushService = createWebPushService({
      storageDir,
      sendImpl: async (req) => {
        const decrypted = decryptAes128GcmPayload(
          Buffer.from(req.body),
          sub.ecdh,
          sub.uaPublic,
          sub.authSecret,
        );
        delivered.push(
          webPushNotificationMessageSchema.parse(JSON.parse(decrypted.toString("utf8"))),
        );
        return { status: 201 };
      },
    });
    cleanupClosers.push(() => webPushService.dispose());
    await webPushService.upsertSubscription({
      subscription: {
        endpoint: "https://push.example.com/syncer-edge",
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      locale: "zh-CN",
    });

    const dataBaseDir = await makeTempDir("web-push-syncer-db-");
    const workspaceDir = await makeTempDir("web-push-syncer-ws-");
    const { getDataBaseDir, setDataBaseDir } = await import("@zcode/services/node");
    const prevDataBaseDir = getDataBaseDir();
    setDataBaseDir(dataBaseDir);
    cleanupClosers.push(async () => setDataBaseDir(prevDataBaseDir));

    const fakeCliScript = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let subId = null;
      let topic = null;
      let ordinal = 0;
      const emitFrame = (deliveryKind, frame) => {
        ordinal += 1;
        send({
          method: "v4/conversation/frame",
          params: {
            wireVersion: ${V4_WIRE_PROTOCOL_VERSION},
            kind: "complete",
            deliveryKind,
            logicalFrameId: "lf-" + ordinal,
            logicalFrameOrdinal: ordinal,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
            frame,
          },
        });
      };
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "runtime/capabilities") {
          send({ id: msg.id, result: {} });
          return;
        }
        if (msg.method === "v4/conversation/subscribe") {
          if (msg.params.topic.startsWith("sessions-index/")) {
            subId = "sub-idx";
            topic = msg.params.topic;
            send({ id: msg.id, result: { ack: { subscriptionId: subId, mode: "snapshot", logEpoch: "ep-1" } } });
            emitFrame("initial", {
              topic, subscriptionId: subId, fromSeq: 0, toSeq: 1, sentAt: Date.now(),
              payload: {
                kind: "snapshot",
                snapshot: {
                  protocolVersion: 1,
                  workspaceId: topic.slice("sessions-index/".length),
                  logEpoch: "ep-1",
                  sessions: []
                }
              }
            });
            return;
          }
          send({ id: msg.id, result: { ack: { subscriptionId: "sub-cfg", mode: "snapshot", logEpoch: "ep-1" } } });
          return;
        }
        if (msg.method === "v4/command" && msg.params.type === "sendText") {
          const sid = msg.params.sessionId;
          const wsId = topic.slice("sessions-index/".length);
          send({ id: msg.id, result: { status: "accepted", commandId: msg.params.commandId, revisionAtDecision: 1 } });
          // 1) Start running with autoResolution hiddenGrace
          emitFrame("online", {
            topic, subscriptionId: subId, fromSeq: 1, toSeq: 2, sentAt: Date.now(),
            payload: {
              kind: "deltas",
              deltas: [{
                op: "session.upserted",
                session: {
                  sessionId: sid, workspaceId: wsId, title: "DB异常与自动确认转人工",
                  phase: "running", sessionEnded: false, hasBackgroundWork: false,
                  lastActivityAt: 1000, createdAt: 900,
                  pendingInteraction: {
                    interactionId: "ask-transition-1", kind: "userInput", toolName: "AskUserQuestion",
                    autoResolution: { state: "hiddenGrace", startedAt: 1000, visibleAt: 5000, deadlineAt: 10000 }
                  }
                }
              }]
            }
          });
          // 2) Transition same interactionId to snoozed (manual confirmation required!)
          setTimeout(() => {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 2, toSeq: 3, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: sid, workspaceId: wsId, title: "DB异常与自动确认转人工",
                    phase: "running", sessionEnded: false, hasBackgroundWork: false,
                    lastActivityAt: 1100, createdAt: 900,
                    pendingInteraction: {
                      interactionId: "ask-transition-1", kind: "userInput", toolName: "AskUserQuestion",
                      autoResolution: { state: "snoozed", startedAt: 1000, snoozedAt: 1100 }
                    }
                  }
                }]
              }
            });
          }, 30);
          // 3) Transition session to error
          setTimeout(() => {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 3, toSeq: 4, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: sid, workspaceId: wsId, title: "DB异常与自动确认转人工",
                    phase: "error", sessionEnded: true, hasBackgroundWork: false,
                    lastActivityAt: 1200, createdAt: 900
                  }
                }]
              }
            });
          }, 60);
          return;
        }
        send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
      });
    `;

    const taskIndexRepo = new TaskIndexRepo();
    await taskIndexRepo.ensureReady();
    cleanupClosers.push(async () => taskIndexRepo.close());
    // Force mirrorSummary (store.applyCliFacts) to reject on terminal error!
    const failingTaskIndexRepo = new Proxy(taskIndexRepo, {
      get(target, prop) {
        if (prop === "applyCliFacts") {
          return async (input: { meta?: { updatedAt?: number } }) => {
            if (input?.meta?.updatedAt === 1200) {
              throw new Error("simulated sqlite write failure");
            }
            return target.applyCliFacts(input as never);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const agentService = createZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", fakeCliScript],
        cwd: workspaceDir,
      }),
      modelSelectionReadinessSource: {
        getView: async () => ({
          revision: "rev-1",
          providers: [{ providerId: "glm", models: [{ modelId: "glm-5" }] }],
        }),
      } as never,
      webPushService,
    });
    cleanupClosers.push(() => agentService.disposeAllAndWait());

    const syncer = createZCodeTaskIndexSyncer({
      agentService,
      taskIndexRepo: failingTaskIndexRepo,
      webPushService,
    });
    cleanupClosers.push(async () => syncer.disposeAll());

    syncer.ensureWorkspaceSubscription({ workspacePath: workspaceDir });
    await agentService.initialize({ workspacePath: workspaceDir });
    await new Promise((r) => setTimeout(r, 120));

    await agentService.sendConversationCommandV4({
      workspacePath: workspaceDir,
      envelope: {
        commandId: "cmd-edge-1",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-edge-1",
        payload: { text: "go" },
        issuedAt: Date.now(),
      },
    });

    await waitFor(() =>
      delivered.some(
        (m) =>
          m.tag === buildInteractionNotificationTag("ask-transition-1") && m.kind === "question",
      ) &&
      delivered.some(
        (m) =>
          m.tag === buildTerminalTaskNotificationTag("sess-edge-1") && m.kind === "task_failed",
      )
        ? true
        : undefined,
    );
  });

  it("enforces atomic VAPID file lock & keypair verification, revision ABA guard, transient automation retry dedup, hiddenGrace-to-snoozed detail, and sync task_failed ownership consumption", async () => {
    // 1. Concurrent loadOrCreateVapidKeys without hard-link fallback + tampered `d` self-check
    const vapidDir = join(await makeTempDir("web-push-vapid-lock-"), "sub");
    const vapidFile = join(vapidDir, "vapid.json");
    const concurrentKeys = await Promise.all(
      Array.from({ length: 12 }, () => loadOrCreateVapidKeys(vapidFile)),
    );
    const firstPub = concurrentKeys[0]!.publicKey;
    for (const mat of concurrentKeys) {
      assert.equal(mat.publicKey, firstPub);
    }
    const vapidStat = await stat(vapidFile);
    assert.equal(vapidStat.mode & 0o777, 0o600);
    assert.deepEqual(await readdir(vapidDir), ["vapid.json"]);

    // Tamper ONLY privateKeyJwk.d with another valid P-256 scalar while leaving x/y/publicKey intact
    const parsedVapid = JSON.parse(await readFile(vapidFile, "utf8")) as {
      publicKey: string;
      privateKeyJwk: { kty: string; crv: string; x: string; y: string; d: string };
    };
    const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const otherJwk = otherKey.privateKey.export({ format: "jwk" }) as { d: string };
    assert.notEqual(otherJwk.d, parsedVapid.privateKeyJwk.d);
    await writeFile(
      vapidFile,
      JSON.stringify({
        publicKey: parsedVapid.publicKey,
        privateKeyJwk: { ...parsedVapid.privateKeyJwk, d: otherJwk.d },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(() => loadOrCreateVapidKeys(vapidFile), /mismatch|invalid/i);

    // 2. Subscription store `revision` prevents same-millisecond delete + re-subscribe ABA
    const fixedClock = () => 1_700_000_000_000;
    const abaStore = new WebPushSubscriptionStore(
      join(await makeTempDir("web-push-aba-"), "subscriptions.json"),
      fixedClock,
    );
    assert.equal((abaStore as unknown as Record<string, unknown>).removeIfUnchanged, undefined);
    const subKeys = createSimulatedBrowserSubscription();
    const endpoint = "https://push.example.com/aba-device";
    const firstRecord = await abaStore.upsert({
      subscription: { endpoint, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } },
    });
    assert.equal(await abaStore.remove(endpoint), true);
    const secondRecord = await abaStore.upsert({
      subscription: { endpoint, keys: { p256dh: subKeys.p256dh, auth: subKeys.auth } },
    });
    assert.equal(firstRecord.updatedAt, secondRecord.updatedAt);
    assert.notEqual(firstRecord.revision, secondRecord.revision);
    assert.equal(
      await abaStore.removeManyIfUnchanged([{ endpoint, expectedRevision: firstRecord.revision }]),
      0,
    );
    assert.equal((await abaStore.list()).length, 1);
    assert.equal(
      await abaStore.removeManyIfUnchanged([{ endpoint, expectedRevision: secondRecord.revision }]),
      1,
    );
    assert.equal((await abaStore.list()).length, 0);

    // 3. Automation transient failure does NOT emit automation_failed prematurely, retry success emits automation_completed once
    const retryEvents: Array<{ kind: string; runId: string; sessionId?: string }> = [];
    const scheduledAt = Date.now() - 1000;
    let schedAuto: ZCodeAutomation = {
      automationId: "auto-retry-1",
      title: "可重试任务",
      cronExpr: "0 9 * * *",
      prompt: "run",
      workspacePath: "/tmp/ws",
      workspaceKey: "/tmp/ws",
      locationKind: "local",
      enabled: true,
      lifecycleStatus: "active",
      recurring: true,
      dispatchStatus: "idle",
      dispatchAttempts: 0,
      runCount: 0,
      nextRunAt: scheduledAt,
      createdAt: 100,
      updatedAt: 100,
    };
    let attemptNum = 0;
    let outcomeListener:
      | ((ev: {
          taskId: string;
          inputId?: string;
          outcome: "succeeded" | "failed" | "stopped";
        }) => void)
      | undefined;
    const retryRepo: AutomationRepoPort = {
      list: async () => [schedAuto],
      get: async () => schedAuto,
      getRun: async () => null,
      getModelSelectionForDispatch: async () => ({ providerId: "glm", modelId: "glm-5" }),
      fixRunModelSelection: async (_id, sel) => sel,
      getBotDeliveryTarget: async () => undefined,
      claimDue: async () => {
        if (attemptNum >= 2) return [];
        return [schedAuto];
      },
      claimManualRuns: async () => [],
      upsertRunClaimed: async () => {},
      ensureRunClaimed: async () => {},
      markRunDispatch: async () => {},
      markScheduleRunDispatched: async () => true,
      markManualRunDispatched: async () => true,
      markDispatchFailed: async (_id, opts) => {
        schedAuto = {
          ...schedAuto,
          dispatchStatus: "failed_to_dispatch",
          dispatchAttempts: schedAuto.dispatchAttempts + 1,
          lastError: opts.error,
          retryAt: opts.failedAt,
        };
        return { terminal: false };
      },
      markRunOutcome: async () => {},
      skipAndReschedule: async () => {},
      releaseClaim: async () => {},
      releaseManualClaim: async () => {},
      touchManualClaim: async () => {},
    };
    const retryRuntime = createAutomationRuntime({
      repo: retryRepo,
      cron: {
        computeNextRunAt: () => Date.now() + 60_000,
        isOneShotAutomation: () => false,
      },
      resolveTargetServices: () => {
        attemptNum += 1;
        if (attemptNum === 1) {
          throw new Error("transient network glitch");
        }
        return {
          taskService: {
            createTask: async () => ({ taskId: "sess-retry-1" }),
            resumeTask: async () => ({}),
            setAutomationSessionConfig: async () => ({}),
            setConfigOption: async () => ({}),
            sendPrompt: async () => {},
            setTaskUnread: async () => {},
            onDynamicTaskTerminalOutcome: () => (listener) => {
              outcomeListener = listener;
              return { dispose() {} };
            },
          },
          modelSelectionService: {
            getView: async () => ({
              effectiveSelection: {
                providerId: "glm",
                modelId: "glm-5",
                options: { reasoningLevel: "medium" },
              },
            }),
          },
        };
      },
      logger: { info() {}, warn() {}, error() {} },
      pollIntervalMs: 60_000,
      onRunSettled: (ev) => {
        retryEvents.push({ kind: ev.kind, runId: ev.runId, sessionId: ev.sessionId });
      },
    });
    cleanupClosers.push(() => retryRuntime.dispose());
    await retryRuntime.start();
    await waitFor(() => (attemptNum === 1 ? true : undefined), 5_000, "attemptNum === 1");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(retryEvents.length, 0, "Transient failure must NOT emit automation_failed");

    retryRuntime.wake();
    await waitFor(
      () => (attemptNum === 2 && outcomeListener ? true : undefined),
      5_000,
      "attemptNum === 2 && outcomeListener",
    );
    outcomeListener!({
      taskId: "sess-retry-1",
      inputId: `${schedAuto.automationId}:${scheduledAt}`,
      outcome: "succeeded",
    });
    await waitFor(
      () => (retryEvents.some((e) => e.kind === "automation_completed") ? true : undefined),
      5_000,
      "automation_completed event",
    );
    assert.deepEqual(retryEvents, [
      {
        kind: "automation_completed",
        runId: `${schedAuto.automationId}:${scheduledAt}`,
        sessionId: "sess-retry-1",
      },
    ]);

    // Exhausted transient retries (terminal: true) -> emits automation_failed exactly once
    const exhaustedEvents: Array<{ kind: string; runId: string; detail?: string }> = [];
    let exhaustedClaimed = false;
    const exhaustedAt = Date.now() - 1000;
    const exhaustedAuto: ZCodeAutomation = {
      ...schedAuto,
      automationId: "auto-exhaust-1",
      nextRunAt: exhaustedAt,
      dispatchAttempts: 4,
    };
    const exhaustedRuntime = createAutomationRuntime({
      repo: {
        ...retryRepo,
        get: async () => exhaustedAuto,
        claimDue: async () => {
          if (exhaustedClaimed) return [];
          exhaustedClaimed = true;
          return [exhaustedAuto];
        },
        markDispatchFailed: async () => ({ terminal: true }),
      },
      cron: {
        computeNextRunAt: () => Date.now() + 60_000,
        isOneShotAutomation: () => false,
      },
      resolveTargetServices: () => {
        throw new Error("final transient error");
      },
      logger: { info() {}, warn() {}, error() {} },
      pollIntervalMs: 60_000,
      onRunSettled: (ev) => {
        exhaustedEvents.push({ kind: ev.kind, runId: ev.runId, detail: ev.detail });
      },
    });
    cleanupClosers.push(() => exhaustedRuntime.dispose());
    await exhaustedRuntime.start();
    await waitFor(() => (exhaustedEvents.length >= 1 ? true : undefined), 5_000, "exhausted");
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(exhaustedEvents, [
      {
        kind: "automation_failed",
        runId: `auto-exhaust-1:${exhaustedAt}`,
        detail: "final transient error",
      },
    ]);

    // 4. hiddenGrace arriving AFTER interaction/requestUserInput does NOT reserve eventId,
    //    and transitioning to snoozed delivers question WITH cached detail;
    //    AND sync task_failed captures automation ownership before async mirrorSummary!
    const deliveredRace: WebPushNotificationMessage[] = [];
    const racePushSvc = createWebPushService({
      storageDir: await makeTempDir("web-push-race-svc-"),
      sendImpl: async (req) => {
        const decrypted = decryptAes128GcmPayload(
          Buffer.from(req.body),
          subKeys.ecdh,
          subKeys.uaPublic,
          subKeys.authSecret,
        );
        deliveredRace.push(
          webPushNotificationMessageSchema.parse(JSON.parse(decrypted.toString("utf8"))),
        );
        return { status: 201 };
      },
    });
    cleanupClosers.push(() => racePushSvc.dispose());
    await racePushSvc.upsertSubscription({
      subscription: {
        endpoint: "https://push.example.com/race-sub",
        keys: { p256dh: subKeys.p256dh, auth: subKeys.auth },
      },
      locale: "zh-CN",
    });

    const raceDataDir = await makeTempDir("web-push-race-db-");
    const raceWsDir = await makeTempDir("web-push-race-ws-");
    const { getDataBaseDir, setDataBaseDir } = await import("@zcode/services/node");
    const prevBaseDir = getDataBaseDir();
    setDataBaseDir(raceDataDir);
    cleanupClosers.push(async () => setDataBaseDir(prevBaseDir));

    const raceFakeCli = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
      let subId = null;
      let topic = null;
      let ordinal = 0;
      const emitFrame = (deliveryKind, frame) => {
        ordinal += 1;
        send({
          method: "v4/conversation/frame",
          params: {
            wireVersion: ${V4_WIRE_PROTOCOL_VERSION},
            kind: "complete",
            deliveryKind,
            logicalFrameId: "lf-" + ordinal,
            logicalFrameOrdinal: ordinal,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
            frame,
          },
        });
      };
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === "runtime/capabilities") {
          send({ id: msg.id, result: {} });
          return;
        }
        if (msg.method === "v4/conversation/subscribe") {
          if (msg.params.topic.startsWith("sessions-index/")) {
            subId = "sub-idx";
            topic = msg.params.topic;
            send({ id: msg.id, result: { ack: { subscriptionId: subId, mode: "snapshot", logEpoch: "ep-1" } } });
            emitFrame("initial", {
              topic, subscriptionId: subId, fromSeq: 0, toSeq: 1, sentAt: Date.now(),
              payload: {
                kind: "snapshot",
                snapshot: {
                  protocolVersion: 1,
                  workspaceId: topic.slice("sessions-index/".length),
                  logEpoch: "ep-1",
                  sessions: []
                }
              }
            });
            return;
          }
          send({ id: msg.id, result: { ack: { subscriptionId: "sub-cfg", mode: "snapshot", logEpoch: "ep-1" } } });
          return;
        }
        if (msg.method === "v4/command" && msg.params.type === "sendText") {
          const sid = msg.params.sessionId;
          const wsId = topic.slice("sessions-index/".length);
          send({ id: msg.id, result: { status: "accepted", commandId: msg.params.commandId, revisionAtDecision: 1 } });
          if (msg.params.payload.text === "race-hidden-grace") {
            // interaction/requestUserInput arrives BEFORE sessions-index hiddenGrace frame!
            send({
              id: "srv-ask-race",
              method: "interaction/requestUserInput",
              params: {
                requestId: "ask-race-1", sessionId: sid, toolCallId: "tc-r1",
                toolName: "AskUserQuestion", prompt: "Confirm migration?"
              }
            });
            setTimeout(() => {
              emitFrame("online", {
                topic, subscriptionId: subId, fromSeq: 1, toSeq: 2, sentAt: Date.now(),
                payload: {
                  kind: "deltas",
                  deltas: [{
                    op: "session.upserted",
                    session: {
                      sessionId: sid, workspaceId: wsId, title: "竞态验证",
                      phase: "running", sessionEnded: false, hasBackgroundWork: false,
                      lastActivityAt: 1000, createdAt: 900,
                      pendingInteraction: {
                        interactionId: "ask-race-1", kind: "userInput", toolName: "AskUserQuestion",
                        autoResolution: { state: "hiddenGrace", startedAt: 1000, visibleAt: 5000, deadlineAt: 10000 }
                      }
                    }
                  }]
                }
              });
            }, 25);
            setTimeout(() => {
              emitFrame("online", {
                topic, subscriptionId: subId, fromSeq: 2, toSeq: 3, sentAt: Date.now(),
                payload: {
                  kind: "deltas",
                  deltas: [{
                    op: "session.upserted",
                    session: {
                      sessionId: sid, workspaceId: wsId, title: "竞态验证",
                      phase: "running", sessionEnded: false, hasBackgroundWork: false,
                      lastActivityAt: 1100, createdAt: 900,
                      pendingInteraction: {
                        interactionId: "ask-race-1", kind: "userInput", toolName: "AskUserQuestion",
                        autoResolution: { state: "snoozed", startedAt: 1000, snoozedAt: 1100 }
                      }
                    }
                  }]
                }
              });
            }, 130);
          } else if (msg.params.payload.text === "ordinary-fail") {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 3, toSeq: 4, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: sid, workspaceId: wsId, title: "竞态验证",
                    phase: "error", sessionEnded: true, hasBackgroundWork: false,
                    lastActivityAt: 1200, createdAt: 900
                  }
                }]
              }
            });
          } else if (msg.params.payload.text === "auto-after-fail") {
            emitFrame("online", {
              topic, subscriptionId: subId, fromSeq: 4, toSeq: 5, sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{
                  op: "session.upserted",
                  session: {
                    sessionId: sid, workspaceId: wsId, title: "竞态验证",
                    phase: "running", sessionEnded: false, hasBackgroundWork: false,
                    lastActivityAt: 1300, createdAt: 900
                  }
                }]
              }
            });
            setTimeout(() => {
              emitFrame("online", {
                topic, subscriptionId: subId, fromSeq: 5, toSeq: 6, sentAt: Date.now(),
                payload: {
                  kind: "deltas",
                  deltas: [{
                    op: "session.upserted",
                    session: {
                      sessionId: sid, workspaceId: wsId, title: "竞态验证",
                      phase: "completedSuccess", sessionEnded: true, hasBackgroundWork: false,
                      lastActivityAt: 1400, createdAt: 900
                    }
                  }]
                }
              });
            }, 25);
          }
          return;
        }
        send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
      });
    `;

    const raceTaskIndexRepo = new TaskIndexRepo();
    await raceTaskIndexRepo.ensureReady();
    cleanupClosers.push(async () => raceTaskIndexRepo.close());

    // Delay applyCliFacts on the ordinary error turn (updatedAt=1200) and register an automation mark mid-flight!
    const delayedTaskIndexRepo = new Proxy(raceTaskIndexRepo, {
      get(target, prop) {
        if (prop === "applyCliFacts") {
          return async (input: { meta?: { updatedAt?: number } }) => {
            if (input?.meta?.updatedAt === 1200) {
              await new Promise((r) => setTimeout(r, 40));
              racePushSvc.markAutomationOwnedSessionTurn?.("sess-race-1", "run-new-auto-1");
              await new Promise((r) => setTimeout(r, 40));
            }
            return target.applyCliFacts(input as never);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    let raceResolveSummary:
      | ReturnType<typeof createZCodeTaskIndexSyncer>["getSessionSummary"]
      | undefined;
    const raceAgent = createZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", raceFakeCli],
        cwd: raceWsDir,
      }),
      modelSelectionReadinessSource: {
        getView: async () => ({
          revision: "rev-1",
          providers: [{ providerId: "glm", models: [{ modelId: "glm-5" }] }],
        }),
      } as never,
      webPushService: racePushSvc,
      resolveSessionSummary: (ws, sid) => raceResolveSummary?.(ws, sid),
      webPushInteractionCheckDelayMs: 60,
    });
    cleanupClosers.push(() => raceAgent.disposeAllAndWait());

    const raceSyncer = createZCodeTaskIndexSyncer({
      agentService: raceAgent,
      taskIndexRepo: delayedTaskIndexRepo,
      webPushService: racePushSvc,
      resolveInteractionDetail: (id) => getInProcessPendingInteractionDetail(raceAgent, id),
    });
    raceResolveSummary = raceSyncer.getSessionSummary;
    cleanupClosers.push(async () => raceSyncer.disposeAll());

    raceSyncer.ensureWorkspaceSubscription({ workspacePath: raceWsDir });
    await raceAgent.initialize({ workspacePath: raceWsDir });
    await new Promise((r) => setTimeout(r, 120));

    await raceAgent.sendConversationCommandV4({
      workspacePath: raceWsDir,
      envelope: {
        commandId: "cmd-race-1",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-race-1",
        payload: { text: "race-hidden-grace" },
        issuedAt: Date.now(),
      },
    });
    await new Promise((r) => setTimeout(r, 95));
    assert.equal(
      deliveredRace.some((m) => m.tag === buildInteractionNotificationTag("ask-race-1")),
      false,
      "hiddenGrace must not emit or reserve eventId before snoozed",
    );

    const snoozedMsg = await waitFor(
      () =>
        deliveredRace.find(
          (m) => m.tag === buildInteractionNotificationTag("ask-race-1") && m.kind === "question",
        ),
      5_000,
      "snoozedMsg",
    );
    assert.ok(snoozedMsg.body?.includes("Confirm migration?"));

    // Ordinary fail while new automation mark is registered during delayed mirrorSummary
    await raceAgent.sendConversationCommandV4({
      workspacePath: raceWsDir,
      envelope: {
        commandId: "cmd-race-2",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-race-1",
        payload: { text: "ordinary-fail" },
        issuedAt: Date.now(),
      },
    });
    await waitFor(
      () =>
        deliveredRace.find(
          (m) =>
            m.tag === buildTerminalTaskNotificationTag("sess-race-1") && m.kind === "task_failed",
        ),
      5_000,
      "ordinary task_failed",
    );

    // Subsequent automation turn completion must STILL be suppressed (mark was not stolen by ordinary-fail)
    const countBeforeAutoRun = deliveredRace.length;
    await raceAgent.sendConversationCommandV4({
      workspacePath: raceWsDir,
      envelope: {
        commandId: "cmd-race-3",
        clientId: "test-client",
        type: "sendText",
        sessionId: "sess-race-1",
        payload: { text: "auto-after-fail" },
        issuedAt: Date.now(),
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      deliveredRace.slice(countBeforeAutoRun).some((m) => m.kind === "task_completed"),
      false,
      "new automation turn mark must not be stolen by prior ordinary task_failed",
    );
  });
});
