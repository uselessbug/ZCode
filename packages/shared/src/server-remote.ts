import { z } from "zod";
import { compatibilityManifestSchema } from "./source-server/compatibility.js";

export const SERVER_REMOTE_PROTOCOL_VERSION = 1;

export const STANDALONE_TERMINAL_OWNER_SUBPROTOCOL = "zcode-standalone-terminal-v1";
export const STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX = `${STANDALONE_TERMINAL_OWNER_SUBPROTOCOL}.`;
export const STANDALONE_TERMINAL_OWNER_CLOSE_CODE = 4001;
export const STANDALONE_TERMINAL_OWNER_CLOSE_API_PATH = "/api/standalone-terminal-owner/close";

export interface StandaloneTerminalOwnerState {
  ownerId: string;
  resumeToken: string;
  terminalIds: string[];
}

const serverRemoteWorkspaceInfoShape = {
  path: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  workspaceIdentity: z.string().trim().min(1).optional(),
};

/** 客户端 wire 解析忽略同 protocolVersion 下新增的 optional 字段。 */
export const serverRemoteWorkspaceInfoSchema = z.object(serverRemoteWorkspaceInfoShape);

/** Server 构造自身出参时使用 strict schema，避免意外泄漏字段。 */
export const serverRemoteWorkspaceInfoOutputSchema = z
  .object(serverRemoteWorkspaceInfoShape)
  .strict();

const serverRemoteInfoBaseShape = {
  serverId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  version: z.string(),
  protocolVersion: z.literal(SERVER_REMOTE_PROTOCOL_VERSION),
  authRequired: z.boolean(),
};

export const serverRemoteInfoSchema = z.object({
  ...serverRemoteInfoBaseShape,
  workspaces: z.array(serverRemoteWorkspaceInfoSchema),
  compatibility: compatibilityManifestSchema.strip().optional(),
  migration: z.object({ failedPathCount: z.number().int().nonnegative() }).optional(),
  identity: z
    .object({
      osUser: z.string().trim().min(1),
      hostname: z.string().trim().min(1),
    })
    .optional(),
  capabilities: z.object({
    desktopContinuous: z.literal(true),
    websocketRpc: z.literal(true),
    virtualProjects: z.literal(true).optional(),
    // 独立 Web 本地连接已注册受管 worktree 频道时才声明；缺省视为不支持，前端据此 fail-closed。
    managedWorktrees: z.literal(true).optional(),
    // 独立 Web 本地连接启用页面级 PTY owner 隔离与宽限回收时才声明；缺省按未启用处理。
    standaloneTerminalOwners: z.literal(true).optional(),
    // 旧 Server 缺少新增 dynamic event，必须先声明能力再订阅，避免异常打进对端读循环。
    processResourceTelemetry: z.boolean().optional(),
    remoteConversationTelemetry: z.boolean().optional(),
  }),
});

export const serverRemoteInfoOutputSchema = z
  .object({
    ...serverRemoteInfoBaseShape,
    workspaces: z.array(serverRemoteWorkspaceInfoOutputSchema),
    compatibility: compatibilityManifestSchema.optional(),
    migration: z.object({ failedPathCount: z.number().int().nonnegative() }).strict().optional(),
    identity: z
      .object({
        osUser: z.string().trim().min(1),
        hostname: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    capabilities: z
      .object({
        desktopContinuous: z.literal(true),
        websocketRpc: z.literal(true),
        virtualProjects: z.literal(true).optional(),
        managedWorktrees: z.literal(true).optional(),
        standaloneTerminalOwners: z.literal(true).optional(),
        // 输入和严格输出保持同一能力合同，否则新 Server 会在监听前被自身 schema 拒绝。
        processResourceTelemetry: z.boolean().optional(),
        remoteConversationTelemetry: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export const serverRemoteAnonymousInfoSchema = z.object({
  version: z.string(),
  protocolVersion: z.literal(SERVER_REMOTE_PROTOCOL_VERSION),
  authRequired: z.literal(true),
  compatibility: compatibilityManifestSchema.strip().optional(),
});

export type ServerRemoteWorkspaceInfo = z.infer<typeof serverRemoteWorkspaceInfoSchema>;

export type ServerRemoteInfo = z.infer<typeof serverRemoteInfoSchema>;

export type ServerRemoteAnonymousInfo = z.infer<typeof serverRemoteAnonymousInfoSchema>;

export const serverRemoteHostCapabilitySchema = z
  .object({
    capability: z.string().trim().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ServerRemoteHostCapability = z.infer<typeof serverRemoteHostCapabilitySchema>;
