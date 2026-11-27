import { basename } from "../deps.js";
import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";
import { inferVideoMimeFromPath } from "./attachment-video.js";

type PathReferenceReason =
  | "binary_file"
  | "deferred_clipboard_text"
  | "deferred_topic_history"
  | "image_too_large"
  | "pdf_too_large"
  | "text_too_large"
  | "video_too_large";

export function resolvedInlineTextAttachment(
  attachment: TurnAttachment,
  index: number,
): ResolvedTurnAttachment {
  const content = attachment.content ?? "";
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return {
    contentBlock: { type: "text", text: content },
    filename: attachment.path ? basename(attachment.path) : undefined,
    metadata: {
      originalUrl: safeAttachmentOriginalRef(attachment),
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: "text/plain",
    url: placeholder,
  };
}

export function resolvedPathReferenceAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  options: {
    artifactUri?: string;
    filename?: string;
    mime?: string;
    originalUrl?: string;
    reason: PathReferenceReason;
    sizeBytes?: number;
    source?: FilePartSource;
    url?: string;
  },
): ResolvedTurnAttachment {
  const mime =
    options.mime ?? (attachment.type === "image" ? "image/*" : "application/octet-stream");
  const content = [
    `Attached ${mime}: ${placeholder}`,
    `The file was sent by local path because ${formatPathReferenceReason(options.reason)}.`,
    "Use the available file reading tools if you need to inspect the file contents.",
  ].join("\n");
  return {
    contentBlock: { type: "text", text: content },
    filename: options.filename,
    metadata: {
      ...(options.artifactUri ? { artifactUri: options.artifactUri } : {}),
      originalUrl: options.originalUrl ?? safeAttachmentOriginalRef(attachment),
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: "local_ref",
      // 原说明只存在于 contentBlock 时，冷恢复会丢失降级原因和读取提示，改变模型历史前缀。
      pathReferenceText: content,
    },
    mime,
    source: options.source,
    url: options.url ?? attachment.path ?? attachment.content ?? "",
  };
}

export function isDataOrArtifactUrl(content: string): boolean {
  return content.startsWith("data:") || content.startsWith("zcode-artifact://");
}

const EXPLICIT_BINARY_EXTENSION_PATTERN =
  /\.(7z|a|aac|apk|avi|bin|bz2|class|db|dll|docx|dylib|exe|flac|gif|gz|ico|jar|jpeg|jpg|lib|m4v|mkv|mov|mp3|mp4|o|ogg|otf|pdf|png|pptx|pyc|rar|so|sqlite|tar|tgz|ttf|wasm|wav|webm|webp|woff|woff2|xlsx|xz|zip)$/iu;

const TEXT_LIKE_EXTENSION_PATTERN =
  /\.(astro|bash|bat|c|cc|cjs|cmd|conf|cpp|cs|css|csv|cxx|env|fish|go|gql|graphql|h|hpp|htm|html|ini|java|js|json|json5|jsonc|jsx|kt|kts|less|log|md|mdx|mjs|php|proto|ps1|py|rb|rs|scss|sh|sql|svelte|svg|swift|toml|ts|tsx|tsv|txt|vue|xml|yaml|yml|zsh)$/iu;

const SAFE_TEXT_MIMES = new Set([
  "application/ecmascript",
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-javascript",
  "application/x-sh",
  "application/x-typescript",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
]);

export function isExplicitBinaryPath(path: string): boolean {
  return EXPLICIT_BINARY_EXTENSION_PATTERN.test(path);
}

export function isTextLikePath(path: string): boolean {
  if (isExplicitBinaryPath(path)) return false;
  return TEXT_LIKE_EXTENSION_PATTERN.test(path) || /(?:^|[/\\])\.env(?:\.[^./\\]+)?$/iu.test(path);
}

function hasFileExtension(filename: string): boolean {
  const base = basename(filename);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 && dotIndex < base.length - 1;
}

/**
 * 判断上传普通文件是否具备正面文本类型依据：
 * 1. 显式二进制扩展名（.zip/.docx/.exe 等）一律排除；
 * 2. 命中 isTextLikePath 的常见源码/配置扩展名直接认可；
 * 3. 仅有未知扩展名时不轻信宽泛 MIME；仅当无扩展名时才认可显式安全文本 MIME。
 */
export function hasPositiveTextAttachmentType(
  filename: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (filename) {
    if (isExplicitBinaryPath(filename)) return false;
    if (isTextLikePath(filename)) return true;
    if (hasFileExtension(filename)) return false;
  }
  const normalizedMime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!normalizedMime || normalizedMime === "application/octet-stream") return false;
  return (
    normalizedMime.startsWith("text/") ||
    SAFE_TEXT_MIMES.has(normalizedMime) ||
    normalizedMime.endsWith("+json") ||
    normalizedMime.endsWith("+xml")
  );
}

export function inferAttachmentMimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "pdf") return "application/pdf";
  if (extension === "json") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "md") return "text/markdown";
  // video 扩展名映射复用 attachment-video 的唯一事实源，避免两处维护同一张表。
  const videoMime = inferVideoMimeFromPath(path);
  if (videoMime) return videoMime;
  return isTextLikePath(path) ? "text/plain" : "application/octet-stream";
}

function formatPathReferenceReason(reason: PathReferenceReason): string {
  if (reason === "deferred_topic_history") return "topic history is provided for on-demand reading";
  if (reason === "deferred_clipboard_text") {
    return "it is a pasted-text temporary attachment that is deferred to keep the model context small";
  }
  if (reason === "image_too_large") return "the image is larger than the inline media budget";
  if (reason === "pdf_too_large") return "the PDF is larger than the inline PDF input limit";
  if (reason === "text_too_large") return "the text file is larger than the inline text budget";
  if (reason === "video_too_large") return "the video is larger than the ZCode video input limit";
  return "the file is not a known text attachment";
}
