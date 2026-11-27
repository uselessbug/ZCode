/* eslint-disable max-lines -- 独立回归脚本覆盖附件具名落盘、预读、永久删除与浏览器租约全链路 */
// 独立 CLI 附件物化与字节分流运行时回归（本地 esbuild 打包真实源码，在 mkdtemp 隔离目录中实测）。
//
// 被测真实源码：
//   - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/attachment-refs.ts
//   - apps/zcode-cli/packages/core/src/runtime/helpers/attachments.ts
//   - apps/zcode-cli/packages/core/src/runtime/helpers/attachment-path-reference.ts
//   - apps/zcode-cli/packages/core/src/agent/file-part-hydration.ts
//   - apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts
//   - apps/zcode-cli/packages/core/src/agent/message-history.ts
//   - apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts
//   - apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts
//   - apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts
//   - apps/zcode-cli/packages/adapters/src/storage/index.ts（NodeToolArtifactStore + SqliteSessionStore）
//   - apps/zcode-cli/packages/bootstrap/src/app/create-app.ts（writePromptAttachment / readPromptAttachment / decodePromptAttachmentDataUrl）
//   - apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts（媒体预览白名单边界）
//
// 运行方式：
//   node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-cli-attachment-materialization.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../../../../..");
const cliPackages = join(repoRoot, "apps/zcode-cli/packages");
const rootPackages = join(repoRoot, "packages");
const sharedSrc = join(rootPackages, "shared/src");

function candidateNodeModules() {
  const dirs = [join(repoRoot, "node_modules")];
  const esbuildBin = join(repoRoot, "node_modules/.bin/esbuild");
  if (existsSync(esbuildBin)) {
    dirs.push(join(dirname(realpathSync(esbuildBin)), "../../.."));
    dirs.push(join(dirname(realpathSync(esbuildBin)), "../.."));
  }
  return dirs.filter((dir, index) => existsSync(dir) && dirs.indexOf(dir) === index);
}

async function loadEsbuild() {
  for (const dir of candidateNodeModules()) {
    const entry = join(dir, "esbuild/lib/main.js");
    if (existsSync(entry)) {
      return createRequire(import.meta.url)(entry);
    }
  }
  return import("esbuild");
}

const esbuild = await loadEsbuild();
const nodePaths = candidateNodeModules();

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveTsCandidate(absPath) {
  const candidates = [absPath];
  if (absPath.endsWith(".js")) {
    const stem = absPath.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  candidates.push(`${absPath}.ts`, `${absPath}.tsx`, join(absPath, "index.ts"));
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadPackageExports(pkgDir) {
  const pkgPath = join(pkgDir, "package.json");
  if (!isFile(pkgPath)) return new Map();
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const map = new Map();
  for (const [key, val] of Object.entries(pkg.exports ?? {})) {
    const target = typeof val === "string" ? val : (val?.import ?? val?.default);
    if (typeof target === "string") {
      map.set(key, join(pkgDir, target));
    }
  }
  return map;
}

const WORKSPACE_PACKAGE_DIRS = new Map([
  ["@zcode/contracts", join(cliPackages, "contracts")],
  ["@zcode/core", join(cliPackages, "core")],
  ["@zcode/adapters", join(cliPackages, "adapters")],
  ["@zcode/telemetry", join(cliPackages, "telemetry")],
  ["@zcode/shared-types", join(cliPackages, "shared-types")],
  ["@zcode/i18n", join(cliPackages, "i18n")],
  ["@zcode/dynamic-workflow", join(cliPackages, "dynamic-workflow")],
  ["@zcode/dynamic-workflow-runtime", join(cliPackages, "dynamic-workflow-runtime")],
  ["@zcode/shared", join(rootPackages, "shared")],
  ["@zcode/provider", join(rootPackages, "provider")],
  ["@zcode/provider-node", join(rootPackages, "provider-node")],
  ["@zcode/model-option-map", join(rootPackages, "model-option-map")],
  ["@zcode/session-control", join(rootPackages, "session-control")],
  ["@zcode/plugin-api", join(rootPackages, "plugin-api")],
]);

const WORKSPACE_EXPORTS = new Map(
  [...WORKSPACE_PACKAGE_DIRS.entries()].map(([name, dir]) => [name, loadPackageExports(dir)]),
);

function resolveWorkspaceImport(spec) {
  for (const [pkgName, pkgDir] of WORKSPACE_PACKAGE_DIRS) {
    if (spec === pkgName || spec.startsWith(`${pkgName}/`)) {
      const subpath = spec === pkgName ? "." : `./${spec.slice(pkgName.length + 1)}`;
      const exportsMap = WORKSPACE_EXPORTS.get(pkgName);
      const mapped = exportsMap?.get(subpath);
      if (mapped) {
        const resolved = resolveTsCandidate(mapped);
        if (resolved) return resolved;
      }
      const fallback = resolveTsCandidate(
        join(pkgDir, "src", subpath === "." ? "index.ts" : subpath),
      );
      if (fallback) return fallback;
    }
  }
  return null;
}

function createWorkspaceResolverPlugin() {
  const noopProxyCjs = `
const noop = () => noopProxy;
const noopProxy = new Proxy(noop, {
  get: (_target, prop) => {
    if (prop === "__esModule") return false;
    if (prop === "then") return undefined;
    if (prop === Symbol.toPrimitive) return () => "";
    return noopProxy;
  },
  apply: () => noopProxy,
  construct: () => noopProxy,
});
module.exports = noopProxy;
`;

  return {
    name: "zcode-cli-workspace-resolver",
    setup(build) {
      const stubNs = "cli-external-stub";

      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        if (spec.startsWith("node:") || builtinModules.includes(spec)) return { external: true };

        if (spec.startsWith("#src/") && args.importer) {
          const pkgRoot = args.importer.includes(sharedSrc) ? sharedSrc : null;
          if (pkgRoot) {
            const resolved = resolveTsCandidate(join(pkgRoot, spec.slice("#src/".length)));
            if (resolved) return { path: resolved };
          }
        }
        if (spec.startsWith("#session-control/")) {
          const resolved = resolveTsCandidate(
            join(rootPackages, "session-control/src", spec.slice("#session-control/".length)),
          );
          if (resolved) return { path: resolved };
        }

        const wsResolved = resolveWorkspaceImport(spec);
        if (wsResolved) return { path: wsResolved };

        if (spec.startsWith(".") && args.importer && args.namespace === "file") {
          const resolved = resolveTsCandidate(resolve(dirname(args.importer), spec));
          if (resolved) return { path: resolved };
        }

        for (const dir of nodePaths) {
          const pkgRoot = spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0];
          if (existsSync(join(dir, pkgRoot))) {
            return undefined;
          }
        }
        if (!spec.startsWith(".") && !spec.startsWith("/")) {
          return { path: spec, namespace: stubNs };
        }
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: stubNs }, (args) => {
        if (args.path === "chokidar") {
          return {
            contents: `
import { EventEmitter } from "node:events";
export function watch() {
  const emitter = new EventEmitter();
  emitter.close = async () => { emitter.removeAllListeners(); };
  queueMicrotask(() => emitter.emit("ready"));
  return emitter;
}
export default { watch };
`,
            loader: "js",
          };
        }
        if (args.path === "zod-to-json-schema") {
          return {
            contents: `export function zodToJsonSchema() { return { type: "object", properties: {} }; }`,
            loader: "js",
          };
        }
        if (args.path.startsWith("@modelcontextprotocol/client/stdio")) {
          return {
            contents: `export class StdioClientTransport {}`,
            loader: "js",
          };
        }
        if (args.path === "@opentelemetry/api") {
          return {
            contents: `
export const createContextKey = (name) => Symbol(name);
export const ROOT_CONTEXT = { getValue: () => undefined, setValue: () => ROOT_CONTEXT, deleteValue: () => ROOT_CONTEXT };
export const context = { active: () => ROOT_CONTEXT, with: (_c, fn) => fn() };
export const trace = { getTracer: () => ({ startActiveSpan: (_n, fn) => fn({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, spanContext: () => ({ traceId: "0", spanId: "0", traceFlags: 0 }) }) }), getSpan: () => undefined, setSpan: (c) => c };
export const propagation = { extract: (c) => c, inject: () => {} };
export const createTraceState = () => ({});
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
`,
            loader: "js",
          };
        }
        return {
          contents: noopProxyCjs,
          loader: "js",
        };
      });
    },
  };
}

