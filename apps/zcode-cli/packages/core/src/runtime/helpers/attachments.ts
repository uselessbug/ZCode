import { basename, resolvePath } from "../deps.js";
import { READ_DEFAULT_MAX_LINES, READ_MAX_FILE_SIZE_BYTES } from "@zcode/contracts";
import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnAttachmentMeta,
  TurnState,
  TurnId,
} from "../deps.js";
import { readTextFileForModel } from "../../tool/handlers/read-text.js";
import { INLINE_TEXT_ATTACHMENT_MAX_BYTES, type ResolvedTurnAttachment } from "../types.js";
import { readInlineAttachmentContent } from "./attachment-artifacts.js";
import { isStrictBase64Payload, parseDataUrlHeader } from "./attachment-data-url.js";
import {
  resolveInlineMediaAttachment,
  resolveLocalMediaAttachment,
} from "./attachment-media-resolver.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath } from "./attachment-image.js";
import {
  hasPositiveTextAttachmentType,
  inferAttachmentMimeFromPath,
  isDataOrArtifactUrl,
  isTextLikePath,
  resolvedInlineTextAttachment,
  resolvedPathReferenceAttachment,
} from "./attachment-path-reference.js";

type ResolveAttachmentOptions = {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
};

/**
 * 附件 → TurnStarted 事件的轻量展示元信息（TurnAttachmentMeta）。
 * 在 resolve/persist 之前即可用（TurnStarted 先于 resolveTurnAttachments 发出），
 * 因此只做无 IO 推断：filename/mimeType/sizeBytes 优先取协议边界透传值，
 * 缺省按 path basename / 扩展名 / data URL 头 / content 长度兜底。
 */
export function summarizeTurnAttachmentsForEvent(
  attachments: TurnState["attachments"],
): TurnAttachmentMeta[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => {
    const path = attachment.path;
    const fileName =
      attachment.filename ?? (path ? basename(path) : undefined) ?? `attachment-${index + 1}`;
    const dataUrlMime =
      attachment.content !== undefined
        ? parseDataUrlHeader(attachment.content)?.mediaType
        : undefined;
    const mime =
      attachment.mimeType ??
      dataUrlMime ??
      (attachment.type === "url"
        ? "text/uri-list"
        : path
          ? attachment.type === "image"
            ? inferImageMimeFromPath(path)
            : inferAttachmentMimeFromPath(path)
          : "application/octet-stream");
    const bytes =
      attachment.sizeBytes ??
      (attachment.content !== undefined ? Buffer.byteLength(attachment.content, "utf8") : 0);
    // data URL/inline 内容无稳定引用；路径/URL 作为展示层引用。
    const ref =
      path && !isDataOrArtifactUrl(path)
        ? path
        : attachment.type === "url"
          ? (attachment.content ?? path)
          : undefined;
    return { fileName, mime, bytes, ...(ref ? { ref } : {}) };
  });
}

