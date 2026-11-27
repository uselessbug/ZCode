// 附件命令面（UI 侧）：ZCodePromptAttachment（composer 序列化产物）→ AttachmentRef
// （v4 sendText/createSession attachments 引用模型）；同文件还收口上传失败的自动重试资格与本地化文案。
//
// 分派规则（与 CLI attachment-refs.ts 的映射对偶）：
// - localPath（desktop 主流：native picker / 拖拽 getPathForFile / 长粘贴临时文件 /
//   oversized 大图路径降级）→ ref 直接携带绝对路径，零上传；
// - dataBase64（粘贴截图、独立 Web 的普通文件真实字节等）→ 高层 put（内部 begin/chunk/commit）→
//   artifact ref；普通文件（kind=file）允许 dataBase64 为空串（0 字节文件），媒体空串仍视为无内容；
// - textContent（服务端 topic-history 与旧草稿兼容，renderer 新建的普通文件不再产生）→ 编码后同走 put；
// - 三者皆无（元信息-only）→ 丢弃并告警（无内容可发，不伪造引用）。
import type { ZCodePromptAttachment } from "@zcode/shared";
import type {
  AttachmentRef,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  MissingInlinePdfContentError,
  OversizedInlineFileAttachmentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
  formatAttachmentSize,
} from "@/lib/chatAttachments.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export type AttachmentPutFn = (
  params: V4AttachmentPutParams,
  options?: AttachmentUploadOptions,
) => Promise<V4AttachmentPutResult>;

function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/**
 * 取得待上传的 base64。0 字节普通文件的 base64 为空串，仍是合法内容；
 * 媒体（image/video/pdf）空串沿用“无内容”语义。null = 无内容可发。
 */
function resolveUploadBase64(attachment: ZCodePromptAttachment): string | null {
  if ("dataBase64" in attachment && typeof attachment.dataBase64 === "string") {
    if (attachment.dataBase64 !== "" || attachment.kind === "file") return attachment.dataBase64;
  }
  if ("textContent" in attachment && attachment.textContent !== undefined) {
    return encodeTextToBase64(attachment.textContent);
  }
  return null;
}

/** 单个附件 → AttachmentRef（需要上传时经 chunk transaction）。返回 null = 无内容可发（丢弃）。 */
export async function uploadComposerAttachment(
  put: AttachmentPutFn,
  sessionId: string,
  attachment: ZCodePromptAttachment,
  options?: AttachmentUploadOptions,
): Promise<AttachmentRef | null> {
  const fileName = attachment.filename;
  const mime = attachment.mimeType;
  const source =
    attachment.kind === "file" && attachment.sourceKind
      ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
      : {};
  // audio 变体无 sizeBytes 字段；统一经窄化读取。
  const sizeBytes =
    "sizeBytes" in attachment && typeof attachment.sizeBytes === "number"
      ? attachment.sizeBytes
      : undefined;
  if (attachment.localPath) {
    return {
      ...source,
      ref: attachment.localPath,
      fileName,
      mime,
      bytes: sizeBytes ?? 0,
    };
  }
  const dataBase64 = resolveUploadBase64(attachment);
  if (dataBase64 === null) {
    logger.warn(
      `[v4-composer] 附件无内容可发（无 localPath/dataBase64/textContent），已丢弃: ${fileName}`,
    );
    return null;
  }
  const { ref } = await put({ sessionId, fileName, mime, dataBase64 }, options);
  return {
    ...source,
    ref,
    fileName,
    mime,
    // 以实际上传内容的字节数为准，避免 sizeBytes 元信息与真实上传字节不一致。
    bytes: base64ByteLength(dataBase64),
  };
}

/**
 * 附件数组 → AttachmentRef[]（顺序保持）。put 失败原样抛出（调用方中止发送，草稿保留）。
 */
export async function uploadComposerAttachments(
  put: AttachmentPutFn,
  sessionId: string,
  attachments: readonly ZCodePromptAttachment[],
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const attachment of attachments) {
    const ref = await uploadComposerAttachment(put, sessionId, attachment);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

// ── 上传错误：自动重试资格与本地化文案的唯一来源 ──
// 纯判定函数放在命令面同文件，hook 只负责调度；隔离回归直接加载这里验证。

export const REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE = "remoteAttachmentNotStaged";

type OversizedInlineAttachmentError =
  | OversizedInlineFileAttachmentError
  | OversizedInlineImageAttachmentError
  | OversizedInlinePdfAttachmentError
  | OversizedInlineVideoAttachmentError;

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Error && error.cause !== undefined ? isAbortError(error.cause) : false;
}

/** 结构化超限错误 → 对应的本地化文案 id；非超限错误返回 null。 */
function resolveOversizedInlineAttachment(
  error: unknown,
): { error: OversizedInlineAttachmentError; messageId: string } | null {
  if (error instanceof OversizedInlineImageAttachmentError) {
    return { error, messageId: "chat.attachments.oversizedInlineImage" };
  }
  if (error instanceof OversizedInlineVideoAttachmentError) {
    return { error, messageId: "chat.attachments.oversizedInlineVideo" };
  }
  if (error instanceof OversizedInlinePdfAttachmentError) {
    return { error, messageId: "chat.attachments.oversizedInlinePdf" };
  }
  if (error instanceof OversizedInlineFileAttachmentError) {
    return { error, messageId: "chat.attachments.oversizedInlineFile" };
  }
  return null;
}

export function isTransientAttachmentUploadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  // 超限是确定性的本地校验失败，自动重试只会重复同一错误。
  if (resolveOversizedInlineAttachment(error) !== null) return false;
  if (error instanceof MissingInlinePdfContentError) return false;
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  // 超限错误已在上方按类型精确拦截，避免扩大 message 正则后改变其他错误的既有判定。
  return !/(?:payloadTooLarge|invalidBase64|invalidServerProgress|frameTooLarge|permission|EACCES|ENOENT|not found|unsupported|附件缺少|缺少可读取内容|远端附件未完成物化)/iu.test(
    message,
  );
}

/** 上传失败 → 用户可见文案：结构化错误按当前 locale 格式化，其余沿用 message。 */
export function formatAttachmentUploadError(
  intl: Pick<IntlInstance, "formatMessage">,
  error: unknown,
): string {
  const oversized = resolveOversizedInlineAttachment(error);
  if (oversized !== null) {
    return intl.formatMessage(
      { id: oversized.messageId },
      {
        filename: oversized.error.filename,
        size: formatAttachmentSize(oversized.error.sizeBytes),
        maxSize: formatAttachmentSize(oversized.error.maxSizeBytes),
      },
    );
  }
  if (error instanceof MissingInlinePdfContentError) {
    return intl.formatMessage(
      { id: "chat.attachments.missingInlinePdfContent" },
      { filename: error.filename },
    );
  }
  return error instanceof Error ? error.message : String(error);
}