const tempRoot = await mkdtemp(join(tmpdir(), "standalone-cli-attach-"));
try {
  const entryPath = join(tempRoot, "entry.ts");
  const outPath = join(tempRoot, "bundle.mjs");

  const entrySource = [
    `export { isUriAttachmentRef, mapAttachmentRefsToTurnAttachments } from ${JSON.stringify(join(cliPackages, "bootstrap/src/zcode-protocol-v4/commands/attachment-refs.ts"))};`,
    `export { resolveTurnAttachments } from ${JSON.stringify(join(cliPackages, "core/src/runtime/helpers/attachments.ts"))};`,
    `export { filePartToContentBlock } from ${JSON.stringify(join(cliPackages, "core/src/agent/file-part-hydration.ts"))};`,
    `export { hydrateMessageHistoryFromSession } from ${JSON.stringify(join(cliPackages, "core/src/agent/session-history-hydrator.ts"))};`,
    `export { MessageHistoryImpl } from ${JSON.stringify(join(cliPackages, "core/src/agent/message-history.ts"))};`,
    `export { buildRuntimeUserEntriesFromTurn } from ${JSON.stringify(join(cliPackages, "core/src/runtime/helpers/conversation.ts"))};`,
    `export { buildProviderRequestMessages } from ${JSON.stringify(join(cliPackages, "core/src/runtime/helpers/provider-request-messages.ts"))};`,
    `export { persistUserPrompt } from ${JSON.stringify(join(cliPackages, "core/src/runtime/methods/message-persistence.ts"))};`,
    `export { createNodeSessionDataFiles, createNodeToolArtifactStore, createSqliteSessionStore } from ${JSON.stringify(join(cliPackages, "adapters/src/storage/index.ts"))};`,
    `export { createNodeFileSystemAdapter } from ${JSON.stringify(join(cliPackages, "adapters/src/fs/index.ts"))};`,
    `export { createManagedCdpBrowserRuntime } from ${JSON.stringify(join(cliPackages, "adapters/src/browser/index.ts"))};`,
    `export { createProtocolBrowserControlBroker } from ${JSON.stringify(join(cliPackages, "bootstrap/src/zcode-protocol/browser-control-broker.ts"))};`,
    `export { purgeSessionDataWith } from ${JSON.stringify(join(cliPackages, "bootstrap/src/zcode-protocol/session-data/index.ts"))};`,
    `export { executeSessionDeletionWith, previewSessionDeletionsWith, previewSessionDeletionWith } from ${JSON.stringify(join(cliPackages, "bootstrap/src/zcode-protocol/session-data/permanent-deletion.ts"))};`,
    `export { createMessageId, createProjectId, createSessionId, SessionEventType } from ${JSON.stringify(join(cliPackages, "contracts/src/index.ts"))};`,
    `export { ConversationV4Gateway } from ${JSON.stringify(join(cliPackages, "bootstrap/src/zcode-protocol-v4/v4-gateway.ts"))};`,
    `export { createZCodeApp } from ${JSON.stringify(join(cliPackages, "bootstrap/src/app/create-app.ts"))};`,
    `export { ProviderRegistry } from ${JSON.stringify(join(rootPackages, "provider/src/index.ts"))};`,
  ].join("\n");

  await import("node:fs/promises").then((fs) => fs.writeFile(entryPath, entrySource, "utf8"));

  await esbuild.build({
    entryPoints: [entryPath],
    outfile: outPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    nodePaths,
    banner: {
      js: [
        'import { createRequire as __bundleCreateRequire } from "node:module";',
        'import { fileURLToPath as __bundleFileURLToPath } from "node:url";',
        'import { dirname as __bundleDirname } from "node:path";',
        "const require = __bundleCreateRequire(import.meta.url);",
        "const __filename = __bundleFileURLToPath(import.meta.url);",
        "const __dirname = __bundleDirname(__filename);",
      ].join("\n"),
    },
    plugins: [createWorkspaceResolverPlugin()],
    logLevel: "silent",
  });

  const mod = await import(pathToFileURL(outPath).href);
  const storageRoot = join(tempRoot, "storage");
  const artifactStore = mod.createNodeToolArtifactStore({
    rootDir: join(storageRoot, "artifacts"),
    imageCacheRootDir: join(storageRoot, "images"),
    pdfCacheRootDir: join(storageRoot, "pdfs"),
    videoCacheRootDir: join(storageRoot, "videos"),
  });

  const dbPath = join(storageRoot, "sessions.sqlite");
  let store = await mod.createSqliteSessionStore({ dbPath });
  const projectID = mod.createProjectId("proj-attach");
  const ensureSession = async (rawId, slug, title) => {
    const id = mod.createSessionId(rawId);
    await store.createSession({ id, projectID, slug, directory: tempRoot, title, version: "1" });
    return id;
  };
  const copyFilePartToFork = async (part, forkId, msgId, partId) => {
    const messageID = mod.createMessageId(msgId);
    await store.saveMessage({
      id: messageID,
      sessionID: forkId,
      role: "user",
      time: { created: Date.now() },
      agent: "zcode-agent",
    });
    await store.savePart({ ...part, id: partId, sessionID: forkId, messageID });
  };

  const sessionId = await ensureSession("sess-attach-1", "attach-reg", "Attachment Regression");
  const fileSystemPort = mod.createNodeFileSystemAdapter();
  const resolveWithStore = (attachments, targetSessionId = sessionId) =>
    mod.resolveTurnAttachments(attachments, {
      artifactStore,
      fileSystemPort,
      sessionId: targetSessionId,
      traceContext,
      workingDirectory: tempRoot,
    });
  const uploadArtifact = async (name, mime, bytes, targetSessionId = sessionId) =>
    artifactStore.writeToolResultArtifact({
      sessionId: targetSessionId,
      toolCallId: `upload-${name}`,
      toolName: "prompt-attachment:upload",
      content: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
      contentType: "text/plain",
      retention: "session",
    });

  // -------------------------------------------------------------------------
  // 场景 1：1KiB 随机 .zip 与中文+空格真实 .docx（PK 头二进制）
  // -------------------------------------------------------------------------
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(1020)]);
  const docxBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(508)]);
  const docxName = "日本文学史 复习资料 (期末).docx";
  const zipArt = await uploadArtifact("bundle.zip", "application/zip", zipBytes);
  // 故意给伪 .docx 标成 text/plain，验证二进制扩展名排除不被 MIME 误导
  const docxArt = await uploadArtifact(docxName, "text/plain", docxBytes);

  // -------------------------------------------------------------------------
  // 场景 2：70KiB / 100KiB UTF-8 .log 与 >300KiB 超大文本（统一走桌面 readTextFileForModel）
  // -------------------------------------------------------------------------
  const fullLogText = `${"2026-11-16T00:00:00Z INFO attachment test line\n".repeat(1550)}`; // ~69.8 KiB (>64KiB, <=25k tokens)
  const fullLogBytes = Buffer.from(fullLogText, "utf8");
  assert.ok(fullLogBytes.byteLength > 64 * 1024, "70KiB log fixture must exceed 64KiB");
  const fullLogArt = await uploadArtifact("full-70k.log", "text/plain", fullLogBytes);

  const largeLogText = `${"2026-11-16T00:00:00Z INFO attachment test line\n".repeat(2200)}`; // ~99 KiB (>64KiB, >25k tokens)
  const largeLogBytes = Buffer.from(largeLogText, "utf8");
  assert.ok(largeLogBytes.byteLength > 64 * 1024, "log fixture must exceed 64KiB");
  const logArt = await uploadArtifact("runtime.log", "text/plain", largeLogBytes);

  const hugeLogText = Array.from(
    { length: 2400 },
    (_, i) => `2026-11-16T00:00:00Z INFO line=${i + 1} ${"x".repeat(120)}`,
  ).join("\n");
  const hugeLogBytes = Buffer.from(hugeLogText, "utf8");
  assert.ok(hugeLogBytes.byteLength > 300 * 1024, "huge log fixture must exceed 300KiB");
  const hugeLogArt = await uploadArtifact("huge.log", "text/plain", hugeLogBytes);

  // -------------------------------------------------------------------------
  // 场景 3：2KiB UTF-8 .vue / .json 与 0 字节 .txt
  // -------------------------------------------------------------------------
  const vueText = `<template>\n  <div>${"vue-content ".repeat(160)}</div>\n</template>\n`;
  const jsonText = JSON.stringify({
    items: Array.from({ length: 80 }, (_, i) => ({ i, ok: true })),
  });
  const vueArt = await uploadArtifact(
    "App.vue",
    "application/octet-stream",
    Buffer.from(vueText, "utf8"),
  );
  const jsonArt = await uploadArtifact(
    "config.json",
    "application/json",
    Buffer.from(jsonText, "utf8"),
  );
  const emptyArt = await uploadArtifact("empty.txt", "text/plain", Buffer.alloc(0));

  // -------------------------------------------------------------------------
  // 场景 4：含非法 UTF-8 字节与 NUL 字节的伪 .txt，以及无扩展名二进制/clipboard-text/恶意路径
  // -------------------------------------------------------------------------
  const fakeTxtBytes = Buffer.from([0x41, 0x42, 0x00, 0xff, 0xfe, 0x80, 0x43]);
  const fakeTxtArt = await uploadArtifact("corrupt.txt", "text/plain", fakeTxtBytes);
  const noExtBinBytes = randomBytes(256);
  const noExtBinArt = await uploadArtifact("Makefile", "application/octet-stream", noExtBinBytes);
  const clipboardText = "clipboard line 1\nclipboard line 2\n";
  const clipboardArt = await artifactStore.writeToolResultArtifact({
    sessionId,
    toolCallId: "upload-clipboard",
    toolName: "prompt-attachment:upload",
    content: `data:text/plain;charset=utf-8;base64,${Buffer.from(clipboardText, "utf8").toString("base64")}`,
    contentType: "text/plain",
    retention: "session",
  });
  const evilTraversalBytes = randomBytes(64);
  const evilTraversalArt = await uploadArtifact(
    "evil-passwd",
    "application/octet-stream",
    evilTraversalBytes,
  );
  const evilWinBytes = randomBytes(64);
  const evilWinArt = await uploadArtifact("evil-win", "application/zip", evilWinBytes);
  const evilLongBytes = randomBytes(64);
  const evilLongArt = await uploadArtifact("evil-long", "application/octet-stream", evilLongBytes);
  const evilLongName = `${"中文长文件名".repeat(50)}\x00\x1f\u0085.bin`;

  // 1) 通过真实 attachment-refs.ts 映射（验证不提前解码，不丢弃 >64KiB，不设 path）
  const refs = [
    {
      ref: zipArt.uri,
      fileName: "bundle.zip",
      mime: "application/zip",
      bytes: zipBytes.byteLength,
    },
    { ref: docxArt.uri, fileName: docxName, mime: "text/plain", bytes: docxBytes.byteLength },
    {
      ref: fullLogArt.uri,
      fileName: "full-70k.log",
      mime: "text/plain",
      bytes: fullLogBytes.byteLength,
    },
    {
      ref: logArt.uri,
      fileName: "runtime.log",
      mime: "text/plain",
      bytes: largeLogBytes.byteLength,
    },
    {
      ref: hugeLogArt.uri,
      fileName: "huge.log",
      mime: "text/plain",
      bytes: hugeLogBytes.byteLength,
    },
    { ref: vueArt.uri, fileName: "App.vue", mime: "application/octet-stream", bytes: 999_999 },
    {
      ref: jsonArt.uri,
      fileName: "config.json",
      mime: "application/json",
      bytes: Buffer.byteLength(jsonText),
    },
    { ref: emptyArt.uri, fileName: "empty.txt", mime: "text/plain", bytes: 0 },
    {
      ref: fakeTxtArt.uri,
      fileName: "corrupt.txt",
      mime: "text/plain",
      bytes: fakeTxtBytes.byteLength,
    },
    {
      ref: noExtBinArt.uri,
      fileName: "Makefile",
      mime: "application/octet-stream",
      bytes: noExtBinBytes.byteLength,
    },
    {
      ref: clipboardArt.uri,
      fileName: "pasted-text-20261116-120000.txt",
      mime: "text/plain",
      bytes: Buffer.byteLength(clipboardText),
      sourceKind: "clipboard-text",
    },
    {
      ref: evilTraversalArt.uri,
      fileName: "../../etc/passwd",
      mime: "application/octet-stream",
      bytes: evilTraversalBytes.byteLength,
    },
    {
      ref: evilWinArt.uri,
      fileName: "C:\\temp\\evil.zip",
      mime: "application/zip",
      bytes: evilWinBytes.byteLength,
    },
    {
      ref: evilLongArt.uri,
      fileName: evilLongName,
      mime: "application/octet-stream",
      bytes: evilLongBytes.byteLength,
    },
  ];

  const turnAttachments = mod.mapAttachmentRefsToTurnAttachments(refs);
  assert.equal(turnAttachments.length, refs.length);
  for (const item of turnAttachments) {
    assert.equal(item.type, "file");
    assert.equal(item.path, undefined, "mapped file URI ref must not set path");
    assert.ok(item.content?.startsWith("zcode-artifact://"));
  }

  // 2) 通过真实 resolveTurnAttachments 解析
  const traceContext = { traceId: "trace-standalone-reg" };
  const resolved = await resolveWithStore(turnAttachments);

  const [
    resZip,
    resDocx,
    resFullLog,
    resLog,
    resHugeLog,
    resVue,
    resJson,
    resEmpty,
    resFakeTxt,
    resNoExtBin,
    resClipboard,
    resEvilTraversal,
    resEvilWin,
    resEvilLong,
  ] = resolved;

  // 二进制与伪文本走具名落盘 + local_ref
  for (const [label, item, origBytes, origUri, expectedBase] of [
    ["zip", resZip, zipBytes, zipArt.uri, "bundle.zip"],
    ["docx", resDocx, docxBytes, docxArt.uri, docxName],
    ["fakeTxt", resFakeTxt, fakeTxtBytes, fakeTxtArt.uri, "corrupt.txt"],
    ["noExtBin", resNoExtBin, noExtBinBytes, noExtBinArt.uri, "Makefile"],
    [
      "clipboard",
      resClipboard,
      Buffer.from(clipboardText, "utf8"),
      clipboardArt.uri,
      "pasted-text-20261116-120000.txt",
    ],
    ["evilTraversal", resEvilTraversal, evilTraversalBytes, evilTraversalArt.uri, "passwd"],
    ["evilWin", resEvilWin, evilWinBytes, evilWinArt.uri, "evil.zip"],
  ]) {
    assert.equal(item.metadata.storageKind, "local_ref", `${label} must be local_ref`);
    assert.equal(item.metadata.artifactUri, origUri, `${label} must keep upload artifactUri`);
    assert.equal(item.metadata.originalUrl, origUri, `${label} must keep upload originalUrl`);
    assert.ok(
      item.url.startsWith("zcode-artifact://") && item.url !== origUri,
      `${label} url must be new raw artifact URI`,
    );
    assert.equal(item.metadata.sizeBytes, origBytes.byteLength, `${label} sizeBytes`);
    assert.equal(typeof item.metadata.pathReferenceText, "string", `${label} pathReferenceText`);
    const diskPath = item.source?.path;
    assert.ok(diskPath, `${label} must have disk path`);
    assert.equal(basename(diskPath), expectedBase, `${label} basename must match`);
    assert.ok(
      diskPath.startsWith(join(storageRoot, "artifacts", sessionId)),
      `${label} must stay inside session artifacts root`,
    );
    assert.ok(item.metadata.pathReferenceText.includes(diskPath), `${label} pathReferenceText`);
    assert.equal(sha256Hex(await readFile(diskPath)), sha256Hex(origBytes), `${label} SHA-256`);
  }
  assert.ok(resEvilLong.source?.path?.startsWith(join(storageRoot, "artifacts", sessionId)));
  const evilLongBase = basename(resEvilLong.source.path);
  assert.ok(Buffer.byteLength(evilLongBase, "utf8") <= 240, "truncated name <= 240 bytes");
  assert.ok(evilLongBase.endsWith(".bin"), "truncated name keeps .bin extension");
  assert.ok(
    ![...evilLongBase].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }),
    "control chars must be sanitized",
  );

  assert.ok(resZip.metadata.pathReferenceText.includes("not a known text attachment"));
  assert.ok(resDocx.metadata.pathReferenceText.includes("not a known text attachment"));
  assert.ok(resFakeTxt.metadata.pathReferenceText.includes("not a known text attachment"));
  assert.ok(!resFakeTxt.metadata.pathReferenceText.includes("\ufffd"), "must not inject U+FFFD");
  assert.ok(resClipboard.metadata.pathReferenceText.includes("pasted-text temporary attachment"));

  // 安全文本（70KiB / 100KiB .log / >300KiB huge.log / 2KiB .vue / .json / 0B .txt）全部走桌面同款 readTextFileForModel
  for (const [label, item, origUri, expectedBase, origBytes] of [
    ["log70k", resFullLog, fullLogArt.uri, "full-70k.log", fullLogBytes],
    ["log100k", resLog, logArt.uri, "runtime.log", largeLogBytes],
    ["hugeLog", resHugeLog, hugeLogArt.uri, "huge.log", hugeLogBytes],
    ["vue", resVue, vueArt.uri, "App.vue", Buffer.from(vueText, "utf8")],
    ["json", resJson, jsonArt.uri, "config.json", Buffer.from(jsonText, "utf8")],
    ["empty", resEmpty, emptyArt.uri, "empty.txt", Buffer.alloc(0)],
  ]) {
    assert.equal(item.metadata.storageKind, "inline", `${label} must be inline`);
    assert.equal(item.mime, "text/plain", `${label} mime must be text/plain`);
    assert.equal(item.contentBlock.type, "text", `${label} contentBlock must be text`);
    assert.equal(item.metadata.artifactUri, origUri, `${label} keeps upload artifactUri`);
    assert.equal(item.metadata.originalUrl, origUri, `${label} keeps upload originalUrl`);
    assert.ok(
      item.url.startsWith("zcode-artifact://") && item.url !== origUri,
      `${label} url must be materialized raw artifact URI`,
    );
    assert.ok(item.source?.path && basename(item.source.path) === expectedBase);
    assert.equal(
      sha256Hex(await readFile(item.source.path)),
      sha256Hex(origBytes),
      `${label} raw file SHA-256`,
    );
    assert.ok(item.metadata.preview, `${label} must have preview`);
  }
  assert.equal(resFullLog.contentBlock.text, fullLogText);
  assert.equal(resFullLog.metadata.preview?.truncated, false);
  assert.equal(resLog.metadata.storageKind, "inline");
  assert.ok(resLog.source?.path?.endsWith("runtime.log"));
  assert.ok(
    typeof resLog.metadata.preview?.text === "string" && resLog.metadata.preview.text.length > 0,
  );
  assert.equal(resHugeLog.metadata.recoverability, "preview_only");
  assert.equal(resHugeLog.metadata.preview?.truncated, true);
  assert.equal(resHugeLog.metadata.preview?.truncatedByTokenCap, true);
  assert.ok(resHugeLog.metadata.preview?.partialViewNotice?.includes("Truncated: PARTIAL view"));

  assert.equal(resVue.contentBlock.text, vueText);
  assert.equal(resVue.metadata.preview?.truncated, false);
  assert.equal(resJson.contentBlock.text, jsonText);
  assert.equal(resEmpty.contentBlock.text, "");
  assert.equal(resEmpty.metadata.sizeBytes, 0);
  assert.equal(resEmpty.metadata.preview?.text, "");

  // 验证旧平铺与新子目录 artifact 的 readToolResultArtifact / statToolResultArtifact 均正常
  const statOldFlat = await artifactStore.statToolResultArtifact({ uri: zipArt.uri });
  assert.equal(statOldFlat.path, zipArt.path);
  const readNewSubdir = await artifactStore.readToolResultArtifact({ uri: resJson.url });
  assert.equal(readNewSubdir.content, jsonText);
  const statNewSubdir = await artifactStore.statToolResultArtifact({ uri: resDocx.url });
  assert.equal(statNewSubdir.bytes, docxBytes.byteLength);
  assert.equal(basename(statNewSubdir.path), docxName);

  // 验证具名子目录多文件报错、sessionDir 符号链接拒绝、".." 隔离与旧平铺精确边界匹配
  const ambigDir = join(storageRoot, "artifacts", sessionId, "tool-result-ambig");
  await mkdir(ambigDir, { recursive: true });
  await writeFile(join(ambigDir, "one.txt"), "1");
  await writeFile(join(ambigDir, "two.txt"), "2");
  await assert.rejects(
    () =>
      artifactStore.readToolResultArtifact({
        uri: `zcode-artifact://${sessionId}/tool-result-ambig`,
      }),
    /Ambiguous/,
  );
  const symOutside = join(tempRoot, "sym-outside");
  await mkdir(symOutside, { recursive: true });
  await writeFile(join(symOutside, "tool-result-leak.txt"), "LEAK");
  await symlink(symOutside, join(storageRoot, "artifacts", "sym-sess"));
  await assert.rejects(
    () =>
      artifactStore.readToolResultArtifact({ uri: "zcode-artifact://sym-sess/tool-result-leak" }),
    /not found/,
  );
  // 预置 sessionDir 符号链接时，具名写入与平铺写入均拒绝，且外部目录 0 新增文件
  await assert.rejects(
    () =>
      artifactStore.writeToolResultBinaryArtifact({
        sessionId: "sym-sess",
        toolCallId: "sym-named",
        toolName: "prompt-attachment:file",
        content: Buffer.from("nope"),
        contentType: "text/plain",
        fileName: "evil.txt",
        retention: "session",
      }),
    /Unsafe tool artifact session directory/,
  );
  await assert.rejects(
    () =>
      artifactStore.writeToolResultArtifact({
        sessionId: "sym-sess",
        toolCallId: "sym-flat",
        toolName: "BigTool",
        content: "nope",
        contentType: "text/plain",
        retention: "session",
      }),
    /Unsafe tool artifact session directory/,
  );
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(symOutside)), [
    "tool-result-leak.txt",
  ]);

  // .zcode-tmp-report.txt 合法文件名经同级 staging 发布后可完整 write -> read -> stat 往返
  const tmpNameArt = await artifactStore.writeToolResultBinaryArtifact({
    sessionId,
    toolCallId: "tmp-name",
    toolName: "prompt-attachment:file",
    content: Buffer.from("TMP_NAME_OK", "utf8"),
    contentType: "text/plain",
    fileName: ".zcode-tmp-report.txt",
    retention: "session",
  });
  assert.equal(basename(tmpNameArt.path), ".zcode-tmp-report.txt");
  assert.equal(
    (await artifactStore.readToolResultArtifact({ uri: tmpNameArt.uri })).content,
    "TMP_NAME_OK",
  );
  assert.equal(
    (await artifactStore.statToolResultArtifact({ uri: tmpNameArt.uri })).path,
    tmpNameArt.path,
  );
  const dotDotArt = await artifactStore.writeToolResultBinaryArtifact({
    sessionId: "..",
    toolCallId: "dotdot",
    toolName: "prompt-attachment:file",
    content: Buffer.from("ok"),
    contentType: "text/plain",
    fileName: "ok.txt",
    retention: "session",
  });
  assert.ok(dotDotArt.path.startsWith(join(storageRoot, "artifacts", "unknown")));
  await writeFile(join(storageRoot, "artifacts", sessionId, "call-tool-result-10.txt"), "TEN");
  await assert.rejects(
    () =>
      artifactStore.readToolResultArtifact({ uri: `zcode-artifact://${sessionId}/tool-result-1` }),
    /not found/,
  );

  // 3) 真实 SQLite 持久化 + 冷恢复 + listArtifactReferrers 验证
  const history = new mod.MessageHistoryImpl();
  history.init("system fixture");
  history.addEntries(
    mod.buildRuntimeUserEntriesFromTurn("Please check all attachments.", resolved),
  );

  const runtimeStub = {
    sessionId,
    sessionStore: store,
    messageHistory: history,
    artifactStore,
    workingDirectory: tempRoot,
    workspaceRoot: tempRoot,
    config: { agentName: "zcode-agent", systemPrompt: "system fixture" },
    getTools: () => [],
    getSessionModelSelection: () => undefined,
    persistMessage: (m) => store.saveMessage(m),
    persistPart: (p) => store.savePart(p),
  };
  await mod.persistUserPrompt.call(
    runtimeStub,
    mod.createMessageId("msg-1"),
    "Please check all attachments.",
    resolved,
    traceContext,
  );

  // 模拟 fork 会话复制其中一个 .json FilePart，验证 listArtifactReferrers 识别双 URI
  const forkSessionId = await ensureSession("sess-fork-1", "fork-reg", "Fork Regression");
  const savedMessages = await store.messages({ sessionID: sessionId });
  const jsonPart = savedMessages[0].parts.find(
    (p) => p.type === "file" && p.filename === "config.json",
  );
  assert.ok(jsonPart, "persisted json FilePart must exist");
  await copyFilePartToFork(jsonPart, forkSessionId, "fork-msg-1", "fork-part-1");
  const referrers = await store.listArtifactReferrers([sessionId]);
  assert.deepEqual(
    referrers.get(sessionId),
    [forkSessionId],
    "fork part must protect source artifacts",
  );

  // 关库重开，冷恢复比对 live vs cold provider messages
  store.close();
  store = await mod.createSqliteSessionStore({ dbPath });
  const reloadedMessages = await store.messages({ sessionID: sessionId });
  const coldHistory = new mod.MessageHistoryImpl();
  coldHistory.init("system fixture");
  await mod.hydrateMessageHistoryFromSession({
    history: coldHistory,
    messages: reloadedMessages,
    artifactStore,
  });

  const liveProvider = mod.buildProviderRequestMessages({
    entries: history.toRuntimeEntries(),
  }).messages;
  const coldProvider = mod.buildProviderRequestMessages({
    entries: coldHistory.toRuntimeEntries(),
  }).messages;
  assert.deepEqual(coldProvider, liveProvider, "cold hydrated provider messages must match live");
  const coldText = coldProvider
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
    )
    .join("\n");
  assert.ok(
    coldText.includes("1\t<template>\n2\t  <div>vue-content"),
    "cold resume must keep .vue Read body",
  );
  assert.ok(coldText.includes(`1\t${jsonText}`), "cold resume must keep .json Read body");
  assert.ok(
    coldText.includes("Called the Read tool"),
    "text attachments must hit Read prompt_attachment reminder",
  );
  assert.ok(
    coldText.includes(resJson.source.path),
    ".json reminder must reference named disk path",
  );

  // 场景 5：原 artifact 缺失/损坏 -> 明确标记读取失败而非空成功附件
  const missingResolved = await resolveWithStore([
    {
      type: "file",
      content: "zcode-artifact://sess-attach-1/does-not-exist",
      filename: "missing.txt",
      mimeType: "text/plain",
    },
  ]);
  assert.equal(missingResolved[0].metadata.errorCode, "attachment_read_failed");
  assert.equal(missingResolved[0].metadata.recoverability, "metadata_only");

  const corruptArtifact = await artifactStore.writeToolResultArtifact({
    sessionId,
    toolCallId: "corrupt-upload",
    toolName: "prompt-attachment:upload",
    content: "data:application/zip;base64,not-valid-base64!!!",
    contentType: "text/plain",
    retention: "session",
  });
  const corruptResolved = await resolveWithStore([
    {
      type: "file",
      content: corruptArtifact.uri,
      filename: "broken.zip",
      mimeType: "application/zip",
    },
  ]);
  assert.equal(corruptResolved[0].metadata.errorCode, "attachment_read_failed");
  assert.equal(corruptResolved[0].metadata.recoverability, "metadata_only");

  // -------------------------------------------------------------------------
  // 验证 create-app.ts readPromptAttachment 与 v4-gateway.ts 白名单边界
  // -------------------------------------------------------------------------
  const app = await mod.createZCodeApp({
    providerRegistry: new mod.ProviderRegistry(),
    sessionId,
    skipUserConfig: true,
    runtimeConfig: { workingDirectory: tempRoot, storage: { dir: join(tempRoot, "app-storage") } },
    sessionStore: store,
    artifactStore,
  });
  try {
    const uploadedZip = await app.writePromptAttachment({
      bytes: zipBytes,
      fileName: "bundle.zip",
      mime: "application/zip",
    });
    const readZipBack = await app.readPromptAttachment({
      ref: uploadedZip.ref,
      mime: "application/zip",
      maxBytes: 1024 * 1024,
    });
    assert.equal(readZipBack.mediaType, "application/zip");
    assert.equal(sha256Hex(readZipBack.bytes), sha256Hex(zipBytes));

    const uploadedJson = await app.writePromptAttachment({
      bytes: Buffer.from(jsonText, "utf8"),
      fileName: "config.json",
      mime: "application/json",
    });
    const readJsonBack = await app.readPromptAttachment({
      ref: uploadedJson.ref,
      mime: "application/json",
      maxBytes: 1024 * 1024,
    });
    assert.equal(readJsonBack.mediaType, "application/json");
    assert.equal(Buffer.from(readJsonBack.bytes).toString("utf8"), jsonText);
  } finally {
    await app.close();
  }

  // 验证 v4-gateway 预览白名单仍然拒绝非媒体 MIME
  const gateway = new mod.ConversationV4Gateway({
    sessionExists: (id) => id === "s-gw",
    emitWireFrame: () => {},
    executeCommand: async () => undefined,
    readSessionAttachment: async () => ({ bytes: zipBytes, mediaType: "application/zip" }),
  });
  gateway.ingest("s-gw", {
    id: "e1",
    sessionId: "s-gw",
    type: mod.SessionEventType.SessionCreated,
    timestamp: new Date(1),
    traceId: "t1",
    sequenceNumber: 1,
    payload: { mode: "default", contextWindow: 200_000 },
  });
  gateway.ingest("s-gw", {
    id: "e2",
    sessionId: "s-gw",
    turnId: "turn-1",
    type: mod.SessionEventType.TurnStarted,
    timestamp: new Date(2),
    traceId: "t1",
    sequenceNumber: 2,
    payload: {
      turnNumber: 1,
      input: "zip",
      messageId: "m-gw",
      intent: {
        attachmentRefs: [
          {
            ref: zipArt.uri,
            fileName: "bundle.zip",
            mime: "application/zip",
            bytes: zipBytes.byteLength,
          },
        ],
      },
    },
  });
  await assert.rejects(
    () =>
      gateway.attachmentRead({
        sessionId: "s-gw",
        ref: zipArt.uri,
        target: { rowId: 2, entityId: "m-gw" },
        attachmentIndex: 0,
        offset: 0,
        limit: 1024,
      }),
    /fault\.attachment\.previewRefNotAuthorized|fault\.attachment\.previewNotMedia/,
  );
  gateway.dispose();

  // -------------------------------------------------------------------------
  // 场景 6：仅含 clipboard-text 上传附件的源会话被 fork 后，listArtifactReferrers 非空且
  // purgeSessionDataWith 清理源会话时进入 kept: referenced、磁盘原始文件完好保留
  // -------------------------------------------------------------------------
  const clipSrcSessionId = await ensureSession("sess_clip_src", "clip-src", "Clipboard Source");
  const clipForkSessionId = await ensureSession("sess_clip_fork", "clip-fork", "Clipboard Fork");
  const isolatedClipboardText = "FORK_PROTECTED_CLIPBOARD_CONTENT\nline2\n";
  const isolatedClipUpload = await uploadArtifact(
    "clip-src",
    "text/plain;charset=utf-8",
    Buffer.from(isolatedClipboardText, "utf8"),
    clipSrcSessionId,
  );
  const [mappedClipRef] = mod.mapAttachmentRefsToTurnAttachments([
    {
      ref: isolatedClipUpload.uri,
      fileName: "pasted.txt",
      mime: "text/plain",
      bytes: Buffer.byteLength(isolatedClipboardText),
      sourceKind: "clipboard-text",
    },
  ]);
  const [resolvedClipSrc] = await resolveWithStore([mappedClipRef], clipSrcSessionId);
  assert.equal(resolvedClipSrc.metadata.artifactUri, isolatedClipUpload.uri);
  assert.equal(resolvedClipSrc.metadata.originalUrl, isolatedClipUpload.uri);
  assert.ok(
    resolvedClipSrc.url.startsWith("zcode-artifact://") &&
      resolvedClipSrc.url !== isolatedClipUpload.uri,
  );
  const clipDiskPath = resolvedClipSrc.source?.path;
  assert.ok(
    clipDiskPath && existsSync(clipDiskPath),
    "materialized clipboard .txt must exist on disk",
  );

  const clipHistory = new mod.MessageHistoryImpl();
  clipHistory.init("system fixture");
  clipHistory.addEntries(mod.buildRuntimeUserEntriesFromTurn("", [resolvedClipSrc]));
  await mod.persistUserPrompt.call(
    { ...runtimeStub, sessionId: clipSrcSessionId, messageHistory: clipHistory },
    mod.createMessageId("clip-src-msg-1"),
    "",
    [resolvedClipSrc],
    traceContext,
  );
  const clipSrcMessages = await store.messages({ sessionID: clipSrcSessionId });
  const clipSrcPart = clipSrcMessages[0].parts.find((p) => p.type === "file");
  assert.ok(clipSrcPart, "source session clipboard FilePart must exist");

  await copyFilePartToFork(clipSrcPart, clipForkSessionId, "clip-fork-msg-1", "clip-fork-part-1");
  const clipReferrers = await store.listArtifactReferrers([clipSrcSessionId]);
  assert.deepEqual(
    clipReferrers.get(clipSrcSessionId),
    [clipForkSessionId],
    "listArtifactReferrers must detect clipboard-text artifact reference from fork session",
  );

  const sessionDataFiles = mod.createNodeSessionDataFiles({
    cliStorageRoot: storageRoot,
    memoryRoot: () => join(storageRoot, "memories/projects/test/memory"),
  });
  const purgeResult = await mod.purgeSessionDataWith(
    {
      store: {
        listOwnedSessionTrees: store.listOwnedSessionTrees.bind(store),
        listArtifactReferrers: store.listArtifactReferrers.bind(store),
        purgeSessions: store.purgeSessions.bind(store),
      },
      files: sessionDataFiles,
      residency: () => null,
      release: async () => {},
      forgetIndexed: () => {},
    },
    { sessionIds: [clipSrcSessionId], directories: [] },
  );
  assert.deepEqual(purgeResult.deleted, []);
  assert.deepEqual(purgeResult.kept, [{ sessionId: clipSrcSessionId, reason: "referenced" }]);
  assert.deepEqual(purgeResult.failed, []);
  assert.ok(existsSync(clipDiskPath), "clipboard raw file on disk must survive purge");
  assert.equal(
    sha256Hex(await readFile(clipDiskPath)),
    sha256Hex(Buffer.from(isolatedClipboardText, "utf8")),
  );
  const rereadUpload = await artifactStore.readToolResultArtifact({ uri: isolatedClipUpload.uri });
  assert.ok(rereadUpload.content.startsWith("data:text/plain"));

  // 验证未被引用的根 + 自有子会话在 purgeSessionDataWith 时在 deleted[].sessionIds 返回完整 owned-tree ID
  const ownedRootId = await ensureSession("sess_owned_root", "owned-root", "Owned Root");
  const ownedChildId = mod.createSessionId("sess_owned_child");
  await store.createSession({
    id: ownedChildId,
    projectID,
    slug: "owned-child",
    directory: tempRoot,
    title: "Owned Child",
    version: "1",
    parentID: ownedRootId,
    taskType: "subagent_child",
  });
  const ownedPurgeResult = await mod.purgeSessionDataWith(
    {
      store: {
        listOwnedSessionTrees: store.listOwnedSessionTrees.bind(store),
        listArtifactReferrers: store.listArtifactReferrers.bind(store),
        purgeSessions: store.purgeSessions.bind(store),
      },
      files: sessionDataFiles,
      residency: () => null,
      release: async () => {},
      forgetIndexed: () => {},
    },
    { sessionIds: [ownedRootId], directories: [] },
  );
  assert.equal(ownedPurgeResult.deleted.length, 1);
  assert.equal(ownedPurgeResult.deleted[0].sessionId, ownedRootId);
  assert.deepEqual(ownedPurgeResult.deleted[0].sessionIds, [ownedRootId, ownedChildId]);

  // -------------------------------------------------------------------------
  // 场景 7：同名不同内容的两个 报告.txt 上传，fork 仅引用其一，永久删除精确保留与删除
  // -------------------------------------------------------------------------
  const dupSrcSessionId = await ensureSession("sess_dup_src", "dup-src", "Duplicate Name Source");
  const dupForkSessionId = await ensureSession("sess_dup_fork", "dup-fork", "Duplicate Name Fork");
  const reportA = "REPORT_VERSION_A_KEEP\n";
  const reportB = "REPORT_VERSION_B_DROP\n";
  const uploadA = await uploadArtifact(
    "report-a",
    "text/plain",
    Buffer.from(reportA, "utf8"),
    dupSrcSessionId,
  );
  const uploadB = await uploadArtifact(
    "report-b",
    "text/plain",
    Buffer.from(reportB, "utf8"),
    dupSrcSessionId,
  );
  const [resDupA, resDupB] = await resolveWithStore(
    mod.mapAttachmentRefsToTurnAttachments([
      { ref: uploadA.uri, fileName: "报告.txt", mime: "text/plain", bytes: reportA.length },
      { ref: uploadB.uri, fileName: "报告.txt", mime: "text/plain", bytes: reportB.length },
    ]),
    dupSrcSessionId,
  );
  assert.notEqual(resDupA.source.path, resDupB.source.path);
  assert.equal(basename(resDupA.source.path), "报告.txt");
  assert.equal(basename(resDupB.source.path), "报告.txt");
  assert.equal(await readFile(resDupA.source.path, "utf8"), reportA);
  assert.equal(await readFile(resDupB.source.path, "utf8"), reportB);

  const dupHistory = new mod.MessageHistoryImpl();
  dupHistory.init("system fixture");
  dupHistory.addEntries(mod.buildRuntimeUserEntriesFromTurn("Compare reports", [resDupA, resDupB]));
  await mod.persistUserPrompt.call(
    { ...runtimeStub, sessionId: dupSrcSessionId, messageHistory: dupHistory },
    mod.createMessageId("dup-msg-1"),
    "Compare reports",
    [resDupA, resDupB],
    traceContext,
  );
  const dupSrcMessages = await store.messages({ sessionID: dupSrcSessionId });
  const dupPartA = dupSrcMessages[0].parts.find((p) => p.type === "file" && p.url === resDupA.url);
  assert.ok(dupPartA, "persisted FilePart A must exist");
  await copyFilePartToFork(dupPartA, dupForkSessionId, "dup-fork-msg-1", "dup-fork-part-1");

  const delHost = {
    store: {
      inspectSessionDeletions: store.inspectSessionDeletions.bind(store),
      beginSessionDeletion: store.beginSessionDeletion.bind(store),
      completeSessionDeletion: store.completeSessionDeletion.bind(store),
    },
    files: sessionDataFiles,
    busy: () => false,
    release: async () => {},
    forget: () => {},
  };
  const delBatchPreview = await mod.previewSessionDeletionsWith(delHost, {
    items: [{ sessionId: dupSrcSessionId, workspace: { workspacePath: tempRoot } }],
  });
  assert.equal(delBatchPreview.results.length, 1);
  assert.equal(delBatchPreview.results[0].preview.retainedArtifacts.length, 2);
  assert.equal(delBatchPreview.results[0].preview.deletedFiles, 2);
  const delPreview = await mod.previewSessionDeletionWith(delHost, {
    sessionId: dupSrcSessionId,
    workspace: { workspacePath: tempRoot },
  });
  const retainedNames = delPreview.retainedArtifacts.map((item) => item.fileName);
  assert.ok(retainedNames.includes("报告.txt"));
  // resDupA 的原上传平铺文件 + 具名子目录文件共 2 个保留；resDupB 的原上传平铺文件 + 具名子目录文件共 2 个删除
  assert.equal(delPreview.retainedArtifacts.length, 2);
  assert.equal(delPreview.deletedFiles, 2);
  const delExec = await mod.executeSessionDeletionWith(delHost, {
    sessionId: dupSrcSessionId,
    workspace: { workspacePath: tempRoot },
    revision: delPreview.revision,
    operationId: "op-dup-delete",
  });
  assert.equal(delExec.status, "deleted");
  assert.ok(existsSync(resDupA.source.path), "retained 报告.txt must survive deletion");
  assert.equal(await readFile(resDupA.source.path, "utf8"), reportA);
  assert.ok(!existsSync(resDupB.source.path), "unretained 报告.txt must be deleted");
  assert.ok(
    !existsSync(dirname(resDupB.source.path)),
    "unretained <artifactId> dir must be removed",
  );

  // -------------------------------------------------------------------------
  // 场景 8：createManagedCdpBrowserRuntime releaseSession 租约保留、复用、LRU 与 TTL 回收
  // -------------------------------------------------------------------------
  const fakeContexts = [];
  let fakeBrowserCloses = 0;
  const createFakePlaywright = () => async () => ({
    chromium: {
      executablePath: () => process.execPath,
      launch: async () => {
        let connected = true;
        const listeners = new Map();
        const browser = {
          close: async () => {
            if (!connected) return;
            fakeBrowserCloses += 1;
            connected = false;
            listeners.get("disconnected")?.();
          },
          isConnected: () => connected,
          on: (ev, fn) => listeners.set(ev, fn),
          newContext: async () => {
            const state = { closed: false, pages: [] };
            fakeContexts.push(state);
            const ctx = {
              browser: () => browser,
              close: async () => {
                state.closed = true;
              },
              pages: () => state.pages,
              on: () => {},
              newPage: async () => {
                let url = "about:blank";
                let pageClosed = false;
                const page = {
                  bringToFront: async () => {},
                  close: async () => {
                    pageClosed = true;
                  },
                  context: () => ctx,
                  goto: async (nextUrl) => {
                    url = nextUrl;
                  },
                  isClosed: () => pageClosed,
                  on: () => {},
                  setViewportSize: async () => {},
                  title: async () => "",
                  url: () => url,
                  viewportSize: () => ({ width: 1280, height: 720 }),
                };
                state.pages.push(page);
                return page;
              },
            };
            return ctx;
          },
        };
        return browser;
      },
    },
  });

  const browserRuntime = mod.createManagedCdpBrowserRuntime({
    loadPlaywright: createFakePlaywright(),
    maxReleasedSessions: 2,
    releasedSessionIdleTtlMs: 80,
  });
  const [cdpDesc] = await browserRuntime.browserControlPort.list({ sessionId: "b-active" });
  for (const sid of ["b-active", "b-r1", "b-r2", "b-r3"]) {
    await browserRuntime.browserControlPort.execute({
      browserId: cdpDesc.id,
      browserGeneration: cdpDesc.generation,
      sessionId: sid,
      command: { method: "newTab" },
    });
  }
  await browserRuntime.browserControlPort.execute({
    browserId: cdpDesc.id,
    browserGeneration: cdpDesc.generation,
    sessionId: "b-r1",
    command: { method: "navigate", url: "https://example.test/kept" },
  });
  await browserRuntime.releaseSession("b-r1");
  assert.equal(fakeContexts[1].closed, false, "releaseSession must keep BrowserContext alive");
  // 再次 list 复用原 context 与页面
  await browserRuntime.browserControlPort.list({ sessionId: "b-r1" });
  const r1Tabs = await browserRuntime.browserControlPort.execute({
    browserId: cdpDesc.id,
    browserGeneration: cdpDesc.generation,
    sessionId: "b-r1",
    command: { method: "list" },
  });
  assert.equal(r1Tabs.tabs?.[0]?.url, "https://example.test/kept");
  assert.equal(fakeContexts.length, 4, "must reuse original BrowserContext");

  // 触发 LRU：依次释放 b-r1、b-r2、b-r3（maxReleasedSessions=2 -> 仅驱逐 b-r1，绝不驱逐 b-active）
  await browserRuntime.releaseSession("b-r1");
  await browserRuntime.releaseSession("b-r2");
  await browserRuntime.releaseSession("b-r3");
  assert.equal(fakeContexts[0].closed, false, "active session must never be evicted");
  assert.equal(fakeContexts[1].closed, true, "LRU released session must be evicted");
  assert.equal(fakeContexts[2].closed, false);
  assert.equal(fakeContexts[3].closed, false);

  // closeSession 彻底销毁 b-r2
  await browserRuntime.browserControlPort.closeSession({ sessionId: "b-r2" });
  assert.equal(fakeContexts[2].closed, true, "closeSession must close context");

  // 等待空闲 TTL 到期自动回收 b-r3
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 150));
  assert.equal(fakeContexts[3].closed, true, "idle TTL must close released context");
  assert.equal(fakeContexts[0].closed, false, "active session still untouched");

  await browserRuntime.close();
  assert.equal(fakeContexts[0].closed, true);
  assert.equal(fakeBrowserCloses, 1);

  // maxReleasedSessions=1 下并发 releaseSession(A) + 重复 releaseSession(B) 不死锁
  fakeContexts.length = 0;
  const concRuntime = mod.createManagedCdpBrowserRuntime({
    loadPlaywright: createFakePlaywright(),
    maxReleasedSessions: 1,
    releasedSessionIdleTtlMs: 30_000,
  });
  const [concDesc] = await concRuntime.browserControlPort.list({ sessionId: "c-a" });
  await concRuntime.browserControlPort.execute({
    browserId: concDesc.id,
    browserGeneration: concDesc.generation,
    sessionId: "c-a",
    command: { method: "newTab" },
  });
  await concRuntime.browserControlPort.execute({
    browserId: concDesc.id,
    browserGeneration: concDesc.generation,
    sessionId: "c-b",
    command: { method: "newTab" },
  });
  await concRuntime.releaseSession("c-b");
  await Promise.race([
    Promise.all([concRuntime.releaseSession("c-a"), concRuntime.releaseSession("c-b")]),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("concurrent releaseSession deadlocked")), 1_000),
    ),
  ]);
  assert.equal(fakeContexts[0].closed, false);
  assert.equal(fakeContexts[1].closed, true);
  await concRuntime.close();

  // -------------------------------------------------------------------------
  // 场景 9：worktree 会话下 browser-control-broker 保持主仓库 workspaceKey 与规范化 workspacePath
  // -------------------------------------------------------------------------
  const brokerCalls = [];
  const broker = mod.createProtocolBrowserControlBroker({
    requestClient: async (method, params) => {
      brokerCalls.push({ method, params });
      return method.includes("List") ? { browsers: [] } : { ok: true, elapsedMs: 1 };
    },
    sessions: new Map([
      [
        "wt-sess",
        {
          deliveryKind: "desktop-continuous",
          workspace: {
            workspaceKey: "/workspace/repo",
            workspacePath: "/workspace/.zcode/worktrees/wt-1",
          },
        },
      ],
    ]),
  });
  await broker.list({ sessionId: "wt-sess", turnId: "wt-turn" });
  assert.equal(brokerCalls[0].params.workspaceKey, "/workspace/repo");
  assert.equal(brokerCalls[0].params.workspacePath, "/workspace/repo");

  store.close();
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: [
        "1KiB zip + named Chinese/space docx -> <artifactId>/<safeFileName> + local_ref + SHA-256 match + dual URIs",
        "100KiB UTF-8 log + .json + .vue + 0B .txt -> unified readTextFileForModel (inline + source + preview + prompt_attachment)",
        ">300KiB huge log -> unified readTextFileForModel partial view preview + dual URIs",
        "corrupt UTF-8/NUL + malicious paths -> sanitized inside <artifactId>/ + binary_file local_ref",
        "old flat & new subdir readToolResultArtifact / statToolResultArtifact compatibility",
        "duplicate 报告.txt across artifacts -> fork protects referenced one, permanent deletion removes unretained one",
        "createManagedCdpBrowserRuntime releaseSession keep/resume/closeSession/LRU/TTL verified",
      ],
    }),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
