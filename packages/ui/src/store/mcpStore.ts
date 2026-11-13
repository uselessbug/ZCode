/* eslint-disable max-lines -- MCP store 集中维护配置加载、持久化、状态刷新与运行时状态合并，拆分会增加跨状态同步复杂度。 */
/**
 * MCP (Model Context Protocol) UI State Store
 */
import { create } from "zustand";
import type {
  ZCodeAgentMcpServer,
  CliMcpSource,
  McpConfig,
  McpScope,
  McpServerConfig,
  McpServerStatus,
  McpSource,
  NativeMcpServerRecord,
  ZCodeMcpListMode,
  ZCodeMcpServerStatusSnapshot,
  ZCodeMcpServer,
} from "@zcode/shared";
import { convertToZCodeAgentMcpServer } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  fetchNativeMcpServers,
  migrateLegacyCommonMcpFromDesktop,
  persistCliMcpToUserDirectory,
  type McpDirectoryService,
  type McpPlatformService,
  type MigrateLegacyResult,
} from "@/store/mcpStoreDesktop.js";
import {
  importLegacyCommonServersToZCodeAgent,
  migrateStoredCommonMcpToZCodeAgent,
} from "@/store/mcpStoreMigration.js";
import {
  buildServerList,
  DEFAULT_MCP_CONFIG,
  getServerPriority,
  loadPersistedConfig,
  makeServerId,
  MCP_DELETED_PRELOAD_KEY,
  safeReadJson,
  safeWriteJson,
} from "@/store/mcpStoreHelpers.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { mergeMcpServerStatusSnapshots } from "@/store/mcpStoreStatusList.js";

let mcpPlatformService: McpPlatformService | null = null;
/**
 * 入口显式注入的 base Host MCP 目录服务归属（仅独立 Web 设置），三态：
 * - `undefined`：非 base Host 入口（桌面本机 / 官方手机 relay），无 identity/authority 时走 platform；
 * - `null`：base Host 入口但服务尚未绑定，读取必须 fail-closed；
 * - service：base Host 已绑定，无 identity/authority 时读写都用它。
 *
 * Bug 原因：旧逻辑把「无 workspaceIdentity 且无 authorityKey」当成桌面本机探测，丢弃已绑定的
 * currentDirectoryService，独立 Web 因此回退到无桌面代理的 Web platform，拿到硬编码 `{servers: []}`
 * 并被标记 ready，表现为「顶栏 MCP 7 / 已安装 0」。
 */
let mcpBaseHostDirectoryService: McpDirectoryService | null | undefined;

/**
 * MCP 目录绑定版本。放在模块级：入口 setter（platform / base Host 归属）与 store 内的目标绑定
 * （目标 key、同目标换服务对象）都会改变归属，任一处改绑都必须让在途读取在「复用」与「提交」
 * 两处同时失效，否则旧 Host 的延迟结果会覆盖新 snapshot（例如 Root layout setter 已换成 baseB，
 * 但旧 baseA 的 load 晚到并提交）。
 */
let mcpBindingRevision = 0;

export function setMcpStorePlatform(
  platform: McpPlatformService | null,
  baseHostDirectoryService: McpDirectoryService | null | undefined = undefined,
): void {
  if (mcpPlatformService !== platform || mcpBaseHostDirectoryService !== baseHostDirectoryService) {
    mcpBindingRevision += 1;
  }
  mcpPlatformService = platform;
  mcpBaseHostDirectoryService = baseHostDirectoryService;
}

interface UpdateServerStatusOptions {
  invalidateStatusListRequests?: boolean;
}

