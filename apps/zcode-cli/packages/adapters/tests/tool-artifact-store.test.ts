import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId, createToolCallId, type SessionId } from "@zcode/contracts";
import {
  createStorageFsFaultInjector,
  resetStorageFsFaultInjectorForTests,
  setStorageFsFaultInjectorForTests,
} from "../src/storage/fs-fault-injection.js";
import { createNodeToolArtifactStore, sanitizeArtifactFileName } from "../src/storage/index.js";

describe("Node tool artifact store", () => {
  afterEach(() => {
    resetStorageFsFaultInjectorForTests();
  });

  it("persists tool result artifacts under a session directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });

    try {
      const result = await store.writeToolResultArtifact({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("artifact-call"),
        toolName: "BigTool",
        content: "large output",
        contentType: "text/plain",
        retention: "session",
      });

      expect(result.uri).toContain("zcode-artifact://");
      expect(result.path).toBeDefined();
      expect(result.bytes).toBe(Buffer.byteLength("large output", "utf8"));
      await expect(readFile(result.path!, "utf8")).resolves.toBe("large output");

      const read = await store.readToolResultArtifact({ uri: result.uri });
      expect(read).toMatchObject({
        bytes: Buffer.byteLength("large output", "utf8"),
        content: "large output",
        contentType: "text/plain",
        uri: result.uri,
      });

      await expect(store.statToolResultArtifact!({ uri: result.uri })).resolves.toMatchObject({
        uri: result.uri,
        bytes: Buffer.byteLength("large output", "utf8"),
        contentType: "text/plain",
        path: result.path,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("injects fs faults before text artifact writes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const sessionId = createSessionId("artifact-session");

    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          id: "D05-artifact-write-enospc",
          code: "ENOSPC",
          operations: ["writeFile"],
          pathRegex: "tool-result-.*\\.txt$",
        },
      ]),
    );

    try {
      await expect(
        store.writeToolResultArtifact({
          sessionId,
          toolCallId: createToolCallId("artifact-call"),
          toolName: "BigTool",
          content: "large output",
          contentType: "text/plain",
          retention: "session",
        }),
      ).rejects.toMatchObject({
        code: "ENOSPC",
        syscall: "writeFile",
        zcodeFsFaultId: "D05-artifact-write-enospc",
      });

      await expect(readdir(join(rootDir, sessionId))).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("persists binary tool result artifacts without text encoding", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);

    try {
      const result = await store.writeToolResultBinaryArtifact!({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("artifact-call"),
        toolName: "McpScreenshot",
        content: pngBytes,
        contentType: "image/png",
        extension: ".png",
        retention: "session",
      });

      expect(result.path).toBeDefined();
      expect(result.path).toMatch(/\.png$/);
      expect(result.bytes).toBe(pngBytes.byteLength);
      expect(result.contentType).toBe("image/png");
      await expect(readFile(result.path!)).resolves.toEqual(Buffer.from(pngBytes));

      const read = await store.readToolResultArtifact({ uri: result.uri });
      expect(read).toMatchObject({
        bytes: pngBytes.byteLength,
        content: Buffer.from(pngBytes).toString("base64"),
        contentType: "image/png",
        uri: result.uri,
      });

      const rawBytes = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
      const rawResult = await store.writeToolResultBinaryArtifact!({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("raw-call"),
        toolName: "RawBytes",
        content: rawBytes,
        contentType: "application/octet-stream",
        retention: "session",
      });

      expect(rawResult.path).toMatch(/\.bin$/);
      const rawRead = await store.readToolResultArtifact({ uri: rawResult.uri });
      expect(rawRead).toMatchObject({
        bytes: rawBytes.byteLength,
        content: Buffer.from(rawBytes).toString("base64"),
        contentType: "application/octet-stream",
        uri: rawResult.uri,
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  // Bug 根因（2026-09-04）：文本读回按文件名推 contentType，办公文件扩展名不在表里 → 当作
  // application/json 走 utf8 解码 → 字节损坏。二进制读回返回原始字节，不经任何编码。
  it("reads binary artifacts back as raw bytes regardless of extension", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    // 含无效 utf8 序列（0xff 0xfe）与 NUL：任何文本解码都会改写它。
    const xlsxLikeBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0xc3, 0x28]);

    try {
      const written = await store.writeToolResultBinaryArtifact!({
        sessionId: createSessionId("artifact-session"),
        toolCallId: createToolCallId("dwfrun-1:artifact#1@1"),
        toolName: "CreateWorkflow",
        content: xlsxLikeBytes,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: ".xlsx",
        retention: "project",
      });
      expect(written.path).toMatch(/\.xlsx$/);

      const read = await store.readToolResultBinaryArtifact!({ uri: written.uri });
      expect(Array.from(read.bytes)).toEqual(Array.from(xlsxLikeBytes));
      expect(read.uri).toBe(written.uri);
      expect(read.path).toBe(written.path);
      // 文件名推断只是兜底：办公扩展名给 octet-stream，绝不再给 application/json。
      expect(read.contentType).toBe("application/octet-stream");

      // 对照：文本读回在同一文件上的确会损坏（这是二进制读回存在的理由）。
      const text = await store.readToolResultArtifact({ uri: written.uri });
      expect(text.contentType).toBe("application/octet-stream");
      expect(text.content).toBe(Buffer.from(xlsxLikeBytes).toString("base64"));

      // 同一会话目录下不存在的 artifactId：定位失败要报「not found」，不是裸 ENOENT。
      await expect(
        store.readToolResultBinaryArtifact!({
          uri: written.uri.replace(/tool-result-[^/]+$/, "tool-result-missing"),
        }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("primes one derived image path and rebuilds it from the durable data URL artifact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const rootDir = join(tempRoot, "artifacts");
    const imageCacheRootDir = join(tempRoot, "image-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir,
      rootDir,
      videoCacheRootDir: join(tempRoot, "video-cache"),
    });
    const sessionId = createSessionId("artifact-image-cache");
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01]);

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-image"),
        toolName: "prompt-attachment:upload",
        content: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const primePromise = store.primeImageAttachmentPath!({
        bytes: imageBytes,
        mediaType: "image/png",
        uri: artifact.uri,
      });
      const ensurePromise = store.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: artifact.uri,
      });
      expect(ensurePromise).toBe(primePromise);
      const [primed, ensured] = await Promise.all([primePromise, ensurePromise]);
      if (primed.status !== "ready" || ensured.status !== "ready") {
        throw new Error("expected supported PNG image paths");
      }

      expect(dirname(artifact.path!)).toBe(join(rootDir, sessionId));
      expect(dirname(primed.path)).toBe(join(imageCacheRootDir, sessionId));
      expect(primed.path).toBe(ensured.path);
      expect(primed.path).toMatch(/\.png$/);
      await expect(readFile(primed.path)).resolves.toEqual(Buffer.from(imageBytes));
      expect(
        (await readdir(join(imageCacheRootDir, sessionId))).filter((name) => name.endsWith(".png")),
      ).toHaveLength(1);

      await unlink(primed.path);
      const rebuilt = await store.ensureMediaAttachmentPath!({
        mediaType: "image/png",
        uri: artifact.uri,
      });

      expect(rebuilt).toEqual({ status: "ready", path: primed.path });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt PNG image path");
      await expect(readFile(rebuilt.path)).resolves.toEqual(Buffer.from(imageBytes));
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("materializes one video path and rebuilds it from the durable data URL artifact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const rootDir = join(tempRoot, "artifacts");
    const videoCacheRootDir = join(tempRoot, "video-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(tempRoot, "image-cache"),
      rootDir,
      videoCacheRootDir,
    });
    const sessionId = createSessionId("artifact-video-cache");
    const videoBytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-video"),
        toolName: "prompt-attachment:upload",
        content: `data:video/mp4;base64,${Buffer.from(videoBytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const first = store.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: artifact.uri,
      });
      const second = store.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: artifact.uri,
      });
      expect(second).toBe(first);
      const materialized = await first;
      if (materialized.status !== "ready") throw new Error("expected supported MP4 video path");

      expect(dirname(materialized.path)).toBe(join(videoCacheRootDir, sessionId));
      expect(materialized.path).toMatch(/\.mp4$/);
      await expect(readFile(materialized.path)).resolves.toEqual(Buffer.from(videoBytes));

      await unlink(materialized.path);
      const rebuilt = await store.ensureMediaAttachmentPath!({
        mediaType: "video/mp4",
        uri: artifact.uri,
      });

      expect(rebuilt).toEqual({ status: "ready", path: materialized.path });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt MP4 video path");
      await expect(readFile(rebuilt.path)).resolves.toEqual(Buffer.from(videoBytes));
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("materializes one PDF path and rebuilds it from the durable data URL artifact", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const rootDir = join(tempRoot, "artifacts");
    const pdfCacheRootDir = join(tempRoot, "pdf-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(tempRoot, "image-cache"),
      pdfCacheRootDir,
      rootDir,
      videoCacheRootDir: join(tempRoot, "video-cache"),
    });
    const sessionId = createSessionId("artifact-pdf-cache");
    const pdfBytes = Buffer.from("%PDF-1.7\\nbody");

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-pdf"),
        toolName: "prompt-attachment:pdf",
        content: `data:application/pdf;base64,${pdfBytes.toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const first = store.ensureMediaAttachmentPath!({
        mediaType: "application/pdf",
        uri: artifact.uri,
      });
      const second = store.ensureMediaAttachmentPath!({
        mediaType: "application/pdf",
        uri: artifact.uri,
      });
      expect(second).toBe(first);
      const materialized = await first;
      if (materialized.status !== "ready") throw new Error("expected supported PDF path");

      expect(dirname(materialized.path)).toBe(join(pdfCacheRootDir, sessionId));
      expect(materialized.path).toMatch(/\.pdf$/);
      await expect(readFile(materialized.path)).resolves.toEqual(pdfBytes);

      await unlink(materialized.path);
      const rebuilt = await store.ensureMediaAttachmentPath!({
        mediaType: "application/pdf",
        uri: artifact.uri,
      });

      expect(rebuilt).toEqual({ status: "ready", path: materialized.path });
      if (rebuilt.status !== "ready") throw new Error("expected rebuilt PDF path");
      await expect(readFile(rebuilt.path)).resolves.toEqual(pdfBytes);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("skips unsupported image cache media types without interrupting the attachment flow", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const imageCacheRootDir = join(rootDir, "image-cache");
    const store = createNodeToolArtifactStore({
      imageCacheRootDir,
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const sessionId = createSessionId("artifact-unsupported-image-cache");
    const imageBytes = Uint8Array.from([0x42, 0x4d, 0x01, 0x02]);

    try {
      const artifact = await store.writeToolResultArtifact({
        sessionId,
        toolCallId: createToolCallId("prompt-image"),
        toolName: "prompt-attachment:upload",
        content: `data:image/bmp;base64,${Buffer.from(imageBytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });

      const primePromise = store.primeImageAttachmentPath!({
        bytes: imageBytes,
        mediaType: "image/bmp",
        uri: artifact.uri,
      });
      const ensurePromise = store.ensureMediaAttachmentPath!({
        mediaType: "image/bmp",
        uri: artifact.uri,
      });

      expect(ensurePromise).toBe(primePromise);
      await expect(primePromise).resolves.toEqual({ status: "unsupported" });
      await expect(
        store.ensureMediaAttachmentPath!({
          mediaType: "image/bmp",
          uri: artifact.uri,
        }),
      ).resolves.toEqual({ status: "unsupported" });
      await expect(readdir(join(imageCacheRootDir, sessionId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("injects fs faults before binary artifact directory creation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    setStorageFsFaultInjectorForTests(
      createStorageFsFaultInjector([
        {
          id: "D05-artifact-mkdir-eacces",
          code: "EACCES",
          operations: ["mkdir"],
          pathIncludes: rootDir,
        },
      ]),
    );

    try {
      await expect(
        store.writeToolResultBinaryArtifact!({
          sessionId: createSessionId("artifact-session"),
          toolCallId: createToolCallId("artifact-call"),
          toolName: "McpScreenshot",
          content: pngBytes,
          contentType: "image/png",
          extension: ".png",
          retention: "session",
        }),
      ).rejects.toMatchObject({
        code: "EACCES",
        syscall: "mkdir",
        zcodeFsFaultId: "D05-artifact-mkdir-eacces",
      });

      await expect(readdir(rootDir)).resolves.toEqual([]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("具名二进制落盘保留中文空格原名、隔离同名冲突并在写入失败时清理目录", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-tool-artifacts-named-"));
    const store = createNodeToolArtifactStore({
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    });
    const sessionId = createSessionId("named-session");

    try {
      const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
      const docx = await store.writeToolResultBinaryArtifact!({
        sessionId,
        toolCallId: createToolCallId("upload-1"),
        toolName: "prompt-attachment:file",
        content: docxBytes,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "日本文学史 复习资料 (期末).docx",
        retention: "session",
      });
      expect(basename(docx.path!)).toBe("日本文学史 复习资料 (期末).docx");
      expect(docx.path!).toBe(join(rootDir, sessionId, docx.id, "日本文学史 复习资料 (期末).docx"));
      expect(docx.uri).toBe(`zcode-artifact://${sessionId}/${docx.id}`);
      expect((await store.statToolResultArtifact!({ uri: docx.uri })).bytes).toBe(
        docxBytes.byteLength,
      );
      expect(
        Buffer.from((await store.readToolResultBinaryArtifact!({ uri: docx.uri })).bytes),
      ).toEqual(docxBytes);

      // 同名不同内容不覆盖
      const firstReport = await store.writeToolResultBinaryArtifact!({
        sessionId,
        toolCallId: createToolCallId("upload-r1"),
        toolName: "prompt-attachment:file",
        content: Buffer.from("报告版本 A", "utf8"),
        contentType: "text/plain",
        fileName: "报告.txt",
        retention: "session",
      });
      const secondReport = await store.writeToolResultBinaryArtifact!({
        sessionId,
        toolCallId: createToolCallId("upload-r2"),
        toolName: "prompt-attachment:file",
        content: Buffer.from("报告版本 B", "utf8"),
        contentType: "text/plain",
        fileName: "报告.txt",
        retention: "session",
      });
      expect(firstReport.path).not.toBe(secondReport.path);
      expect((await store.readToolResultArtifact({ uri: firstReport.uri })).content).toBe(
        "报告版本 A",
      );
      expect((await store.readToolResultArtifact({ uri: secondReport.uri })).content).toBe(
        "报告版本 B",
      );

      // 恶意路径与多字节超长名安全清洗
      const traversal = await store.writeToolResultBinaryArtifact!({
        sessionId,
        toolCallId: createToolCallId("upload-evil"),
        toolName: "prompt-attachment:file",
        content: Buffer.from("evil"),
        contentType: "application/octet-stream",
        fileName: "../../etc/passwd",
        retention: "session",
      });
      expect(traversal.path!).toBe(join(rootDir, sessionId, traversal.id, "passwd"));

      const winDrive = await store.writeToolResultBinaryArtifact!({
        sessionId,
        toolCallId: createToolCallId("upload-win"),
        toolName: "prompt-attachment:file",
        content: Buffer.from([0x50, 0x4b]),
        contentType: "application/zip",
        fileName: "C:\\temp\\evil.zip",
        retention: "session",
      });
      expect(winDrive.path!).toBe(join(rootDir, sessionId, winDrive.id, "evil.zip"));

      // 符号链接子目录不可跟随读取
      const outsideFile = join(rootDir, "outside.txt");
      await writeFile(outsideFile, "secret");
      await symlink(outsideFile, join(rootDir, sessionId, "tool-result-symlink-dir"));
      await expect(
        store.readToolResultArtifact({
          uri: `zcode-artifact://${sessionId}/tool-result-symlink-dir`,
        }),
      ).rejects.toThrow(/not found/);

      // 写入失败或 rename 发布失败时清理同级暂存目录，不留脏文件或空目录
      const entriesBeforeFail = await readdir(join(rootDir, sessionId));
      setStorageFsFaultInjectorForTests(
        createStorageFsFaultInjector([
          {
            id: "named-write-enospc",
            code: "ENOSPC",
            operations: ["writeFile"],
            pathIncludes: ".zcode-staging-",
          },
        ]),
      );
      await expect(
        store.writeToolResultBinaryArtifact!({
          sessionId,
          toolCallId: createToolCallId("upload-fail"),
          toolName: "prompt-attachment:file",
          content: Buffer.from("boom"),
          contentType: "text/plain",
          fileName: "fail.txt",
          retention: "session",
        }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
      expect(await readdir(join(rootDir, sessionId))).toEqual(entriesBeforeFail);

      setStorageFsFaultInjectorForTests(
        createStorageFsFaultInjector([
          {
            id: "named-rename-eprem",
            code: "EPERM",
            operations: ["rename"],
            pathEndsWith: "/fail-rename.txt",
          },
        ]),
      );
      await expect(
        store.writeToolResultBinaryArtifact!({
          sessionId,
          toolCallId: createToolCallId("upload-fail-rename"),
          toolName: "prompt-attachment:file",
          content: Buffer.from("boom"),
          contentType: "text/plain",
          fileName: "fail-rename.txt",
          retention: "session",
        }),
      ).rejects.toMatchObject({ code: "EPERM" });
      expect(await readdir(join(rootDir, sessionId))).toEqual(entriesBeforeFail);

      // 具名子目录含多个文件、子目录或符号链接条目时必须明确报错（不静默返回任意文件）
      const multiDir = join(rootDir, sessionId, "tool-result-multi");
      await mkdir(multiDir, { recursive: true });
      await writeFile(join(multiDir, "a.txt"), "A");
      await writeFile(join(multiDir, "b.txt"), "B");
      await expect(
        store.readToolResultArtifact({ uri: `zcode-artifact://${sessionId}/tool-result-multi` }),
      ).rejects.toThrow(/Ambiguous/);

      const nestedDir = join(rootDir, sessionId, "tool-result-nested");
      await mkdir(join(nestedDir, "inner"), { recursive: true });
      await writeFile(join(nestedDir, "ok.txt"), "ok");
      await expect(
        store.readToolResultArtifact({ uri: `zcode-artifact://${sessionId}/tool-result-nested` }),
      ).rejects.toThrow(/Invalid/);

      // 上传名为 .zcode-tmp-report.txt 的合法文件必须完整 write -> read -> stat 往返
      const tmpNamed = await store.writeToolResultBinaryArtifact!({
        sessionId,
        toolCallId: createToolCallId("upload-tmp-name"),
        toolName: "prompt-attachment:file",
        content: Buffer.from("TMP_NAME_REPORT", "utf8"),
        contentType: "text/plain",
        fileName: ".zcode-tmp-report.txt",
        retention: "session",
      });
      expect(basename(tmpNamed.path!)).toBe(".zcode-tmp-report.txt");
      expect((await store.readToolResultArtifact({ uri: tmpNamed.uri })).content).toBe(
        "TMP_NAME_REPORT",
      );
      expect((await store.statToolResultArtifact!({ uri: tmpNamed.uri })).path).toBe(tmpNamed.path);

      // sessionDir 为符号链接时，读取与写入（具名 + 平铺）均拒绝，且不在链接指向的外部目录创建任何文件
      const symlinkSessionDir = join(rootDir, "symlink-session");
      const externalDir = await mkdtemp(join(tmpdir(), "zcode-outside-session-"));
      try {
        await writeFile(join(externalDir, "tool-result-ext.txt"), "SECRET");
        await symlink(externalDir, symlinkSessionDir);
        await expect(
          store.readToolResultArtifact({ uri: "zcode-artifact://symlink-session/tool-result-ext" }),
        ).rejects.toThrow(/not found/);
        await expect(
          store.writeToolResultBinaryArtifact!({
            sessionId: "symlink-session" as SessionId,
            toolCallId: createToolCallId("sym-named"),
            toolName: "prompt-attachment:file",
            content: Buffer.from("nope"),
            contentType: "text/plain",
            fileName: "evil.txt",
            retention: "session",
          }),
        ).rejects.toThrow(/Unsafe tool artifact session directory/);
        await expect(
          store.writeToolResultBinaryArtifact!({
            sessionId: "symlink-session" as SessionId,
            toolCallId: createToolCallId("sym-flat-bin"),
            toolName: "prompt-attachment:file",
            content: Buffer.from("nope"),
            contentType: "application/octet-stream",
            retention: "session",
          }),
        ).rejects.toThrow(/Unsafe tool artifact session directory/);
        await expect(
          store.writeToolResultArtifact({
            sessionId: "symlink-session" as SessionId,
            toolCallId: createToolCallId("sym-flat-text"),
            toolName: "BigTool",
            content: "nope",
            contentType: "text/plain",
            retention: "session",
          }),
        ).rejects.toThrow(/Unsafe tool artifact session directory/);
        expect(await readdir(externalDir)).toEqual(["tool-result-ext.txt"]);
      } finally {
        await rm(externalDir, { force: true, recursive: true });
      }

      // ".." sessionId 被 sanitizePathSegment 隔离到 rootDir 内，不逃出根目录
      const dotDotWritten = await store.writeToolResultBinaryArtifact!({
        sessionId: ".." as SessionId,
        toolCallId: createToolCallId("dotdot"),
        toolName: "prompt-attachment:file",
        content: Buffer.from("safe"),
        contentType: "text/plain",
        fileName: "safe.txt",
        retention: "session",
      });
      expect(dotDotWritten.path!.startsWith(join(rootDir, "unknown"))).toBe(true);

      // 旧平铺回退匹配按严格 artifactId 边界，不误匹配 prefix-10
      await writeFile(join(rootDir, sessionId, "call-tool-result-10.txt"), "TEN");
      await expect(
        store.readToolResultArtifact({ uri: `zcode-artifact://${sessionId}/tool-result-1` }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("sanitizeArtifactFileName 清洗控制字符、超长多字节名与 Windows 保留字", () => {
    expect(sanitizeArtifactFileName("../../etc/passwd", ".bin", "linux")).toBe("passwd");
    expect(sanitizeArtifactFileName("C:\\temp\\evil.zip", ".bin", "linux")).toBe("evil.zip");
    expect(sanitizeArtifactFileName("a\x00b\x1fc\u0085d.txt", ".txt", "linux")).toBe("a_b_c_d.txt");
    expect(sanitizeArtifactFileName("..", ".bin", "linux")).toBe("attachment.bin");
    expect(sanitizeArtifactFileName(".", ".txt", "linux")).toBe("attachment.txt");
    expect(sanitizeArtifactFileName("", ".pdf", "linux")).toBe("attachment.pdf");
    expect(sanitizeArtifactFileName("CON.txt", ".txt", "win32")).toBe("_CON.txt");
    expect(sanitizeArtifactFileName("a<b:c>?.txt. ", ".txt", "win32")).toBe("a_b_c__.txt");

    const longChinese = `${"测".repeat(100)}.docx`;
    const truncated = sanitizeArtifactFileName(longChinese, ".bin", "linux");
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(240);
    expect(truncated.endsWith(".docx")).toBe(true);
    // 确保按 Unicode 码点截断不产生孤立代理或替换字符
    expect(Buffer.from(truncated, "utf8").toString("utf8")).toBe(truncated);
  });
});