export async function resolveTurnAttachments(
  attachments: TurnState["attachments"],
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment[]> {
  const resolved: ResolvedTurnAttachment[] = [];
  for (const [index, attachment] of (attachments ?? []).entries()) {
    resolved.push(await resolveTurnAttachment(attachment, index, options));
  }
  return resolved;
}

async function resolveTurnAttachment(
  attachment: TurnAttachment,
  index: number,
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment> {
  if (attachment.type === "url") {
    const uri = attachment.content ?? attachment.path ?? `attachment-${index + 1}`;
    return {
      contentBlock: { type: "resource_link", uri },
      metadata: {
        originalUrl: uri,
        recoverability: "metadata_only",
        storageKind: "remote_ref",
      },
      mime: "text/uri-list",
      url: uri,
    };
  }

  if (
    attachment.content &&
    (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text")
  ) {
    // 上传后的文本材料在所属 runtime 落盘，禁止解码后当正文注入，也不使用 Host 本机路径。
    const inline = await readInlineAttachmentContent(attachment, options);
    const write = options.artifactStore?.writeToolResultBinaryArtifact?.bind(options.artifactStore);
    if (!inline || !write || !options.sessionId)
      throw new Error("Text attachment materialization unavailable");
    const encoded = /^data:text\/plain(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      inline.dataUrl,
    );
    if (!encoded) throw new Error("Invalid text attachment encoding");
    const data = Buffer.from(encoded[1]!, "base64");
    const file = await write(
      {
        sessionId: options.sessionId,
        turnId: options.turnId,
        trace: options.traceContext,
        toolCallId: `text-attachment-${index}`,
        toolName: "prompt-attachment:text",
        content: data,
        contentType: "text/plain",
        extension: "txt",
        retention: "session",
      },
      { signal: options.abortSignal },
    );
    if (!file.path) throw new Error("Text attachment path unavailable");
    const source: FilePartSource = {
      type: "file",
      path: file.path,
      text: { value: file.path, start: 0, end: file.path.length },
    };
    // 修复原因：原分支只传本地磁盘 path，丢失了新原始字节文件的 file.uri 与原上传
    // inline.artifactUri，导致 fork 后 SqliteSessionStore.listArtifactReferrers 扫不到引用，
    // 源会话 purge 时误删仍被 fork 会话引用的原始文件。
    return resolvedPathReferenceAttachment(attachment, file.path, {
      ...(inline.artifactUri ? { artifactUri: inline.artifactUri } : {}),
      filename: attachment.filename,
      mime: "text/plain",
      ...(inline.artifactUri ? { originalUrl: inline.artifactUri } : {}),
      sizeBytes: data.length,
      source,
      url: file.uri ?? inline.artifactUri ?? file.path,
      reason:
        attachment.sourceKind === "topic-history"
          ? "deferred_topic_history"
          : "deferred_clipboard_text",
    });
  }
  if (attachment.content) {
    if (attachment.type === "pdf" && !isDataOrArtifactUrl(attachment.content)) {
      // PDF 曾沿用普通 file 的 inline 文本分支，损坏或伪造的正文会被 UTF-8
      // 解码后送进 provider；PDF 必须只接受 data URL 或 artifact URI，并在请求前明确降级。
      return resolvedPlaceholderAttachment(
        attachment,
        attachment.path ?? `attachment-${index + 1}`,
        "attachment_pdf_invalid",
        {
          filename: attachment.filename,
          mime: "application/pdf",
          sizeBytes: attachment.sizeBytes,
        },
      );
    }
    if (attachment.type === "file" && attachment.content.startsWith("zcode-artifact://")) {
      // 修复原因：普通上传文件曾落入通用 resolvedInlineAttachment fallback，把整段 data:...base64
      // 原串当作文本注入 prompt；这里在 fallback 前按真实解码字节分流为安全小文本内联或落盘 local_ref。
      return await resolveUploadedFileArtifactAttachment(attachment, index, options);
    }
    if (attachment.type !== "image" && !isDataOrArtifactUrl(attachment.content)) {
      return resolvedInlineTextAttachment(attachment, index);
    }

    const inline = await readInlineAttachmentContent(attachment, options);
    if (!inline) {
      const placeholder = attachment.path ?? `attachment-${index + 1}`;
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
    }
    return await resolvedInlineAttachment({ ...attachment, content: inline.dataUrl }, index, {
      ...options,
      existingArtifactUri: inline.artifactUri,
    });
  }

  const fileSystemPort = options.fileSystemPort;
  if (attachment.path && fileSystemPort) {
    if (attachment.type === "image" || attachment.type === "video" || attachment.type === "pdf") {
      return await resolveLocalMediaAttachment(attachment, index, {
        ...options,
        fileSystemPort,
      });
    }
    return await resolveLocalFileAttachment(attachment, {
      ...options,
      fileSystemPort,
    });
  }

  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
}

const VALID_MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

function decodeUploadedFileDataUrl(
  content: string,
  fallbackMime: string,
): { bytes: Buffer; mediaType: string } | undefined {
  const commaIndex = content.indexOf(",");
  if (content.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = content.slice("data:".length, commaIndex).split(";");
  const rawMediaType = headerParts.shift()?.trim().toLowerCase() ?? "";
  const mediaType = rawMediaType || fallbackMime;
  if (!VALID_MIME_TYPE_PATTERN.test(mediaType)) {
    return undefined;
  }
  const payload = content.slice(commaIndex + 1);
  const isBase64 = headerParts.at(-1)?.trim().toLowerCase() === "base64";
  if (isBase64) {
    if (!isStrictBase64Payload(payload)) return undefined;
    return { bytes: Buffer.from(payload, "base64"), mediaType };
  }
  try {
    return { bytes: Buffer.from(decodeURIComponent(payload), "utf8"), mediaType };
  } catch {
    return undefined;
  }
}

function hasDisallowedControlBytes(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return true;
    }
  }
  return false;
}

function decodeSafeUtf8Text(bytes: Uint8Array): string | undefined {
  if (hasDisallowedControlBytes(bytes)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function normalizedFileExtension(filename: string | undefined): string {
  if (!filename) return ".bin";
  const base = basename(filename);
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === base.length - 1) return ".bin";
  const sanitized = base
    .slice(dotIndex + 1)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 15)
    .toLowerCase();
  return sanitized.length > 0 ? `.${sanitized}` : ".bin";
}

async function resolveUploadedFileArtifactAttachment(
  attachment: TurnAttachment,
  index: number,
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment> {
  const placeholder = attachment.path ?? attachment.filename ?? `attachment-${index + 1}`;
  const fallbackMime =
    attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";

  if (!options.artifactStore || !attachment.content) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed", {
      filename: attachment.filename,
      mime: fallbackMime,
    });
  }

  let artifactContent: string;
  try {
    const artifact = await options.artifactStore.readToolResultArtifact(
      {
        trace: options.traceContext,
        uri: attachment.content,
      },
      { signal: options.abortSignal },
    );
    artifactContent = artifact.content;
  } catch {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed", {
      filename: attachment.filename,
      mime: fallbackMime,
    });
  }

  const decoded = decodeUploadedFileDataUrl(artifactContent, fallbackMime);
  if (!decoded) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed", {
      filename: attachment.filename,
      mime: fallbackMime,
    });
  }

  const { bytes, mediaType } = decoded;
  const hasPositiveTextType = hasPositiveTextAttachmentType(attachment.filename, mediaType);
  const decodedText = hasPositiveTextType ? decodeSafeUtf8Text(bytes) : undefined;

  if (decodedText !== undefined && bytes.byteLength <= INLINE_TEXT_ATTACHMENT_MAX_BYTES) {
    const resolvedTextMime =
      mediaType !== "application/octet-stream"
        ? mediaType
        : attachment.filename
          ? inferAttachmentMimeFromPath(attachment.filename)
          : "text/plain";
    return {
      contentBlock: { type: "text", text: decodedText },
      filename: attachment.filename,
      metadata: {
        artifactUri: attachment.content,
        originalUrl: attachment.content,
        preview: {
          text: decodedText,
          truncated: false,
          originalBytes: bytes.byteLength,
        },
        recoverability: "provider_ready",
        sizeBytes: bytes.byteLength,
        storageKind: "inline",
      },
      mime: resolvedTextMime,
      url: attachment.content,
    };
  }

  const reason =
    decodedText !== undefined && bytes.byteLength > INLINE_TEXT_ATTACHMENT_MAX_BYTES
      ? "text_too_large"
      : "binary_file";
  const resolvedBinaryMime =
    reason === "text_too_large"
      ? mediaType !== "application/octet-stream"
        ? mediaType
        : attachment.filename
          ? inferAttachmentMimeFromPath(attachment.filename)
          : "text/plain"
      : hasPositiveTextType
        ? "application/octet-stream"
        : mediaType;

  const write = options.artifactStore.writeToolResultBinaryArtifact?.bind(options.artifactStore);
  if (!write || !options.sessionId) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed", {
      filename: attachment.filename,
      mime: resolvedBinaryMime,
      sizeBytes: bytes.byteLength,
    });
  }

  let written: { uri?: string; path?: string };
  try {
    written = await write(
      {
        sessionId: options.sessionId,
        turnId: options.turnId,
        trace: options.traceContext,
        toolCallId: `file-attachment-${index}`,
        toolName: "prompt-attachment:file",
        content: bytes,
        contentType: resolvedBinaryMime,
        extension: normalizedFileExtension(attachment.filename),
        retention: "session",
      },
      { signal: options.abortSignal },
    );
  } catch {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed", {
      filename: attachment.filename,
      mime: resolvedBinaryMime,
      sizeBytes: bytes.byteLength,
    });
  }

  if (!written.path) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed", {
      filename: attachment.filename,
      mime: resolvedBinaryMime,
      sizeBytes: bytes.byteLength,
    });
  }

  const source: FilePartSource = {
    type: "file",
    path: written.path,
    text: { value: written.path, start: 0, end: written.path.length },
  };
  return resolvedPathReferenceAttachment(attachment, written.path, {
    artifactUri: attachment.content,
    filename: attachment.filename,
    mime: resolvedBinaryMime,
    originalUrl: attachment.content,
    reason,
    sizeBytes: bytes.byteLength,
    source,
    url: written.uri ?? attachment.content,
  });
}

