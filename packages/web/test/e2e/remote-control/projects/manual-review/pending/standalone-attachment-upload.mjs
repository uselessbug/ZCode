// 独立 Web / 手机网页附件字节上传与营销轮询停用的隔离回归（本地 esbuild 打包真实源码，不触碰真实用户数据）。
//
// 对应 docs/ui/chat-file-attachments.md「传输路由」、docs/ui/chat-long-paste-text-attachment.md、
// docs/marketing-touch-client.md「非桌面 Web 停用营销轮询」。被测的是真实源码模块：
//   packages/ui/src/lib/chatAttachments.ts（serializeChatComposerAttachment）
//   packages/ui/src/v4/composer/attachmentUpload.ts（uploadComposerAttachment）
//   packages/ui/src/v4/attachmentUploadTransaction.ts（begin/chunk/commit 事务）
//   packages/ui/src/components/marketing-touch/MarketingTouchProvider.tsx
// 仅把与本场景无关的依赖（nanoid、Provider 的 hooks/服务注入、@zcode/shared barrel）替换为最小桩；
// 并内置一个模拟 Chromium 行为的 FileReader：空 Blob 的 readAsDataURL 返回无逗号的 "data:"。
//
// 覆盖（共 16 项检查）：
// 上传链路（真实 serialize + uploadComposerAttachment + V4 事务；假 agent 的 begin 经真实
// v4AttachmentBeginParamsSchema 校验，并按 checksum 重组校验字节）：
//  1. 1KiB 随机字节 .zip（无 localPath、空 file.type）→ SHA-256 一致，ref.bytes === 1024。
//  2. .docx、未知扩展名 .vue（application/octet-stream）→ 完整字节上传。
//  3. 200KiB .log → 全文上传，无「内容过长，已截断」。
//  4. 70,000 字符 clipboard-text → 全文上传，sourceKind 保留，ref.bytes 等于 UTF-8 字节数。
//  5. 0 字节 .gitkeep → begin(totalBytes=0,totalChunks=0)、0 次 chunk、commit 成功，ref.bytes === 0。
//  6. 20MiB 边界通过，且 totalChunks <= attachmentUploadMaxChunks。
//  7. 20MiB+1B 抛 OversizedInlineFileAttachmentError，0 次 begin，不读字节。
//  8. 含 localPath 的 25MiB 桌面文件保持零拷贝路径引用，不读字节。
//  9. v4AttachmentPutParamsSchema 接受 0 字节文件的空 dataBase64。
// 10. kind=file 的 textContent（topic-history 兼容）正常上传，bytes 取实际字节数。
// 11. image/video/pdf 的 dataBase64 空串视为无内容，返回 null 且 0 次 begin。
// 上传错误判定与本地化（真实 attachmentUpload.ts）：
// 12. 四类超限错误（image/video/pdf/file）判为非瞬时；普通网络错误仍可重试，AbortError 不重试。
// 13. 四类超限错误在 5 种语言下使用各自文案 id，参数替换正确；普通附件文案逐字断言。
// 14. 缺失 PDF 内容错误本地化，其余错误沿用 message。
// 营销 Provider（真实 MarketingTouchProvider）：
// 15. desktop=false：不调用 marketingTouchService.query，不挂 MutationObserver 与 visibility/online 监听。
// 16. desktop=true（对照）：创建 runtime、发起 query、挂载 MutationObserver。
//
// 挂载方式按环境自动选择：能解析到 react-test-renderer（当前验证容器）时用它；否则（干净
// pnpm install 的 CI）用 jsdom + react-dom/client（createRoot + React.act）。两种方式断言一致。
// 可用 ZCODE_ISOLATION_RENDERER=test-renderer|jsdom 强制选择，ZCODE_ISOLATION_NODE_MODULES
// 追加额外的 node_modules 搜索目录（路径分隔符分隔，优先于仓库自身目录）。
//
// 运行（仓库根目录；至少需要 esbuild，以及 react-test-renderer 或 jsdom + react-dom 之一）：
//   node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-attachment-upload.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// remote-control/projects/manual-review/pending 目录 → 仓库根
const repoRoot = resolve(here, "../../../../../../../..");
const uiSrc = join(repoRoot, "packages/ui/src");
const sharedSrc = join(repoRoot, "packages/shared/src");
const rpcSrc = join(repoRoot, "packages/rpc/src");

