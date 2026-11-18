import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { WebPushNotificationMessage } from "@zcode/shared/web-push";
import { withAtomicFileLock } from "#src/fs/atomicFileUtils.js";
import { WebPushValidationError } from "./contract.js";

const AES128GCM_RECORD_SIZE = 4096;
const AES128GCM_TAG_BYTES = 16;
const VAPID_EXPIRY_SECONDS = 12 * 3600;
export const MAX_WEB_PUSH_PLAINTEXT_BYTES = 3600;

export interface VapidKeyMaterial {
  publicKey: string;
  privateKey: KeyObject;
}

interface VapidPrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

interface PersistedVapidJson {
  publicKey: string;
  privateKeyJwk: VapidPrivateJwk;
}

function isVapidPrivateJwk(value: unknown): value is VapidPrivateJwk {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    typeof candidate.x === "string" &&
    candidate.x.length > 0 &&
    typeof candidate.y === "string" &&
    candidate.y.length > 0 &&
    typeof candidate.d === "string" &&
    candidate.d.length > 0
  );
}

export function decodeBase64OrUrl(input: string, fieldName: string): Buffer {
  const trimmed = input.trim();
  if (!trimmed || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new WebPushValidationError(`Invalid base64 encoding for ${fieldName}`);
  }
  const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (standard.length % 4 === 1) {
    throw new WebPushValidationError(`Invalid base64 length for ${fieldName}`);
  }
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function padCoordinate32(coord: Buffer): Buffer {
  if (coord.length === 32) return coord;
  if (coord.length > 32) {
    throw new WebPushValidationError("Invalid P-256 coordinate length");
  }
  const out = Buffer.alloc(32);
  coord.copy(out, 32 - coord.length);
  return out;
}

export function exportUncompressedP256PublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Expected P-256 EC public key");
  }
  const x = padCoordinate32(Buffer.from(jwk.x, "base64url"));
  const y = padCoordinate32(Buffer.from(jwk.y, "base64url"));
  return Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");
}

export function validateSubscriptionKeys(keys: { p256dh: string; auth: string }): {
  uaPublic: Buffer;
  authSecret: Buffer;
} {
  const uaPublic = decodeBase64OrUrl(keys.p256dh, "p256dh");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new WebPushValidationError("Invalid P-256 p256dh public key format");
  }
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(uaPublic);
  } catch {
    throw new WebPushValidationError("Invalid P-256 p256dh curve point");
  }

  const authSecret = decodeBase64OrUrl(keys.auth, "auth");
  if (authSecret.length !== 16) {
    throw new WebPushValidationError("Invalid Web Push auth secret length");
  }
  return { uaPublic, authSecret };
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const inProcessVapidLocks = new Map<string, Promise<void>>();