async function resolvedInlineAttachment(
  attachment: TurnAttachment,
  index: number,
  options: {
    abortSignal?: AbortSignal;
    artifactStore?: ToolArtifactStorePort;
    existingArtifactUri?: string;
    imageProcessorPort?: ImageProcessorPort;
    sessionId?: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<ResolvedTurnAttachment> {
  const parsed = attachment.content?.startsWith("data:")
    ? parseDataUrlHeader(attachment.content)
    : undefined;
  const media = await resolveInlineMediaAttachment(attachment, index, parsed?.mediaType, options);
  if (media) return media;

  const content = attachment.content ?? "";
  return {
    contentBlock: { type: "text", text: content },
    metadata: {
      originalUrl: attachment.path ?? attachment.content,
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: parsed?.mediaType ?? (attachment.type === "image" ? "image/*" : "text/plain"),
    url: attachment.content ?? "",
  };
}

async function resolveLocalFileAttachment(
  attachment: TurnAttachment,
  options: {
    abortSignal?: AbortSignal;
    fileSystemPort: FileSystemPort;
    traceContext: TraceContext;
    workingDirectory: string;
  },
): Promise<ResolvedTurnAttachment> {
  const absolutePath = resolvePath(options.workingDirectory, attachment.path!);
  const filename = basename(absolutePath);
  const mime = "text/plain";
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachment.path!, start: 0, end: attachment.path!.length },
  };

  try {
    const stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
    if (stat.kind !== "file") {
      return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_not_file", {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
      });
    }

    if (!isTextLikePath(absolutePath)) {
      // 疑似二进制文件不能误当文本读入 prompt，只交付路径引用给后续工具处理。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: inferAttachmentMimeFromPath(absolutePath),
        sizeBytes: stat.sizeBytes,
        source,
        reason: "binary_file",
      });
    }

    if (attachment.sourceKind === "clipboard-text" || attachment.sourceKind === "topic-history") {
      // 长粘贴文本已经落成临时文件，预读会重新把正文塞进 prompt_attachment 系统提示。
      // 这里只交付真实本地附件引用，等模型明确需要时再通过文件读取工具进入上下文。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
        reason:
          attachment.sourceKind === "topic-history"
            ? "deferred_topic_history"
            : "deferred_clipboard_text",
      });
    }

    const isOversizedText = stat.sizeBytes > READ_MAX_FILE_SIZE_BYTES;
    const read = await readTextFileForModel({
      abortSignal: options.abortSignal,
      filePath: absolutePath,
      fileSystemPort: options.fileSystemPort,
      ...(isOversizedText
        ? {
            allowPartialFallback: true,
            limit: READ_DEFAULT_MAX_LINES,
            offset: 1,
          }
        : {}),
      trace: options.traceContext,
    });
    return {
      contentBlock: { type: "text", text: read.content },
      filename,
      metadata: {
        originalUrl: attachment.path,
        preview: {
          text: read.content,
          truncated: read.truncated ?? false,
          ...(read.sizeBytes !== undefined ? { originalBytes: read.sizeBytes } : {}),
          startLine: read.startLine,
          totalLines: read.totalLines,
          ...(read.truncatedByTokenCap !== undefined
            ? { truncatedByTokenCap: read.truncatedByTokenCap }
            : {}),
          ...(read.partialViewNotice !== undefined
            ? { partialViewNotice: read.partialViewNotice }
            : {}),
        },
        recoverability: read.truncated ? "preview_only" : "provider_ready",
        ...(read.sizeBytes !== undefined ? { sizeBytes: read.sizeBytes } : {}),
        storageKind: "inline",
      },
      mime: "text/plain",
      source,
      url: attachment.path!,
    };
  } catch {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_read_failed", {
      filename,
      mime,
      source,
    });
  }
}

export { parseDataUrlHeader } from "./attachment-data-url.js";
export { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