// ---------------------------------------------------------------------------
// 依赖定位：优先显式追加目录，其次仓库自身依赖，最后容器内的轻量验证工具目录（esbuild、react-test-renderer）。
// ---------------------------------------------------------------------------
function candidateNodeModules() {
  const extra = (process.env.ZCODE_ISOLATION_NODE_MODULES ?? "").split(delimiter).filter(Boolean);
  const dirs = [
    ...extra,
    join(repoRoot, "packages/ui/node_modules"),
    join(repoRoot, "node_modules"),
  ];
  const reactLink = join(repoRoot, "node_modules/react");
  if (existsSync(reactLink)) {
    // node_modules/react 是指向验证工具目录的软链，其上一层同时放着 react-test-renderer。
    dirs.push(dirname(realpathSync(reactLink)));
  }
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

function findPackageDir(name) {
  return nodePaths.find((dir) => existsSync(join(dir, name, "package.json"))) ?? null;
}

// 营销组件挂载方式：优先 react-test-renderer；不存在时（干净 CI）用 jsdom + react-dom/client。
const requestedRenderer = process.env.ZCODE_ISOLATION_RENDERER;
const rendererMode =
  requestedRenderer === "test-renderer" || requestedRenderer === "jsdom"
    ? requestedRenderer
    : findPackageDir("react-test-renderer")
      ? "test-renderer"
      : "jsdom";
let JSDOM = null;
// jsdom 模式下 react 与 react-dom 必须来自同一目录（react-dom 会校验版本一致）。
let reactAlias = {};
if (rendererMode === "jsdom") {
  const reactDomDir = nodePaths.find(
    (dir) =>
      existsSync(join(dir, "react-dom/package.json")) &&
      existsSync(join(dir, "react/package.json")),
  );
  if (!reactDomDir) {
    throw new Error("营销挂载需要 react-test-renderer，或 jsdom + react-dom（请先 pnpm install）");
  }
  reactAlias = {
    react: realpathSync(join(reactDomDir, "react")),
    "react-dom": realpathSync(join(reactDomDir, "react-dom")),
  };
  const jsdomDir = findPackageDir("jsdom");
  ({ JSDOM } = jsdomDir
    ? createRequire(join(jsdomDir, "noop.js"))("jsdom")
    : await import("jsdom"));
}
console.log(`营销挂载方式：${rendererMode}`);

// ---------------------------------------------------------------------------
// esbuild 插件：路径别名 + `.js`→`.ts(x)` + 最小桩。
// ---------------------------------------------------------------------------
function resolveTsCandidate(absPath) {
  const candidates = [absPath];
  if (absPath.endsWith(".js")) {
    const stem = absPath.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  candidates.push(`${absPath}.ts`, `${absPath}.tsx`, join(absPath, "index.ts"));
  return candidates.find((candidate) => existsSync(candidate) && !candidate.endsWith("/")) ?? null;
}

function stubModuleKey(path) {
  return path.replace(`${uiSrc}/`, "ui:").replace(/\.(tsx?|js)$/u, "");
}

function createPlugin(stubs) {
  return {
    name: "attachment-upload-isolation",
    setup(build) {
      const stubNs = "isolation-stub";
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path;
        // 外部包桩（nanoid、@zcode/shared barrel 等）。
        if (stubs[`pkg:${spec}`] || (spec === "pkg:v4-shim" && stubs[spec])) {
          return { path: `pkg:${spec}`, namespace: stubNs };
        }
        let absolute = null;
        if (spec.startsWith("@/")) {
          absolute = resolveTsCandidate(join(uiSrc, spec.slice(2)));
        } else if (spec === "@zcode/shared/zcode-protocol-v4") {
          // 真实 barrel 会连锁加载整个协议树；本场景只需要 core 的上限常量和 transport 的 put schema。
          return { path: "pkg:v4-shim", namespace: stubNs };
        } else if (spec === "@zcode/rpc") {
          absolute = join(rpcSrc, "index.ts");
        } else if (spec.startsWith(".") && args.importer && args.namespace === "file") {
          absolute = resolveTsCandidate(resolve(dirname(args.importer), spec));
        }
        if (!absolute) return undefined;
        const key = stubModuleKey(absolute);
        if (stubs[key]) {
          return { path: key, namespace: stubNs };
        }
        return { path: absolute };
      });
      build.onLoad({ filter: /.*/, namespace: stubNs }, (args) => ({
        contents: stubs[args.path],
        loader: "tsx",
        resolveDir: uiSrc,
      }));
    },
  };
}

async function bundle(contents, outfile, stubs, { define } = {}) {
  await esbuild.build({
    stdin: { contents, resolveDir: uiSrc, loader: "tsx", sourcefile: "isolation-entry.tsx" },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    logLevel: "error",
    nodePaths,
    alias: reactAlias,
    ...(define ? { define } : {}),
    plugins: [createPlugin(stubs)],
  });
}