function withInProcessVapidLock<T>(vapidFilePath: string, operation: () => Promise<T>): Promise<T> {
  const prev = inProcessVapidLocks.get(vapidFilePath) ?? Promise.resolve();
  const next = prev.then(operation, operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  inProcessVapidLocks.set(vapidFilePath, settled);
  void settled.finally(() => {
    if (inProcessVapidLocks.get(vapidFilePath) === settled) {
      inProcessVapidLocks.delete(vapidFilePath);
    }
  });
  return next;
}

async function readAndValidateVapidFile(vapidFilePath: string): Promise<VapidKeyMaterial> {
  const raw = await readFile(vapidFilePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<PersistedVapidJson>;
  if (typeof parsed.publicKey === "string" && isVapidPrivateJwk(parsed.privateKeyJwk)) {
    const privateKey = createPrivateKey({ key: parsed.privateKeyJwk, format: "jwk" });
    const derivedPublic = exportUncompressedP256PublicKey(createPublicKey(privateKey));
    if (parsed.publicKey === derivedPublic) {
      const rawPub = Buffer.from(parsed.publicKey, "base64url");
      if (rawPub.length !== 65 || rawPub[0] !== 0x04) {
        throw new Error("Persisted VAPID public key format is invalid");
      }
      const expectedPublicKey = createPublicKey({
        key: {
          kty: "EC",
          crv: "P-256",
          x: rawPub.subarray(1, 33).toString("base64url"),
          y: rawPub.subarray(33, 65).toString("base64url"),
        },
        format: "jwk",
      });
      const probe = Buffer.from("zcode-vapid-keypair-probe", "utf8");
      const probeSig = sign("sha256", probe, { key: privateKey, dsaEncoding: "ieee-p1363" });
      const verified = verify(
        "sha256",
        probe,
        { key: expectedPublicKey, dsaEncoding: "ieee-p1363" },
        probeSig,
      );
      if (!verified) {
        throw new Error("Persisted VAPID keypair mismatch");
      }
      await chmod(vapidFilePath, 0o600).catch(() => undefined);
      return { publicKey: derivedPublic, privateKey };
    }
  }
  throw new Error("Persisted VAPID key file is invalid");
}

export async function loadOrCreateVapidKeys(vapidFilePath: string): Promise<VapidKeyMaterial> {
  try {
    return await readAndValidateVapidFile(vapidFilePath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const dir = dirname(vapidFilePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);

  const lockTarget = vapidFilePath.endsWith(".json")
    ? vapidFilePath.slice(0, -".json".length)
    : vapidFilePath;

  return withInProcessVapidLock(vapidFilePath, () =>
    withAtomicFileLock(lockTarget, async () => {
      try {
        return await readAndValidateVapidFile(vapidFilePath);
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") {
          throw error;
        }
      }

      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const publicKeyB64Url = exportUncompressedP256PublicKey(publicKey);
      const exportedJwk = privateKey.export({ format: "jwk" });
      if (!isVapidPrivateJwk(exportedJwk)) {
        throw new Error("Generated P-256 private key JWK is incomplete");
      }
      const payload: PersistedVapidJson = {
        publicKey: publicKeyB64Url,
        privateKeyJwk: {
          kty: "EC",
          crv: "P-256",
          x: exportedJwk.x,
          y: exportedJwk.y,
          d: exportedJwk.d,
        },
      };

      const content = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      const tempPath = join(dir, `.${basename(vapidFilePath)}.${randomUUID()}.tmp`);

      try {
        await writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
        await chmod(tempPath, 0o600).catch(() => undefined);
        await rename(tempPath, vapidFilePath);
        await chmod(vapidFilePath, 0o600).catch(() => undefined);
        return { publicKey: publicKeyB64Url, privateKey };
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }),
  );
}

export function signVapidJwt(params: {
  endpoint: string;
  subject: string;
  privateKey: KeyObject;
  nowSeconds: number;
}): string {
  const origin = new URL(params.endpoint).origin;
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      aud: origin,
      exp: Math.floor(params.nowSeconds) + VAPID_EXPIRY_SECONDS,
      sub: params.subject,
    }),
    "utf8",
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: params.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function fitStringCandidateWithBudget<T>(
  chars: readonly string[],
  minKeepChars: number,
  tryAccept: (candidate: string) => T | null,
): { value: string; result: T } | null {
  if (chars.length === 0) {
    const emptyResult = tryAccept("");
    return emptyResult !== null ? { value: "", result: emptyResult } : null;
  }
  const fullValue = chars.join("");
  const full = tryAccept(fullValue);
  if (full !== null) return { value: fullValue, result: full };

  let low = minKeepChars;
  let high = Math.max(minKeepChars, chars.length - 1);
  let best: { value: string; result: T } | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = mid === 0 ? "" : `${chars.slice(0, mid).join("")}…`;
    const accepted = tryAccept(candidate);
    if (accepted !== null) {
      best = { value: candidate, result: accepted };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!best && minKeepChars === 1) {
    const single = chars[0] ?? "…";
    const accepted = tryAccept(single);
    return accepted !== null ? { value: single, result: accepted } : null;
  }
  return best;
}

function fitStringWithBudget(
  chars: readonly string[],
  minKeepChars: number,
  trySerialize: (candidate: string) => Buffer | null,
): Buffer | null {
  return fitStringCandidateWithBudget(chars, minKeepChars, trySerialize)?.result ?? null;
}

function serializeWithinBudget(
  message: WebPushNotificationMessage,
  maxPlaintextBytes: number,
): Buffer | null {
  const buf = Buffer.from(JSON.stringify(message), "utf8");
  return buf.length <= maxPlaintextBytes ? buf : null;
}

/**
 * 序列化 WebPushNotificationMessage 并强制控制在单条 RFC 8291 记录安全预算内（<= 3600 字节 UTF-8），
 * 加上 86B 头部与 17B 记录分隔符/GCM Tag 后总密文恒 <= 3703B <= 4096B。
 */
export function encodeWebPushMessageWithBudget(
  message: WebPushNotificationMessage,
  maxPlaintextBytes = MAX_WEB_PUSH_PLAINTEXT_BYTES,
): Buffer {
  const initial = Buffer.from(JSON.stringify(message), "utf8");
  if (initial.length <= maxPlaintextBytes) {
    return initial;
  }

  const bodyChars = Array.from(message.body);
  const fittedBody = fitStringWithBudget(bodyChars, 0, (bodyCandidate) =>
    serializeWithinBudget({ ...message, body: bodyCandidate }, maxPlaintextBytes),
  );
  if (fittedBody) {
    return fittedBody;
  }

  const titleChars = Array.from(message.title);
  const baseNoBody: WebPushNotificationMessage = { ...message, body: "" };
  const fittedTitle = fitStringWithBudget(titleChars, 1, (titleCandidate) =>
    serializeWithinBudget({ ...baseNoBody, title: titleCandidate }, maxPlaintextBytes),
  );
  if (fittedTitle) {
    return fittedTitle;
  }

  // 依次剔除可选字段（workspacePath -> workspaceIdentity -> secondaryTag -> taskId），尽量保留有效载荷。
  const optionalDrops: Array<
    keyof Pick<
      WebPushNotificationMessage,
      "workspacePath" | "workspaceIdentity" | "secondaryTag" | "taskId"
    >
  > = ["workspacePath", "workspaceIdentity", "secondaryTag", "taskId"];

  let currentBase: WebPushNotificationMessage = { ...baseNoBody };
  for (const field of optionalDrops) {
    const { [field]: _omitted, ...nextBase } = currentBase;
    currentBase = nextBase;
    const fitted = fitStringWithBudget(titleChars, 1, (titleCandidate) =>
      serializeWithinBudget({ ...currentBase, title: titleCandidate }, maxPlaintextBytes),
    );
    if (fitted) {
      return fitted;
    }
  }

  // 兜底：若超长 tag / eventId 仍撑爆预算，先收敛 tag，再收敛 eventId，保证字节长度恒 <= maxPlaintextBytes。
  const minimalBase: WebPushNotificationMessage = {
    ...currentBase,
    title: titleChars[0] ?? "!",
  };
  const tagChars = Array.from(minimalBase.tag);
  const fittedTagOnly = fitStringWithBudget(tagChars, 1, (tagCandidate) =>
    serializeWithinBudget({ ...minimalBase, tag: tagCandidate }, maxPlaintextBytes),
  );
  if (fittedTagOnly) {
    return fittedTagOnly;
  }

  const fixedOverhead = Buffer.from(
    JSON.stringify({ ...minimalBase, tag: "", eventId: "" }),
    "utf8",
  ).length;
  const remaining = Math.max(2, maxPlaintextBytes - fixedOverhead);
  const tagStepLimit = fixedOverhead + Math.max(2, Math.floor(remaining / 2));
  const boundedTag =
    fitStringCandidateWithBudget(tagChars, 1, (tagCandidate) =>
      serializeWithinBudget({ ...minimalBase, tag: tagCandidate, eventId: "x" }, tagStepLimit),
    )?.value ?? "z";

  const eventIdChars = Array.from(minimalBase.eventId);
  const fittedEventId = fitStringWithBudget(eventIdChars, 1, (eventIdCandidate) =>
    serializeWithinBudget(
      { ...minimalBase, tag: boundedTag, eventId: eventIdCandidate },
      maxPlaintextBytes,
    ),
  );
  if (fittedEventId) {
    return fittedEventId;
  }

  const emergency: WebPushNotificationMessage = {
    ...minimalBase,
    title: "!",
    tag: "z",
    eventId: "z",
  };
  const emergencyBuf = Buffer.from(JSON.stringify(emergency), "utf8");
  if (emergencyBuf.length <= maxPlaintextBytes) {
    return emergencyBuf;
  }
  return emergencyBuf.subarray(0, maxPlaintextBytes);
}

function xorNonceWithSeq(nonce: Buffer, seq: number): Buffer {
  const out = Buffer.from(nonce);
  const high = Math.floor(seq / 0x1_0000_0000);
  const low = seq >>> 0;
  const highOffset = out.length - 8;
  const lowOffset = out.length - 4;
  out.writeUInt32BE((out.readUInt32BE(highOffset) ^ high) >>> 0, highOffset);
  out.writeUInt32BE((out.readUInt32BE(lowOffset) ^ low) >>> 0, lowOffset);
  return out;
}

export function encryptWebPushPayload(params: {
  plaintext: Buffer;
  uaPublic: Buffer;
  authSecret: Buffer;
}): Buffer {
  const salt = randomBytes(16);
  const asEcdh = createECDH("prime256v1");
  asEcdh.generateKeys();
  const asPublic = asEcdh.getPublicKey(null, "uncompressed");
  const ecdhSecret = asEcdh.computeSecret(params.uaPublic);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "ascii"),
    params.uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, params.authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12),
  );

  const rs = AES128GCM_RECORD_SIZE;
  const maxPlaintextPerRecord = rs - AES128GCM_TAG_BYTES - 1;
  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  const chunks: Buffer[] = [header];
  let offset = 0;
  let seq = 0;
  do {
    const remaining = params.plaintext.length - offset;
    const isLast = remaining <= maxPlaintextPerRecord;
    const sliceEnd = isLast ? params.plaintext.length : offset + maxPlaintextPerRecord;
    const recordPlaintext = params.plaintext.subarray(offset, sliceEnd);
    const delimiter = Buffer.from([isLast ? 0x02 : 0x01]);
    const padded = Buffer.concat([recordPlaintext, delimiter]);

    const recordNonce = seq === 0 ? nonce : xorNonceWithSeq(nonce, seq);
    const cipher = createCipheriv("aes-128-gcm", cek, recordNonce);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    const authTag = cipher.getAuthTag();
    chunks.push(encrypted, authTag);

    offset = sliceEnd;
    seq += 1;
  } while (offset < params.plaintext.length);

  return Buffer.concat(chunks);
}
