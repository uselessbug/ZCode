import type {
  WebPushConfigResponse,
  WebPushEventKind,
  WebPushSubscribeRequest,
  WebPushSubscribeResponse,
  WebPushUnsubscribeResponse,
} from "@zcode/shared/web-push";
import { createServiceDescriptor } from "../descriptors.js";

export class WebPushValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPushValidationError";
  }
}

export interface WebPushOutboundRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  timeoutMs: number;
}

export interface WebPushOutboundResponse {
  status: number;
}

export type WebPushSendImpl = (request: WebPushOutboundRequest) => Promise<WebPushOutboundResponse>;

export interface CreateWebPushServiceOptions {
  /** Override storage directory (defaults to `<appConfigDir>/web-push`). */
  storageDir?: string;
  /** Override VAPID subject (defaults to `ZCODE_WEB_PUSH_SUBJECT` or `mailto:noreply@zcode.local`). */
  subject?: string;
  /** Allow loopback `http://127.0.0.1` / `localhost` / `[::1]` endpoints (for local tests only). */
  allowLoopbackEndpoint?: boolean;
  /** Injectable outbound transport (defaults to DNS-checked HTTPS transport with private IP block). */
  sendImpl?: WebPushSendImpl;
  /** Request timeout in milliseconds (defaults to 10_000). */
  requestTimeoutMs?: number;
  /** Clock provider in ms (defaults to `Date.now`). */
  now?: () => number;
}

export interface WebPushSessionEventInput {
  kind: Extract<
    WebPushEventKind,
    "task_completed" | "task_failed" | "approval" | "question" | "plan"
  >;
  eventId: string;
  sessionId: string;
  sessionTitle?: string;
  detail?: string;
  interactionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  occurredAt?: number;
  /** 当调用方已同步消费过自动化回合归属时置为 true，避免异步回调时误消费后续新 run。 */
  skipAutomationTurnCheck?: boolean;
}

export interface WebPushAutomationEventInput {
  kind: Extract<WebPushEventKind, "automation_completed" | "automation_failed">;
  runId: string;
  automationTitle?: string;
  detail?: string;
  sessionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  occurredAt?: number;
}

export interface IWebPushService {
  /** 读取当前服务启用状态与 VAPID 公钥（base64url 未压缩 P-256 公钥）。幂等只读。 */
  getConfig(): Promise<WebPushConfigResponse>;

  /** 校验并持久化设备订阅（按 endpoint 幂等覆盖更新公钥、locale、soundEnabled 与活跃时间）。 */
  upsertSubscription(request: WebPushSubscribeRequest): Promise<WebPushSubscribeResponse>;

  /** 按 endpoint 删除设备订阅；不存在时返回 removed=false，幂等。 */
  removeSubscription(endpoint: string): Promise<WebPushUnsubscribeResponse>;

  /** 登记由自动化 runId 接管的会话输入，避免同一回合再重复发普通会话完成通知。 */
  markAutomationOwnedSessionTurn?(sessionId: string, runId: string): void;

  /** 清除指定会话（及可选 runId）的自动化接管标记，用于派发失败或手动中断后释放。 */
  clearAutomationOwnedSessionTurn?(sessionId: string, runId?: string): void;

  /** 同步检查并消费当前会话的自动化接管标记；用于异步获取详情前锁定回合归属。 */
  consumeAutomationOwnedSessionTurn?(sessionId: string): boolean;

  /** 异步入队并向已订阅设备投递会话待处理交互或回合终态推送，不阻塞主流程。 */
  notifySessionEvent(event: WebPushSessionEventInput): void;

  /** 在待处理交互尚未发出推送前取消排队（不下发静默推送包，避免违反浏览器 userVisibleOnly 配额）。 */
  cancelPendingInteractionNotification(interactionId: string): void;

  /** 异步入队并向已订阅设备投递定时任务运行完成或失败推送。 */
  notifyAutomationEvent(event: WebPushAutomationEventInput): void;

  /** 等待在途推送任务排空并关闭资源。 */
  dispose(): Promise<void>;
}

export const IWebPushService = createServiceDescriptor<IWebPushService>("webPushService");