// ---------------------------------------------------------------------------
// 上传链路桩。
// ---------------------------------------------------------------------------
const UPLOAD_STUBS = {
  // nanoid 只用于生成 composer id，与字节传输无关。
  "pkg:nanoid": "let n = 0; export const nanoid = () => `att-${++n}`;",
  // chatAttachments 只需要 VIDEO_INPUT_MAX_BYTES，attachmentUploadTransaction 只需要 ServiceChannels.ZCodeAgent。
  "pkg:@zcode/shared": `
    export const VIDEO_INPUT_MAX_BYTES = 30 * 1024 * 1024;
    export const ServiceChannels = { ZCodeAgent: "zcode-agent" };
  `,
  "ui:logger": "export const logger = { warn() {}, info() {}, error() {}, debug() {} };",
  "pkg:v4-shim": `
    export { PROTOCOL_V4_LIMITS } from ${JSON.stringify(join(sharedSrc, "zcode-protocol-v4/core.ts"))};
    export { v4AttachmentBeginParamsSchema, v4AttachmentPutParamsSchema } from ${JSON.stringify(join(sharedSrc, "zcode-protocol-v4/transport.ts"))};
  `,
};

const UPLOAD_ENTRY = `
  export {
    createChatComposerAttachment,
    createChatComposerPathAttachment,
    createClipboardTextComposerAttachment,
    serializeChatComposerAttachment,
    OversizedInlineFileAttachmentError,
    OversizedInlineImageAttachmentError,
    OversizedInlinePdfAttachmentError,
    OversizedInlineVideoAttachmentError,
    MissingInlinePdfContentError,
  } from "@/lib/chatAttachments.js";
  import zhCN from "@/i18n/locales/zh-CN.js";
  import enUS from "@/i18n/locales/en-US.js";
  import jaJP from "@/i18n/locales/ja-JP.js";
  import koKR from "@/i18n/locales/ko-KR.js";
  import ruRU from "@/i18n/locales/ru-RU.js";
  export const LOCALES = { "zh-CN": zhCN, "en-US": enUS, "ja-JP": jaJP, "ko-KR": koKR, "ru-RU": ruRU };
  export {
    formatAttachmentUploadError,
    isTransientAttachmentUploadError,
    uploadComposerAttachment,
  } from "@/v4/composer/attachmentUpload.js";
  export { uploadAttachmentTransaction } from "@/v4/attachmentUploadTransaction.js";
  export {
    PROTOCOL_V4_LIMITS,
    v4AttachmentBeginParamsSchema,
    v4AttachmentPutParamsSchema,
  } from "@zcode/shared/zcode-protocol-v4";
`;

// 模拟 Chromium：空 Blob 的 readAsDataURL 结果是 "data:"（无逗号、无 base64 段）。
class ChromiumLikeFileReader {
  result = null;
  error = null;
  onload = null;
  onerror = null;
  readAsDataURL(blob) {
    void blob.arrayBuffer().then(
      (buffer) => {
        const bytes = Buffer.from(buffer);
        this.result =
          bytes.length === 0
            ? "data:"
            : `data:${blob.type || "application/octet-stream"};base64,${bytes.toString("base64")}`;
        this.onload?.();
      },
      (error) => {
        this.error = error;
        this.onerror?.();
      },
    );
  }
}

globalThis.FileReader = ChromiumLikeFileReader;
// createChatComposerAttachment 会 createObjectURL；Node 的 URL 已提供实现，补 revoke 保险即可。
URL.createObjectURL ??= () => "blob:isolated";
URL.revokeObjectURL ??= () => {};

function createFakeAgent(mod) {
  const calls = { begin: [], chunk: [], commit: [], abort: [] };
  const uploads = new Map();
  let refSeq = 0;
  return {
    calls,
    uploads,
    async attachmentBeginV4(params) {
      // 用真实协议 schema 把关：0 字节必须 0 分片、分块数不得超过 attachmentUploadMaxChunks、
      // checksum/uploadId 格式合法。agent 层参数与 wire 层只差 workspace/connectionId 的包装。
      mod.v4AttachmentBeginParamsSchema.parse({
        workspace: { workspacePath: params.workspacePath, workspaceKey: params.workspacePath },
        connectionId: "isolated-connection",
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      });
      calls.begin.push(params);
      uploads.set(params.uploadId, { params, chunks: new Map() });
      return { uploadId: params.uploadId, state: "staging", nextChunkIndex: 0 };
    },
    async attachmentChunkV4(params) {
      calls.chunk.push(params);
      uploads
        .get(params.uploadId)
        .chunks.set(params.chunkIndex, Buffer.from(params.dataBase64, "base64"));
      return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
    },
    async attachmentCommitV4(params) {
      calls.commit.push(params);
      const upload = uploads.get(params.uploadId);
      const ordered = [...upload.chunks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, chunk]) => chunk);
      upload.bytes = Buffer.concat(ordered);
      assert.equal(
        upload.bytes.length,
        upload.params.totalBytes,
        "重组字节数必须等于 begin.totalBytes",
      );
      assert.equal(
        `sha256:${createHash("sha256").update(upload.bytes).digest("hex")}`,
        upload.params.checksum,
        "重组字节 SHA-256 必须等于 begin.checksum",
      );
      refSeq += 1;
      return { ref: `zcode-artifact://isolated/${refSeq}` };
    },
    async attachmentAbortV4(params) {
      calls.abort.push(params);
    },
  };
}