interface McpStoreState {
  config: McpConfig;
  nativeServers: NativeMcpServerRecord[];
  servers: ZCodeMcpServer[];
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>;
  currentProjectPath: string;
  currentWorkspaceIdentity?: string;
  currentAuthorityKey?: string;
  /**
   * 当前目标的目录服务，与 currentProjectPath / currentWorkspaceIdentity / currentAuthorityKey
   * 是同一组绑定，只由 setCurrentProjectPath / ensureLoadedForWorkspace 一起写入。
   */
  currentDirectoryService: McpDirectoryService | null;
  enabledStates: Record<string, boolean>;
  deletedPreloadMcpServers: Set<string>;
  isConfigLoaded: boolean;
  currentSessionId: string | null;
  loadConfig: () => void;
  /** 重新读取当前绑定目标的 MCP 配置；要换目标请用 ensureLoadedForWorkspace。 */
  loadMcpFromUserDirectory: () => Promise<boolean>;
  ensureLoadedForWorkspace: (
    workspacePath?: string,
    directoryService?: McpDirectoryService | null,
    workspaceIdentity?: string,
    authorityKey?: string,
  ) => Promise<boolean>;
  saveConfig: () => void;
  addMcpServer: (name: string, config: McpServerConfig) => void;
  updateMcpServer: (name: string, config: McpServerConfig) => void;
  deleteMcpServer: (name: string) => void;
  addScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  updateScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  deleteScopedMcpServer: (source: McpSource, name: string, projectPath?: string) => void;
  addZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateZCodeAgentMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteZCodeAgentMcpServer: (name: string, projectPath?: string) => void;
  addClaudeCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateClaudeCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteClaudeCliMcpServer: (name: string, projectPath?: string) => void;
  addGeminiCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateGeminiCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteGeminiCliMcpServer: (name: string, projectPath?: string) => void;
  addCodexCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateCodexCliMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteCodexCliMcpServer: (name: string, projectPath?: string) => void;
  addOpenCodeMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  updateOpenCodeMcpServer: (name: string, config: McpServerConfig, projectPath?: string) => void;
  deleteOpenCodeMcpServer: (name: string, projectPath?: string) => void;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  updateServerStatus: (
    id: string,
    status: McpServerStatus,
    error?: string,
    options?: UpdateServerStatusOptions,
  ) => void;
  beginServerStatusListRefresh: (mode?: ZCodeMcpListMode) => number;
  markServerStatusListRefreshFailed: (
    error: string,
    requestEpoch: number,
    mode?: ZCodeMcpListMode,
  ) => void;
  mergeServerStatusSnapshots: (
    statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
    requestEpoch: number,
    mode?: "connect" | "status",
  ) => void;
  getServer: (id: string) => ZCodeMcpServer | undefined;
  setCurrentProjectPath: (
    path: string,
    workspaceIdentity?: string,
    directoryService?: McpDirectoryService | null,
    authorityKey?: string,
  ) => void;
  getEnabledMcpServersForZCode: (provider: string) => ZCodeAgentMcpServer[];
  checkAllServerStatus: (
    tester: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>,
  ) => Promise<void>;
  mergePreloadedMcpServers: (preloaded: Record<string, McpServerConfig>) => void;
  deletePreloadedMcpServer: (source: McpSource, name: string) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
  migrateLegacyCommonMcp: () => Promise<MigrateLegacyResult>;
}

