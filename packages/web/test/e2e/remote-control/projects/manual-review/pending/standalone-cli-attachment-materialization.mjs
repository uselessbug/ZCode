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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    `export { purgeSessionDataWith } from ${JSON.stringify(join(cliPackages, "bootstrap/src/zcode-protocol/session-data/index.ts"))};`,
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
  const resolveWithStore = (attachments, targetSessionId = sessionId) =>
    mod.resolveTurnAttachments(attachments, {
      artifactStore,
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
  // 场景 1：1KiB 随机 .zip 与伪 .docx（PK 头二进制）
  // -------------------------------------------------------------------------
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(1020)]);
  const docxBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(508)]);
  const zipArt = await uploadArtifact("bundle.zip", "application/zip", zipBytes);
  // 故意给伪 .docx 标成 text/plain，验证二进制扩展名排除不被 MIME 误导
  const docxArt = await uploadArtifact("spec.docx", "text/plain", docxBytes);

  // -------------------------------------------------------------------------
  // 场景 2：100KiB UTF-8 .log
  // -------------------------------------------------------------------------
  const largeLogText = `${"2026-11-16T00:00:00Z INFO attachment test line\n".repeat(2200)}`;
  const largeLogBytes = Buffer.from(largeLogText, "utf8");
  assert.ok(largeLogBytes.byteLength > 64 * 1024, "log fixture must exceed 64KiB");
  const logArt = await uploadArtifact("runtime.log", "text/plain", largeLogBytes);

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
  // 场景 4：含非法 UTF-8 字节与 NUL 字节的伪 .txt，以及无扩展名二进制/clipboard-text
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

  // 1) 通过真实 attachment-refs.ts 映射（验证不提前解码，不丢弃 >64KiB，不设 path）
  const refs = [
    {
      ref: zipArt.uri,
      fileName: "bundle.zip",
      mime: "application/zip",
      bytes: zipBytes.byteLength,
    },
    { ref: docxArt.uri, fileName: "spec.docx", mime: "text/plain", bytes: docxBytes.byteLength },
    {
      ref: logArt.uri,
      fileName: "runtime.log",
      mime: "text/plain",
      bytes: largeLogBytes.byteLength,
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
      fileName: "pasted.txt",
      mime: "text/plain",
      bytes: Buffer.byteLength(clipboardText),
      sourceKind: "clipboard-text",
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

  // 断言场景 1（.zip & 伪 .docx）
  const [
    resZip,
    resDocx,
    resLog,
    resVue,
    resJson,
    resEmpty,
    resFakeTxt,
    resNoExtBin,
    resClipboard,
  ] = resolved;
  for (const [label, item, origBytes, origUri, ext] of [
    ["zip", resZip, zipBytes, zipArt.uri, ".zip"],
    ["docx", resDocx, docxBytes, docxArt.uri, ".docx"],
    ["log", resLog, largeLogBytes, logArt.uri, ".log"],
    ["fakeTxt", resFakeTxt, fakeTxtBytes, fakeTxtArt.uri, ".txt"],
    ["noExtBin", resNoExtBin, noExtBinBytes, noExtBinArt.uri, ".bin"],
    ["clipboard", resClipboard, Buffer.from(clipboardText, "utf8"), clipboardArt.uri, ".txt"],
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
    assert.ok(diskPath && diskPath.endsWith(ext), `${label} disk path must end with ${ext}`);
    assert.ok(item.metadata.pathReferenceText.includes(diskPath), `${label} pathReferenceText`);
    assert.equal(sha256Hex(await readFile(diskPath)), sha256Hex(origBytes), `${label} SHA-256`);
  }
  assert.ok(resLog.metadata.pathReferenceText.includes("larger than the inline text budget"));
  assert.ok(resZip.metadata.pathReferenceText.includes("not a known text attachment"));
  assert.ok(resDocx.metadata.pathReferenceText.includes("not a known text attachment"));
  assert.ok(resFakeTxt.metadata.pathReferenceText.includes("not a known text attachment"));
  assert.ok(!resFakeTxt.metadata.pathReferenceText.includes("\ufffd"), "must not inject U+FFFD");
  assert.ok(resClipboard.metadata.pathReferenceText.includes("pasted-text temporary attachment"));

  // 断言场景 3（2KiB .vue / .json & 0 字节 .txt）
  assert.equal(resVue.metadata.storageKind, "inline");
  assert.equal(resVue.contentBlock.type, "text");
  assert.equal(resVue.contentBlock.text, vueText);
  assert.equal(resVue.metadata.artifactUri, vueArt.uri);
  assert.equal(resVue.metadata.preview?.truncated, false);

  assert.equal(resJson.metadata.storageKind, "inline");
  assert.equal(resJson.mime, "application/json");
  assert.equal(resJson.contentBlock.type, "text");
  assert.equal(resJson.contentBlock.text, jsonText);

  assert.equal(resEmpty.metadata.storageKind, "inline");
  assert.equal(resEmpty.contentBlock.type, "text");
  assert.equal(resEmpty.contentBlock.text, "");
  assert.equal(resEmpty.metadata.sizeBytes, 0);
  assert.equal(resEmpty.metadata.preview?.text, "");

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

  // 模拟 fork 会话复制其中一个 FilePart，验证 listArtifactReferrers 识别双 URI
  const forkSessionId = await ensureSession("sess-fork-1", "fork-reg", "Fork Regression");
  const savedMessages = await store.messages({ sessionID: sessionId });
  const zipPart = savedMessages[0].parts.find(
    (p) => p.type === "file" && p.filename === "bundle.zip",
  );
  assert.ok(zipPart, "persisted zip FilePart must exist");
  await copyFilePartToFork(zipPart, forkSessionId, "fork-msg-1", "fork-part-1");
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
  assert.ok(coldText.includes(vueText), "cold resume must keep .vue body");
  assert.ok(coldText.includes(jsonText), "cold resume must keep .json body");

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

  store.close();
  console.log(
    JSON.stringify({
      ok: true,
      scenarios: [
        "1KiB zip + fake docx -> local_ref + raw bytes SHA-256 match + dual URIs + fork protection",
        "100KiB UTF-8 log -> local_ref(text_too_large) + full bytes SHA-256 match",
        "2KiB vue/json + 0B txt -> inline + cold hydrate exact match",
        "corrupt UTF-8/NUL fake txt -> downgraded to binary_file + raw bytes SHA-256 match",
        "missing/corrupt artifact -> attachment_read_failed placeholder",
        "create-app decodePromptAttachmentDataUrl allows zip/json + v4-gateway media boundary preserved",
        "clipboard-text fork protection -> listArtifactReferrers non-empty + purgeSessionDataWith kept:referenced + raw file intact",
      ],
    }),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