function lastUpload(agent) {
  return [...agent.uploads.values()].at(-1);
}

let passed = 0;
async function check(name, run) {
  await run();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function runUploadSuite(mod) {
  const workspace = { workspacePath: "/isolated/workspace" };
  async function upload(file, { localPath, factory = "file", sourceText } = {}) {
    const agent = createFakeAgent(mod);
    const put = (params, options) =>
      mod.uploadAttachmentTransaction(agent, workspace, params, options);
    const attachment =
      factory === "clipboard"
        ? mod.createClipboardTextComposerAttachment(sourceText)
        : mod.createChatComposerAttachment(file, localPath);
    const serialized = await mod.serializeChatComposerAttachment(attachment);
    const ref = await mod.uploadComposerAttachment(put, "session-1", serialized);
    return { agent, attachment, serialized, ref };
  }

  console.log("上传链路（真实 serialize + uploadComposerAttachment + V4 事务）");

  await check("1KiB 随机 .zip（空 file.type）分块重组 SHA-256 一致且 ref.bytes=1024", async () => {
    const payload = randomBytes(1024);
    const { agent, serialized, ref } = await upload(
      new File([payload], "archive.zip", { type: "" }),
    );
    assert.equal(serialized.kind, "file");
    assert.ok(!("textContent" in serialized), "新建普通文件不再产生 textContent");
    assert.equal(agent.calls.begin.length, 1);
    assert.equal(agent.calls.commit.length, 1);
    assert.deepEqual(lastUpload(agent).bytes, payload);
    assert.equal(ref?.bytes, 1024);
    assert.equal(agent.calls.begin[0].mime, "application/octet-stream");
  });

  await check(".docx 与未知扩展名 .vue 完整字节上传", async () => {
    for (const name of ["report.docx", "component.vue"]) {
      const payload = randomBytes(5000);
      const { agent, ref } = await upload(new File([payload], name, { type: "" }));
      assert.deepEqual(lastUpload(agent).bytes, payload, name);
      assert.equal(ref?.bytes, 5000, name);
    }
  });

  await check("200KiB .log 全文上传，无截断标记", async () => {
    const text = "line-中文-😀 ".repeat(20_000).slice(0, 200 * 1024);
    const bytes = Buffer.from(text, "utf8");
    const { agent, ref } = await upload(new File([text], "server.log", { type: "text/plain" }));
    assert.ok(!lastUpload(agent).bytes.toString("utf8").includes("[内容过长，已截断]"));
    assert.deepEqual(lastUpload(agent).bytes, bytes);
    assert.equal(ref?.bytes, bytes.length);
  });

  await check(
    "70,000 字符 clipboard-text 全文上传，sourceKind 保留，bytes 等于 UTF-8 字节数",
    async () => {
      const text = "粘贴ab😀\n".repeat(10_000).slice(0, 70_000);
      assert.equal(text.length, 70_000);
      const bytes = Buffer.from(text, "utf8");
      const { agent, serialized, ref } = await upload(null, {
        factory: "clipboard",
        sourceText: text,
      });
      assert.equal(serialized.sourceKind, "clipboard-text");
      assert.equal(ref?.sourceKind, "clipboard-text");
      assert.ok(!lastUpload(agent).bytes.toString("utf8").includes("[内容过长，已截断]"));
      assert.deepEqual(lastUpload(agent).bytes, bytes);
      assert.equal(ref?.bytes, bytes.length);
      assert.ok(bytes.length > text.length, "多字节字符使 UTF-8 字节数大于字符数");
    },
  );

  await check("0 字节 .gitkeep：begin(0,0)、0 次 chunk、commit 成功、ref.bytes=0", async () => {
    const { agent, serialized, ref } = await upload(new File([], ".gitkeep", { type: "" }));
    assert.equal(serialized.kind, "file");
    assert.equal(serialized.dataBase64, "");
    assert.equal(agent.calls.begin.length, 1);
    assert.equal(agent.calls.begin[0].totalBytes, 0);
    assert.equal(agent.calls.begin[0].totalChunks, 0);
    assert.equal(agent.calls.chunk.length, 0);
    assert.equal(agent.calls.commit.length, 1);
    assert.equal(ref?.bytes, 0);
  });

  await check("20MiB 边界通过", async () => {
    const limit = mod.PROTOCOL_V4_LIMITS.attachmentMaxBytes;
    assert.equal(limit, 20 * 1024 * 1024);
    const payload = Buffer.alloc(limit, 0x5a);
    const { agent, ref } = await upload(new File([payload], "edge.bin", { type: "" }));
    assert.equal(agent.calls.begin.length, 1);
    assert.equal(agent.calls.begin[0].totalBytes, limit);
    assert.ok(
      agent.calls.begin[0].totalChunks <= mod.PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks,
      `分块数 ${agent.calls.begin[0].totalChunks} 不得超过 attachmentUploadMaxChunks`,
    );
    assert.equal(lastUpload(agent).bytes.length, limit);
    assert.equal(ref?.bytes, limit);
  });

  await check(
    "20MiB+1B 抛 OversizedInlineFileAttachmentError 且 0 次 begin、不读字节",
    async () => {
      const limit = mod.PROTOCOL_V4_LIMITS.attachmentMaxBytes;
      const agent = createFakeAgent(mod);
      const file = new File([Buffer.alloc(limit + 1)], "too-big.bin", { type: "" });
      let reads = 0;
      const originalArrayBuffer = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => {
        reads += 1;
        return originalArrayBuffer();
      };
      const attachment = mod.createChatComposerAttachment(file);
      await assert.rejects(
        () => mod.serializeChatComposerAttachment(attachment),
        (error) => {
          assert.ok(error instanceof mod.OversizedInlineFileAttachmentError);
          assert.equal(error.message, "oversized-inline-file-attachment");
          assert.equal(error.filename, "too-big.bin");
          assert.equal(error.maxSizeBytes, limit);
          assert.equal(error.sizeBytes, limit + 1);
          return true;
        },
      );
      assert.equal(agent.calls.begin.length, 0);
      assert.equal(reads, 0, "超限必须在读取字节前拒绝");
    },
  );

  await check("含 localPath 的 25MiB 桌面文件保持零拷贝路径引用，不读字节", async () => {
    const file = new File([Buffer.alloc(25 * 1024 * 1024)], "huge.bin", { type: "" });
    let reads = 0;
    const originalArrayBuffer = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => {
      reads += 1;
      return originalArrayBuffer();
    };
    const { agent, serialized, ref } = await upload(file, { localPath: "/Users/dev/huge.bin" });
    assert.equal(serialized.kind, "file");
    assert.equal(serialized.localPath, "/Users/dev/huge.bin");
    assert.ok(!("dataBase64" in serialized));
    assert.equal(ref?.ref, "/Users/dev/huge.bin");
    assert.equal(ref?.bytes, 25 * 1024 * 1024);
    assert.equal(reads, 0);
    assert.equal(agent.calls.begin.length, 0);
  });

  await check("v4AttachmentPutParamsSchema 接受 0 字节文件的空 dataBase64", async () => {
    const parsed = mod.v4AttachmentPutParamsSchema.parse({
      sessionId: "s",
      fileName: ".gitkeep",
      mime: "application/octet-stream",
      dataBase64: "",
    });
    assert.equal(parsed.dataBase64, "");
  });

  await check(
    "uploadComposerAttachment：kind=file 的 textContent（topic-history 兼容）正常上传",
    async () => {
      const agent = createFakeAgent(mod);
      const put = (params, options) =>
        mod.uploadAttachmentTransaction(agent, workspace, params, options);
      const text = "历史话题 topic-history 😀";
      const ref = await mod.uploadComposerAttachment(put, "session-1", {
        kind: "file",
        filename: "topic.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        textContent: text,
        sourceKind: "topic-history",
        messageCount: 3,
      });
      assert.equal(lastUpload(agent).bytes.toString("utf8"), text);
      // bytes 以实际上传内容为准，而不是元信息里的 sizeBytes。
      assert.equal(ref?.bytes, Buffer.byteLength(text, "utf8"));
      assert.equal(ref?.sourceKind, "topic-history");
      assert.equal(ref?.messageCount, 3);
    },
  );

  await check(
    "uploadComposerAttachment：媒体 dataBase64 空串视为无内容，返回 null 且不 begin",
    async () => {
      const agent = createFakeAgent(mod);
      const put = (params, options) =>
        mod.uploadAttachmentTransaction(agent, workspace, params, options);
      for (const kind of ["image", "video", "pdf"]) {
        const ref = await mod.uploadComposerAttachment(put, "session-1", {
          kind,
          filename: `empty.${kind}`,
          mimeType: kind === "pdf" ? "application/pdf" : `${kind}/x`,
          sizeBytes: 0,
          dataBase64: "",
        });
        assert.equal(ref, null, kind);
      }
      assert.equal(agent.calls.begin.length, 0);
    },
  );

  console.log("上传错误判定与本地化（真实 attachmentUpload 错误判定）");

  const limit = mod.PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const oversizedCases = [
    ["image", mod.OversizedInlineImageAttachmentError, "chat.attachments.oversizedInlineImage"],
    ["video", mod.OversizedInlineVideoAttachmentError, "chat.attachments.oversizedInlineVideo"],
    ["pdf", mod.OversizedInlinePdfAttachmentError, "chat.attachments.oversizedInlinePdf"],
    ["file", mod.OversizedInlineFileAttachmentError, "chat.attachments.oversizedInlineFile"],
  ];
  // 普通附件超限文案的 5 种语言逐字断言，防止 locale 被改动后无人察觉。
  const expectedFileMessages = {
    "zh-CN": "附件 big.zip 过大（25 MB），单个附件不能超过 20 MB。",
    "en-US": "Attachment big.zip is too large (25 MB). Maximum size per attachment is 20 MB.",
    "ja-JP": "添付ファイル big.zip が大きすぎます（25 MB）。1 ファイルあたりの上限は 20 MB です。",
    "ko-KR": "첨부 파일 big.zip이(가) 너무 큽니다(25 MB). 파일당 최대 크기는 20 MB입니다.",
    "ru-RU": "Вложение big.zip слишком большое (25 MB). Максимальный размер одного файла — 20 MB.",
  };
  // 与 react-intl 对简单 {name} 占位符的行为一致；缺失的 id 直接失败，避免回落到 id 掩盖漏翻。
  function createFormatter(messages) {
    return {
      formatMessage({ id }, values = {}) {
        const template = messages[id];
        assert.equal(typeof template, "string", `缺少文案 ${id}`);
        return template.replace(/\{(\w+)\}/gu, (_, key) => String(values[key]));
      },
    };
  }

  await check("四类超限错误（image/video/pdf/file）判为非瞬时，不自动重试", async () => {
    for (const [name, ErrorClass] of oversizedCases) {
      const error = new ErrorClass({
        filename: "big.zip",
        maxSizeBytes: limit,
        sizeBytes: limit + 1,
      });
      assert.equal(mod.isTransientAttachmentUploadError(error), false, name);
    }
    // 对照：普通网络错误仍可自动重试；AbortError 不重试。
    assert.equal(mod.isTransientAttachmentUploadError(new Error("socket hang up")), true);
    const abort = new Error("canceled");
    abort.name = "AbortError";
    assert.equal(mod.isTransientAttachmentUploadError(abort), false);
  });

  await check("四类超限错误在 5 种语言下使用各自文案 id 且参数格式化正确", async () => {
    for (const [locale, messages] of Object.entries(mod.LOCALES)) {
      const intl = createFormatter(messages);
      for (const [name, ErrorClass, messageId] of oversizedCases) {
        const error = new ErrorClass({
          filename: "big.zip",
          maxSizeBytes: limit,
          sizeBytes: 25 * 1024 * 1024,
        });
        const text = mod.formatAttachmentUploadError(intl, error);
        assert.equal(
          text,
          intl.formatMessage(
            { id: messageId },
            { filename: "big.zip", size: "25 MB", maxSize: "20 MB" },
          ),
          `${locale}/${name}`,
        );
        assert.ok(
          text.includes("big.zip") && text.includes("25 MB") && text.includes("20 MB"),
          `${locale}/${name}`,
        );
        assert.ok(!text.includes("{"), `${locale}/${name} 存在未替换占位符`);
      }
      const fileText = mod.formatAttachmentUploadError(
        intl,
        new mod.OversizedInlineFileAttachmentError({
          filename: "big.zip",
          maxSizeBytes: limit,
          sizeBytes: 25 * 1024 * 1024,
        }),
      );
      assert.equal(fileText, expectedFileMessages[locale], locale);
    }
  });

  await check("非超限错误文案：缺失 PDF 内容本地化，其余沿用 message", async () => {
    const intl = createFormatter(mod.LOCALES["en-US"]);
    assert.match(
      mod.formatAttachmentUploadError(
        intl,
        new mod.MissingInlinePdfContentError({ filename: "a.pdf", sizeBytes: 1 }),
      ),
      /a\.pdf/u,
    );
    assert.equal(
      mod.formatAttachmentUploadError(intl, new Error("proto.payloadTooLarge")),
      "proto.payloadTooLarge",
    );
    assert.equal(mod.formatAttachmentUploadError(intl, "plain"), "plain");
  });
}

// ---------------------------------------------------------------------------
// 营销 Provider：渲染真实 MarketingTouchProvider，只替换注入的服务与 hooks。
// ---------------------------------------------------------------------------
const MARKETING_STUBS = {
  "pkg:@zcode/shared": `
    export const BUILTIN_MODEL_PROVIDER_IDS = { bigmodelStartPlan: "bigmodel-start-plan" };
    export const toZhOrEnLocale = (locale) => locale;
    export const ZCODE_ENV = "test";
  `,
  "ui:request-security-edition/claim": `
    export const prepareRequestVerificationClaim = async () => ({});
    export const useRequestVerificationPrewarm = () => {};
  `,
  "ui:request-security-edition/errors":
    "export const requestVerificationClaimFailureMessageId = () => 'x';",
  "ui:hooks/useStartPlanEntitlement":
    "const value = { refresh() {} }; export const useStartPlanEntitlement = () => value;",
  "ui:settings/CodingPlanUpgradeDialogProvider":
    "const value = { openCodingPlanUpgrade() {} }; export const useCodingPlanUpgradeDialog = () => value;",
  "ui:rewards/RewardsProvider": "export const useOpenRewards = () => () => {};",
  "ui:WorkspaceSidebarFooterUsageSummary":
    "export const useWorkspaceSidebarFooterUsageSummaryState = () => ({ upgradeTargetProviderId: undefined });",
  "ui:store/TabStoreProvider": `
    const state = { openSettingsTab() {}, activeWorkspacePath: null, activeWorkspaceIdentity: null };
    const api = { getState: () => state };
    export const useTabStore = (selector) => selector(state);
    export const useTabStoreApi = () => api;
  `,
  "ui:lib/settingsNavigation": "export const setPendingSettingsSectionIntent = () => {};",
  "ui:lib/pluginStoreNavigation": "export const requestPluginStoreOpen = () => {};",
  "ui:lib/marketingNavigation": `
    export const requestMarketingNavigation = () => {};
    export const marketingNavigation = {};
    export const finishMarketingNavigation = () => {};
    export const marketingSettingsSections = {};
    export const waitForMarketingCapability = async () => {};
  `,
  "ui:hooks/useServices": "export const useServices = () => globalThis.__marketingTest.services;",
  "ui:hooks/usePlatform": "const platform = {}; export const usePlatform = () => platform;",
  "ui:store/StoreProvider": `
    const state = { user: null, isRestoringOAuthSession: false, requestLoginEntry() {} };
    export const useZCodeStore = (selector) => selector(state);
  `,
  "ui:i18n/IntlProvider": `
    const value = { intl: { formatMessage: ({ id }) => id }, locale: "zh-CN", localeResolved: true };
    export const useZCodeIntl = () => value;
  `,
  "ui:components/cloud-content-dialog/useCloudHeroEnvironment":
    "export const useCloudHeroEnvironment = () => ({ dark: false });",
  "ui:components/marketing-touch/MarketingDialogs": "export const MarketingDialogs = () => null;",
  "ui:components/ui/toast": "export const toast = { success() {}, error() {} };",
  "ui:logger": "export const logger = { warn() {}, info() {}, error() {}, debug() {} };",
  "ui:components/marketing-touch/MarketingBanner": "export const MarketingBannerView = () => null;",
  "ui:components/marketing-touch/marketingPopupAdapter": `
    export const canOpenMarketingPopup = () => true;
    export const marketingLabel = (text) => String(text ?? "");
  `,
  "ui:components/marketing-touch/marketingResources":
    "export const prepareMarketingHero = () => null;",
  "ui:components/marketing-touch/useMarketingTaskCompletionRefresh": `
    import { createContext } from "react";
    export const MarketingRefreshContext = createContext(null);
  `,
};

const MARKETING_ENTRY_TEST_RENDERER = `
  import { createElement } from "react";
  import TestRenderer, { act } from "react-test-renderer";
  import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";

  export async function renderProvider(desktop) {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(MarketingTouchProvider, { desktop }, createElement("div", null, "child")),
      );
    });
    // 让可能存在的 poller.refresh() 异步 query 先走完，避免漏掉延迟请求。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const snapshot = JSON.stringify(renderer.toJSON());
    await act(async () => {
      renderer.unmount();
    });
    return snapshot;
  }
`;

// jsdom 模式：真实 DOM + createRoot + React.act，断言与 test-renderer 模式完全一致。
const MARKETING_ENTRY_JSDOM = `
  import { createElement, act } from "react";
  import { createRoot } from "react-dom/client";
  import { MarketingTouchProvider } from "@/components/marketing-touch/MarketingTouchProvider.js";

  export async function renderProvider(desktop) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MarketingTouchProvider, { desktop }, createElement("div", null, "child")),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const snapshot = container.innerHTML;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    return snapshot;
  }
`;

const MARKETING_ENTRY =
  rendererMode === "jsdom" ? MARKETING_ENTRY_JSDOM : MARKETING_ENTRY_TEST_RENDERER;

async function runMarketingSuite(mod) {
  console.log("营销 Provider（真实 MarketingTouchProvider）");

  async function render(desktop) {
    const observers = [];
    const events = [];
    let queryCalls = 0;
    // 只记录营销 runtime 才会注册的监听；React DOM 自身会在 document 上挂 selectionchange 等，不计入。
    const recordEvent = (scope, name) => {
      if (name === "visibilitychange" || name === "online") events.push(`${scope}:${name}`);
    };
    let dom = null;
    if (rendererMode === "jsdom") {
      dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
      const { window: win } = dom;
      class CountingMutationObserver extends win.MutationObserver {
        constructor(callback) {
          super(callback);
          observers.push(this);
        }
      }
      win.MutationObserver = CountingMutationObserver;
      const originalDocAdd = win.document.addEventListener.bind(win.document);
      win.document.addEventListener = (name, ...rest) => {
        recordEvent("document", name);
        return originalDocAdd(name, ...rest);
      };
      const originalWinAdd = win.addEventListener.bind(win);
      win.addEventListener = (name, ...rest) => {
        recordEvent("window", name);
        return originalWinAdd(name, ...rest);
      };
      Object.defineProperty(win.document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      globalThis.window = win;
      globalThis.document = win.document;
      globalThis.MutationObserver = CountingMutationObserver;
      for (const key of [
        "HTMLElement",
        "Node",
        "Element",
        "Event",
        "CustomEvent",
        "getComputedStyle",
      ]) {
        globalThis[key] = win[key];
      }
    } else {
      class FakeMutationObserver {
        constructor() {
          observers.push(this);
        }
        observe() {}
        disconnect() {}
      }
      globalThis.MutationObserver = FakeMutationObserver;
      globalThis.document = {
        visibilityState: "visible",
        body: {},
        addEventListener: (name) => recordEvent("document", name),
        removeEventListener() {},
      };
      globalThis.window = globalThis;
      globalThis.addEventListener = (name) => recordEvent("window", name);
      globalThis.removeEventListener = () => {};
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.__marketingTest = {
      services: {
        marketingTouchService: {
          async query() {
            queryCalls += 1;
            return { deliveries: [] };
          },
          async report() {},
        },
        cloudContentService: {},
        usageStatsService: {},
      },
    };
    const snapshot = await mod.renderProvider(desktop);
    dom?.window.close();
    return { snapshot, queryCalls, observers: observers.length, events };
  }

  await check(
    "desktop=false：不调用 marketingTouchService.query、不挂 MutationObserver/监听，子树照常渲染",
    async () => {
      const result = await render(false);
      assert.equal(result.queryCalls, 0);
      assert.equal(result.observers, 0);
      assert.deepEqual(result.events, []);
      assert.match(result.snapshot, /child/u);
    },
  );

  await check(
    "desktop=true（对照）：创建 runtime 并发起 query、挂载 MutationObserver",
    async () => {
      const result = await render(true);
      assert.ok(result.queryCalls >= 1, `desktop 应发起 query，实际 ${result.queryCalls}`);
      assert.equal(result.observers, 1);
      assert.match(result.snapshot, /child/u);
    },
  );
}

const workDir = await mkdtemp(join(tmpdir(), "zcode-attachment-upload-"));
try {
  const uploadOut = join(workDir, "upload.mjs");
  const marketingOut = join(workDir, "marketing.mjs");
  await Promise.all([
    bundle(UPLOAD_ENTRY, uploadOut, UPLOAD_STUBS),
    bundle(MARKETING_ENTRY, marketingOut, MARKETING_STUBS, {
      define: { "import.meta.env": '{"PROD":true,"DEV":false}' },
    }),
  ]);

  await runUploadSuite(await import(pathToFileURL(uploadOut).href));
  await runMarketingSuite(await import(pathToFileURL(marketingOut).href));
  console.log(`standalone-attachment-upload: ${passed} checks passed`);
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
// react-test-renderer / react-dom 内部的 scheduler 可能遗留 MessagePort 句柄，进程不会自行退出；
// 走到这里说明所有断言已通过（失败会在上方抛出并以非 0 退出），显式退出避免脚本挂起。
process.exit(0);
