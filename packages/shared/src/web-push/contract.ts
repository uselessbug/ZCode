import { z } from "zod";

export const WEB_PUSH_SERVICE_WORKER_PATH = "/zcode-push-sw.js";
export const WEB_PUSH_MANIFEST_PATH = "/manifest.webmanifest";
export const WEB_PUSH_API_CONFIG_PATH = "/api/web-push/config";
export const WEB_PUSH_API_SUBSCRIPTIONS_PATH = "/api/web-push/subscriptions";
export const WEB_PUSH_API_UNSUBSCRIBE_PATH = "/api/web-push/subscriptions/unsubscribe";

export const WEB_PUSH_QUERY_TASK_KEY = "zcodeTask";
export const WEB_PUSH_QUERY_WORKSPACE_KEY = "zcodeWorkspace";
export const WEB_PUSH_QUERY_WORKSPACE_IDENTITY_KEY = "zcodeWorkspaceIdentity";

export type WebPushSupportedLocale = "zh-CN" | "en-US";

export type TaskNotificationStatusKind =
  | "completed"
  | "failed"
  | "permission_request"
  | "elicitation_request"
  | "feedback_update";

export type WebNotificationPermissionState =
  | "unsupported"
  | "ios-install-required"
  | "default"
  | "granted"
  | "denied";

export type WebNotificationErrorCode =
  | "permission_denied"
  | "push_unsupported"
  | "server_unavailable"
  | "subscribe_failed"
  | "unsubscribe_failed";

export interface WebNotificationStateSnapshot {
  permission: WebNotificationPermissionState;
  /** 当前页面路由是否支持后台推送能力（独立 Web 工作台为 true，远控代理页为 false） */
  pushAvailable?: boolean;
  pushSupported: boolean;
  pushSubscribed: boolean;
  busy?: boolean;
  error?: WebNotificationErrorCode | null;
}

export const webPushSubscriptionKeysSchema = z.object({
  p256dh: z.string().trim().min(1).max(256),
  auth: z.string().trim().min(1).max(128),
});

export const webPushSubscriptionJsonSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: webPushSubscriptionKeysSchema,
});

export const webPushSubscribeRequestSchema = z.object({
  subscription: webPushSubscriptionJsonSchema,
  locale: z.enum(["zh-CN", "en-US"]).optional(),
  soundEnabled: z.boolean().optional(),
  userAgent: z.string().trim().max(512).optional(),
});

export const webPushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
});

export const webPushConfigResponseSchema = z.object({
  enabled: z.boolean(),
  vapidPublicKey: z.string().trim().min(1).nullable(),
});

export type WebPushSubscriptionKeys = z.infer<typeof webPushSubscriptionKeysSchema>;
export type WebPushSubscriptionJson = z.infer<typeof webPushSubscriptionJsonSchema>;
export type WebPushSubscribeRequest = z.infer<typeof webPushSubscribeRequestSchema>;
export type WebPushUnsubscribeRequest = z.infer<typeof webPushUnsubscribeRequestSchema>;
export type WebPushConfigResponse = z.infer<typeof webPushConfigResponseSchema>;

export interface WebPushSubscribeResponse {
  ok: boolean;
  endpoint: string;
}

export interface WebPushUnsubscribeResponse {
  ok: boolean;
  removed: boolean;
}

export type WebPushEventKind =
  | "task_completed"
  | "task_failed"
  | "approval"
  | "question"
  | "plan"
  | "automation_completed"
  | "automation_failed";

export const webPushNotificationMessageSchema = z.object({
  version: z.literal(1),
  action: z.literal("show"),
  eventId: z.string().min(1),
  tag: z.string().min(1),
  secondaryTag: z.string().min(1).optional(),
  kind: z
    .enum([
      "task_completed",
      "task_failed",
      "approval",
      "question",
      "plan",
      "automation_completed",
      "automation_failed",
    ])
    .optional(),
  title: z.string().min(1),
  body: z.string(),
  silent: z.boolean().optional(),
  taskId: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  workspaceIdentity: z.string().min(1).optional(),
  occurredAt: z.number(),
});

export type WebPushNotificationMessage = z.infer<typeof webPushNotificationMessageSchema>;

export interface FormatWebPushNotificationCopyInput {
  kind: WebPushEventKind;
  locale?: WebPushSupportedLocale;
  sessionTitle?: string;
  detail?: string;
}