export const useMcpStore = create<McpStoreState>((set, get) => {
  let loadMcpPromise: Promise<boolean> | null = null;
  let loadMcpWorkspaceKey: string | null = null;
  /** 已启动 load 捕获的绑定版本。 */
  let loadMcpRevision = 0;
  const statusListEpochs: Record<ZCodeMcpListMode, number> = {
    connect: 0,
    status: 0,
  };

  function invalidateStatusListRequests(): void {
    statusListEpochs.connect += 1;
    statusListEpochs.status += 1;
  }

  function currentTargetKey(): string {
    const { currentAuthorityKey, currentWorkspaceIdentity, currentProjectPath } = get();
    return `${currentAuthorityKey?.trim() || "workspace"}\0${currentWorkspaceIdentity?.trim() || currentProjectPath}`;
  }

  /**
   * 读写通道只看当前绑定的目标。
   *
   * Bug 原因：远端「用户」目标只有 home 路径与 authority、没有 workspace identity。旧逻辑无 identity
   * 就丢弃传入的服务走本机 platform；写入又用当前 tab 设置的全局目录服务。结果是在本机 tab 选
   * 「B · 用户」读写本机，在远端 A tab 选「B · 用户」读 B 写 A、选「本机 · 用户」写 A。
   * 修法：服务与路径 / identity / authority 作为一组绑定，远端目标只用这一组，缺绑定 fail-closed。
   * 无 identity/authority 时不再一律当桌面本机：由入口归属决定（见 setMcpStorePlatform 三态），
   * 独立 Web base Host 走注入的服务器目录服务并跳过桌面 legacy common 迁移，桌面本机 / 官方手机
   * relay 才走 desktop platform 并保留旧 common MCP 迁移。
   */
  function resolveTargetDirectoryService(): McpDirectoryService | null {
    const { currentAuthorityKey, currentDirectoryService, currentWorkspaceIdentity } = get();
    if (currentWorkspaceIdentity || currentAuthorityKey) {
      // 跨 Host 远端目标（SSH / Docker / WSL 项目与远端「用户」）必须使用该目标绑定的目录服务；
      // 缺绑定直接 fail-closed，绝不回退读写桌面本机 platform。
      if (!currentDirectoryService) {
        throw new Error("MCP directory service is not bound to the remote target");
      }
      return currentDirectoryService;
    }
    // 无 identity/authority 时有且只有两种入口：
    // 1) 桌面本机 / 官方手机 relay：走 desktop platform，并保留旧 common MCP 迁移；
    // 2) 独立 Web base Host：入口通过 setMcpStorePlatform 显式注入本机 Host 目录服务，直接用它。
    // 归属由入口决定，不从 workspaceIdentity 推断，也不为独立 Web 伪造 identity。
    if (mcpBaseHostDirectoryService === undefined) {
      return null;
    }
    if (!mcpBaseHostDirectoryService) {
      // base Host 入口但服务尚未绑定：fail-closed，不得回退无桌面代理的 Web platform 冒充成功。
      throw new Error("MCP base host directory service is not bound");
    }
    return mcpBaseHostDirectoryService;
  }

  function commitState(partial: {
    config?: McpConfig;
    nativeServers?: NativeMcpServerRecord[];
  }): Partial<McpStoreState> {
    const state = get();
    const nextConfig = partial.config ?? state.config;
    const nextNativeServers = partial.nativeServers ?? state.nativeServers;
    return {
      config: nextConfig,
      nativeServers: nextNativeServers,
      servers: buildServerList(
        nextConfig,
        nextNativeServers,
        state.enabledStates,
        state.deletedPreloadMcpServers,
        state.servers,
      ),
    };
  }

  function updateNativeServer(
    source: CliMcpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) {
    const nativeServers = get().nativeServers.slice();
    const targetIndex = nativeServers.findIndex(
      (server) =>
        server.source === source && server.name === name && server.projectPath === projectPath,
    );
    if (targetIndex >= 0) {
      const existing = nativeServers[targetIndex];
      if (!existing) {
        return;
      }
      nativeServers[targetIndex] = {
        ...existing,
        config,
      };
    } else {
      // 添加新的服务器记录
      const scope: McpScope = projectPath ? "workspace" : "user";
      nativeServers.push({
        source,
        scope,
        name,
        config,
        enabled: true,
        projectPath,
      });
    }
    set(commitState({ nativeServers }));
  }

  async function persistScopedChange(
    source: McpSource,
    payload: {
      action: "upsert" | "delete";
      source: CliMcpSource;
      name: string;
      config?: McpServerConfig;
      projectPath?: string;
    },
  ): Promise<void> {
    if (source === "mcp") {
      return;
    }

    try {
      await persistCliMcpToUserDirectory(
        mcpPlatformService,
        payload,
        resolveTargetDirectoryService(),
      );
    } catch (error) {
      logger.warn(`[mcpStore] persist ${source} MCP failed`, String(error));
    }
  }

  return {
    config: { ...DEFAULT_MCP_CONFIG },
    nativeServers: [],
    servers: [],
    statusSnapshots: {},
    currentProjectPath: "",
    currentWorkspaceIdentity: undefined,
    currentAuthorityKey: undefined,
    currentDirectoryService: null,
    enabledStates: {},
    deletedPreloadMcpServers: new Set(),
    isConfigLoaded: false,
    currentSessionId: null,

    loadConfig: () => {
      const config = loadPersistedConfig();
      // MCP 启停状态已经迁移到 ~/.zcode/cli/config.json，不能再读取旧 localStorage，
      // 否则旧的本地开关会覆盖新的 ZCode Agent 配置来源。
      const enabledStates: Record<string, boolean> = {};
      const deletedPreload = new Set<string>(safeReadJson<string[]>(MCP_DELETED_PRELOAD_KEY, []));
      const servers = buildServerList(config, [], enabledStates, deletedPreload, []);
      set({
        config,
        nativeServers: [],
        enabledStates,
        deletedPreloadMcpServers: deletedPreload,
        servers,
        statusSnapshots: {},
        isConfigLoaded: true,
      });
    },

    loadMcpFromUserDirectory: async () => {
      if (typeof window === "undefined") {
        return false;
      }

      const requestWorkspaceKey = currentTargetKey();
      const requestRevision = mcpBindingRevision;
      if (
        loadMcpPromise &&
        loadMcpWorkspaceKey === requestWorkspaceKey &&
        loadMcpRevision === requestRevision
      ) {
        return await loadMcpPromise;
      }
      if (loadMcpPromise) {
        await loadMcpPromise;
      }

      if (currentTargetKey() !== requestWorkspaceKey || mcpBindingRevision !== requestRevision) {
        // 该调用等待上一轮 load 时已从 B 切到 C，或同一目标换了目录服务对象（重连）；
        // 交给新绑定自己发起的 ensure/load 调用处理，不复用旧服务的结果。
        return false;
      }
      if (
        loadMcpPromise &&
        loadMcpWorkspaceKey === requestWorkspaceKey &&
        loadMcpRevision === requestRevision
      ) {
        return await loadMcpPromise;
      }

      const { currentProjectPath, currentWorkspaceIdentity } = get();
      const latestWorkspacePath = currentProjectPath || undefined;
      loadMcpWorkspaceKey = requestWorkspaceKey;
      loadMcpRevision = requestRevision;
      loadMcpPromise = (async () => {
        try {
          // 等待上一目标 load 期间可能再次切换；目录服务取等待后的最新绑定，
          // 与 requestWorkspaceKey 属于同一组目标，不能拿 B 的服务读取 C 的路径。
          const activeDirectoryService = resolveTargetDirectoryService();
          logger.info(
            `[mcpStore] loadMcpFromUserDirectory workspace=${latestWorkspacePath ?? "<none>"} identity=${currentWorkspaceIdentity ?? "<none>"}`,
          );
          let servers = await fetchNativeMcpServers(
            mcpPlatformService,
            { workspacePath: latestWorkspacePath },
            activeDirectoryService,
          );
          if (!activeDirectoryService) {
            // base Host 目标始终有绑定服务，因此不会进入桌面 legacy common 迁移；
            // 独立 Web 不得把 localStorage 旧 common 写进服务器配置。
            servers = await migrateStoredCommonMcpToZCodeAgent(
              mcpPlatformService,
              servers,
              latestWorkspacePath,
            );
          }
          if (
            currentTargetKey() !== requestWorkspaceKey ||
            mcpBindingRevision !== requestRevision
          ) {
            // workspace A 的异步目录读取可能晚于切换到 B 才返回，同一目标也可能在
            // 重连后换了目录服务对象；旧结果包含 env/header/OAuth secret，
            // 不能写回共享 store 后被新 Host 的 Agent 消费。
            return false;
          }
          set(commitState({ nativeServers: servers }));
          return true;
        } catch (e) {
          // 读取失败不是“配置为空”；调用方必须保持 workspace not-ready，
          // 否则会显式下发空 mcpServers 并触发 replace，断开仍在运行的 MCP。
          // remote session attachment 绑定前只能拿到断连代理；这是初始化时序，不是
          // MCP 配置读取失败。只过滤该精确错误码，避免吞掉真实的目录或 RPC 故障。
          if (!isRemoteWorkspaceDisconnectedError(e)) {
            logger.warn("[mcpStore] loadMcpFromUserDirectory failed", String(e));
          }
          return false;
        } finally {
          loadMcpPromise = null;
          loadMcpWorkspaceKey = null;
        }
      })();

      return await loadMcpPromise;
    },

    ensureLoadedForWorkspace: async (
      workspacePath,
      directoryService,
      workspaceIdentity,
      authorityKey,
    ) => {
      if (!get().isConfigLoaded) {
        get().loadConfig();
      }

      const normalizedWorkspacePath = workspacePath ?? "";
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const normalizedAuthorityKey = authorityKey?.trim() || undefined;
      if (
        normalizedWorkspacePath !== get().currentProjectPath ||
        normalizedWorkspaceIdentity !== get().currentWorkspaceIdentity ||
        normalizedAuthorityKey !== get().currentAuthorityKey
      ) {
        get().setCurrentProjectPath(
          normalizedWorkspacePath,
          normalizedWorkspaceIdentity,
          directoryService,
          normalizedAuthorityKey,
        );
      } else if ((directoryService ?? null) !== get().currentDirectoryService) {
        // 同一目标换了服务对象（例如 attachment 换代 / 重连）：只换绑服务，不清空列表。
        const { currentAuthorityKey, currentWorkspaceIdentity } = get();
        if (currentWorkspaceIdentity || currentAuthorityKey) {
          // 只有远端目标的目录服务才是路由来源，换服务对象必须让在途读取失效，
          // 否则旧 Host 的延迟结果会覆盖新 Host 的 snapshot。
          mcpBindingRevision += 1;
        }
        // 无 identity/authority 时路由来源是入口注入的 base Host：base 换服务的失效由
        // setMcpStorePlatform 负责；这里若也自增，设置页与会话调用方传入不同 wrapper 对象
        // 会互相取消真实 base 读取，导致 loading 卡住。
        set({ currentDirectoryService: directoryService ?? null });
      }

      return await get().loadMcpFromUserDirectory();
    },

    saveConfig: () => {
      const { deletedPreloadMcpServers } = get();
      safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(deletedPreloadMcpServers));
    },

    addMcpServer: (name, config) => get().addZCodeAgentMcpServer(name, config),
    updateMcpServer: (name, config) => get().updateZCodeAgentMcpServer(name, config),
    deleteMcpServer: (name) => get().deleteZCodeAgentMcpServer(name),
    addScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 设置页保存后会马上触发 agent 侧 mcp/list 重连。
      // 先等配置落盘，再更新本地 store，避免 agent 读到旧 timeoutMs 后展示旧健康状态。
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    updateScopedMcpServer: async (source, name, config, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      // 修复原因同新增：本地状态变化会驱动健康状态刷新，必须在磁盘配置更新后发生。
      await persistScopedChange(targetSource, {
        action: "upsert",
        source: targetSource,
        name,
        config,
        projectPath,
      });
      updateNativeServer(targetSource, name, config, projectPath);
    },
    deleteScopedMcpServer: (source, name, projectPath) => {
      invalidateStatusListRequests();
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      persistScopedChange(targetSource, {
        action: "delete",
        source: targetSource,
        name,
        projectPath,
      });
      set(
        commitState({
          nativeServers: get().nativeServers.filter(
            (server) =>
              !(
                server.source === targetSource &&
                server.name === name &&
                server.projectPath === projectPath
              ),
          ),
        }),
      );
    },
    addClaudeCliMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("claudeclimcp", name, config, projectPath),
    updateClaudeCliMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("claudeclimcp", name, config, projectPath),
    deleteClaudeCliMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("claudeclimcp", name, projectPath),
    addGeminiCliMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("geminiclimcp", name, config, projectPath),
    updateGeminiCliMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("geminiclimcp", name, config, projectPath),
    deleteGeminiCliMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("geminiclimcp", name, projectPath),
    addCodexCliMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("codexclimcp", name, config, projectPath),
    updateCodexCliMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("codexclimcp", name, config, projectPath),
    deleteCodexCliMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("codexclimcp", name, projectPath),
    addOpenCodeMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("opencodemcp", name, config, projectPath),
    updateOpenCodeMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("opencodemcp", name, config, projectPath),
    deleteOpenCodeMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("opencodemcp", name, projectPath),
    addZCodeAgentMcpServer: (name, config, projectPath) =>
      get().addScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    updateZCodeAgentMcpServer: (name, config, projectPath) =>
      get().updateScopedMcpServer("zcodeagentmcp", name, config, projectPath),
    deleteZCodeAgentMcpServer: (name, projectPath) =>
      get().deleteScopedMcpServer("zcodeagentmcp", name, projectPath),

    toggleServer: async (id, enabled) => {
      invalidateStatusListRequests();
      const targetServer = get().servers.find((server) => server.id === id);
      if (targetServer && targetServer.source !== "mcp") {
        // 开关变化会触发 agent 侧 mcp/list 读取磁盘配置做真实连接。
        // 必须先等 enable 状态落盘，再更新本地列表驱动刷新，否则 agent 会读到旧开关。
        try {
          await persistCliMcpToUserDirectory(
            mcpPlatformService,
            {
              action: "set-enabled",
              source: targetServer.source,
              name: targetServer.name,
              enabled,
              projectPath: targetServer.projectPath,
              location: targetServer.location,
            },
            resolveTargetDirectoryService(),
          );
        } catch (error) {
          logger.warn("[mcpStore] persist MCP enabled override failed", String(error));
        }
      }

      set((state) => {
        const nextEnabledStates = { ...state.enabledStates, [id]: enabled };
        return {
          enabledStates: nextEnabledStates,
          servers: state.servers.map((s) => (s.id === id ? { ...s, enabled } : s)),
        };
      });
    },

    updateServerStatus: (id, status, error, options) => {
      if (options?.invalidateStatusListRequests !== false) {
        invalidateStatusListRequests();
      }
      set((state) => ({
        servers: state.servers.map((s) =>
          s.id === id
            ? {
                ...s,
                status,
                authorization: undefined,
                error,
                failureKind: status === "error" ? "connection_failed" : undefined,
                serverRequestId: undefined,
                toolCount: status === "connected" ? s.toolCount : undefined,
                changed: status === "error" ? s.changed : false,
                lastConnected: status === "connected" ? new Date() : s.lastConnected,
              }
            : s,
        ),
      }));
    },

    beginServerStatusListRefresh: (mode = "connect") => {
      statusListEpochs[mode] += 1;
      const requestEpoch = statusListEpochs[mode];
      if (mode === "status") {
        // OAuth 1s status-only 轮询只读取 runtime snapshot；不能反复清空
        // authorization/toolCount 或把用户同时编辑的其他 MCP 投影成 connecting。
        return requestEpoch;
      }
      // agent 侧 mcp/list 会等待所有 MCP 连接完成才返回；如果插件 MCP 还在 30s 超时中，
      // 修改 timeoutMs 后本地列表会长时间停在 unknown，看起来像没有立即重新检查。
      set((state) => ({
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (
            server.source !== "zcodeagentmcp" ||
            !enabled ||
            (!server.changed && server.status !== "unknown")
          ) {
            return server;
          }
          return {
            ...server,
            status: "connecting",
            authorization: undefined,
            error: undefined,
            failureKind: undefined,
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
      return requestEpoch;
    },

    markServerStatusListRefreshFailed: (error, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode] || mode === "status") {
        // OAuth 轮询是只读的 best-effort status 请求；临时失败不能清空已有
        // authorization snapshot，也不能把同一列表中仍在连接的 MCP 批量标红。
        return;
      }
      set((state) => ({
        statusSnapshots: {},
        servers: state.servers.map((server) => {
          const enabled = state.enabledStates[server.id] ?? server.enabled;
          if (server.source !== "zcodeagentmcp" || !enabled || server.status !== "connecting") {
            return server;
          }
          return {
            ...server,
            status: "error",
            authorization: undefined,
            error,
            failureKind: "status_unavailable",
            serverRequestId: undefined,
            toolCount: undefined,
          };
        }),
      }));
    },

    mergeServerStatusSnapshots: (statuses, requestEpoch, mode = "connect") => {
      if (requestEpoch !== statusListEpochs[mode]) {
        return;
      }
      set((state) => {
        const nextStatusSnapshots =
          mode === "status" ? { ...state.statusSnapshots, ...statuses } : statuses;
        return {
          statusSnapshots: nextStatusSnapshots,
          servers: mergeMcpServerStatusSnapshots(state.servers, nextStatusSnapshots, {
            // Bugfix：OAuth 轮询的 status-only 响应可能只包含 pending 子集。
            // 缺失项不能按全量 mcp/list 处理，否则会把其他 MCP 误标为 agent 未返回。
            markMissingConnectingAsError: mode !== "status",
          }),
        };
      });
    },

    getServer: (id) => get().servers.find((s) => s.id === id),

    setCurrentProjectPath: (path, workspaceIdentity, directoryService, authorityKey) => {
      invalidateStatusListRequests();
      const {
        config,
        currentProjectPath,
        currentWorkspaceIdentity,
        currentAuthorityKey,
        deletedPreloadMcpServers,
        enabledStates,
        isConfigLoaded,
        nativeServers,
        servers,
      } = get();
      const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || undefined;
      const normalizedAuthorityKey = authorityKey?.trim() || undefined;
      const workspaceChanged =
        path !== currentProjectPath ||
        normalizedWorkspaceIdentity !== currentWorkspaceIdentity ||
        normalizedAuthorityKey !== currentAuthorityKey;
      const nextNativeServers = workspaceChanged ? [] : nativeServers;
      if (workspaceChanged) {
        // 目标 key 变化同样是一次绑定版本变化；配合 in-flight 读取的版本校验，
        // 保证旧目标的结果不会在新目标的路径/服务上被复用。
        mcpBindingRevision += 1;
      }
      set({
        currentProjectPath: path,
        currentWorkspaceIdentity: normalizedWorkspaceIdentity,
        currentAuthorityKey: normalizedAuthorityKey,
        currentDirectoryService: directoryService ?? null,
        nativeServers: nextNativeServers,
        statusSnapshots: {},
        servers: buildServerList(
          config,
          nextNativeServers,
          enabledStates,
          deletedPreloadMcpServers,
          workspaceChanged ? [] : servers,
        ),
      });
      if (isConfigLoaded && workspaceChanged) {
        // 切换到远程 workspace 后配置加载是异步的；等待期间必须先清空 A 的
        // user-level MCP，不能把其 env/header/OAuth clientSecret 暂存为 B 的可发送配置。
        void get().loadMcpFromUserDirectory();
      }
    },

    getEnabledMcpServersForZCode: (_provider) => {
      const { servers, enabledStates, currentProjectPath } = get();
      const candidates = new Map<string, ZCodeMcpServer>();

      for (const server of servers) {
        const isEnabled = enabledStates[server.id] ?? server.enabled;
        if (!isEnabled) continue;
        if (server.source !== "zcodeagentmcp") continue;
        if (server.scope === "workspace" && server.projectPath !== currentProjectPath) continue;

        const existing = candidates.get(server.name);
        if (!existing || getServerPriority(server) > getServerPriority(existing)) {
          candidates.set(server.name, server);
        }
      }

      const result: ZCodeAgentMcpServer[] = [];
      for (const server of candidates.values()) {
        const zcodeAgentServer = convertToZCodeAgentMcpServer(
          server.name,
          server.config,
          server.scope === "workspace" ? "workspace" : "user",
        );
        if (zcodeAgentServer) result.push(zcodeAgentServer);
      }
      return result;
    },

    checkAllServerStatus: async (tester) => {
      for (const server of get().servers) {
        const isEnabled = get().enabledStates[server.id] ?? server.enabled;
        if (!isEnabled || (!server.changed && server.status !== "unknown")) continue;

        get().updateServerStatus(server.id, "connecting");
        try {
          const result = await tester(server.config);
          get().updateServerStatus(
            server.id,
            result.success ? "connected" : "error",
            result.success ? undefined : (result.error ?? "Connection failed"),
          );
        } catch (e) {
          get().updateServerStatus(server.id, "error", String(e));
        }
      }
    },

    mergePreloadedMcpServers: (preloaded) => {
      const { deletedPreloadMcpServers, nativeServers } = get();
      const targetSource: CliMcpSource = "zcodeagentmcp";
      const nextNativeServers = nativeServers.slice();
      let changed = false;

      for (const [name, cfg] of Object.entries(preloaded)) {
        const serverId = makeServerId(targetSource, name);
        const exists = nextNativeServers.some(
          (server) => server.source === targetSource && server.name === name && !server.projectPath,
        );
        if (deletedPreloadMcpServers.has(serverId) || exists) continue;
        nextNativeServers.push({
          source: targetSource,
          scope: "user",
          name,
          config: cfg,
          enabled: true,
        });
        persistScopedChange(targetSource, {
          action: "upsert",
          source: targetSource,
          name,
          config: cfg,
        });
        changed = true;
      }

      if (!changed) return;
      set(commitState({ nativeServers: nextNativeServers }));
    },

    deletePreloadedMcpServer: (source, name) => {
      const targetSource: CliMcpSource = source === "mcp" ? "zcodeagentmcp" : source;
      const key = makeServerId(targetSource, name);
      persistScopedChange(targetSource, { action: "delete", source: targetSource, name });
      set((state) => {
        const nextDeleted = new Set(state.deletedPreloadMcpServers);
        nextDeleted.add(key);
        safeWriteJson(MCP_DELETED_PRELOAD_KEY, Array.from(nextDeleted));
        const nextNativeServers = state.nativeServers.filter(
          (server) =>
            !(server.source === targetSource && server.name === name && !server.projectPath),
        );
        return {
          deletedPreloadMcpServers: nextDeleted,
          nativeServers: nextNativeServers,
          servers: buildServerList(
            state.config,
            nextNativeServers,
            state.enabledStates,
            nextDeleted,
            state.servers,
          ),
        };
      });
    },

    setCurrentSessionId: (sessionId) => set({ currentSessionId: sessionId }),

    migrateLegacyCommonMcp: async () => {
      if (mcpBaseHostDirectoryService !== undefined) {
        // base Host 入口（独立 Web）没有桌面 legacy common 迁移语义：它读的是 platform 通道，
        // 误走会读错通道并用空结果覆盖真实服务器列表。这里显式 no-op，保持 not-migrated。
        return { totalCount: 0, importedCount: 0, skippedCount: 0 };
      }
      const result = await migrateLegacyCommonMcpFromDesktop(mcpPlatformService);
      const latestWorkspacePath = get().currentProjectPath || undefined;
      const currentNativeServers =
        get().nativeServers.length > 0
          ? get().nativeServers
          : await fetchNativeMcpServers(mcpPlatformService, { workspacePath: latestWorkspacePath });
      const migration = await importLegacyCommonServersToZCodeAgent(
        mcpPlatformService,
        result.servers ?? {},
        currentNativeServers,
        result.sourcePath,
      );
      if (migration.changed) {
        const servers = await fetchNativeMcpServers(mcpPlatformService, {
          workspacePath: latestWorkspacePath,
        });
        set(commitState({ nativeServers: servers }));
      }
      return migration;
    },
  };
});
