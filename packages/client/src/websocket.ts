import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  Event,
  type IDisposable,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor, ITerminalService } from "@zcode/services";
import {
  ServiceChannels,
  STANDALONE_TERMINAL_OWNER_CLOSE_CODE,
  STANDALONE_TERMINAL_OWNER_SUBPROTOCOL,
  STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX,
  type StandaloneTerminalOwnerState,
} from "@zcode/shared";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface StandaloneTerminalPageOptions {
  /** 页面退出时若 WS 尚未打开，用于通过同源 keepalive HTTP 提前回收已签发的 owner。 */
  onExplicitCloseWithoutOpenSocket?: (resumeToken: string) => void;
}

const WS_READY_STATE_OPEN = 1;

/** 底部与侧栏都可能持有旧代理。ID 在页面内保持唯一，绝不把旧 PTY 的操作交给新 owner。 */
export function createStandaloneTerminalPage(options: StandaloneTerminalPageOptions = {}) {
  type Connection = { socket: WebSocket; ownerId: string; service: ITerminalService };
  type PendingConnection = {
    socket: WebSocket;
    ready: Promise<Connection>;
    rejectReady: (error: Error) => void;
    cancelled: boolean;
  };
  interface Terminal {
    id: string;
    ownerId: string;
    remoteId: string;
    data: Emitter<string>;
    exit: Emitter<number>;
    subscriptions: IDisposable[];
    closed: boolean;
  }
  let activeSocket: WebSocket | undefined;
  let connection: Connection | undefined;
  let pending: PendingConnection | undefined;
  let resumeToken: string | undefined;
  let pageClosed = false;
  let sequence = 0;
  const terminals = new Map<string, Terminal>();

  function createConnectionClosedError(): Error {
    const error = new Error("WebSocket connection closed");
    error.name = "ConnectionClosed";
    return error;
  }

  function unbind(terminal: Terminal) {
    for (const subscription of terminal.subscriptions.splice(0)) subscription.dispose();
  }

  function finish(terminal: Terminal, exitCode?: number) {
    if (!terminals.delete(terminal.id)) return;
    unbind(terminal);
    if (!terminal.closed && exitCode !== undefined) terminal.exit.fire(exitCode);
    terminal.data.dispose();
    terminal.exit.dispose();
  }

  function bind(terminal: Terminal, current: Connection) {
    terminal.subscriptions.push(
      current.service.onDynamicData(terminal.remoteId)((data) => {
        if (connection === current && !terminal.closed) terminal.data.fire(data);
      }),
      current.service.onDynamicExit(terminal.remoteId)((code) => {
        if (connection === current) finish(terminal, code);
      }),
    );
  }

  function disposeRemote(terminal: Terminal, current: Connection) {
    void current.service.dispose({ id: terminal.remoteId }).then(
      () => finish(terminal),
      () => {}, // 无回包时由重连对账或服务端 owner 回收。
    );
  }

  async function getReadyConnection(): Promise<Connection> {
    if (pageClosed) throw createConnectionClosedError();
    if (pending) return pending.ready;
    if (connection) return connection;
    throw createConnectionClosedError();
  }

  const service: ITerminalService = {
    async create(params) {
      const current = await getReadyConnection();
      const result = await current.service.create(params);
      if (connection !== current || pageClosed) {
        if (connection && connection.ownerId === current.ownerId && !pageClosed) {
          void connection.service.dispose({ id: result.id }).catch(() => {});
        } else if (pending && !pageClosed) {
          // 正在同页重连时等待新连接确认同一 owner 后清理孤儿 PTY。
          void pending.ready
            .then((next) => {
              if (next.ownerId === current.ownerId && !pageClosed) {
                return next.service.dispose({ id: result.id });
              }
              return undefined;
            })
            .catch(() => {});
        }
        throw createConnectionClosedError();
      }
      const terminal: Terminal = {
        id: String(++sequence),
        ownerId: current.ownerId,
        remoteId: result.id,
        data: new Emitter(),
        exit: new Emitter(),
        subscriptions: [],
        closed: false,
      };
      terminals.set(terminal.id, terminal);
      bind(terminal, current);
      return { ...result, id: terminal.id };
    },
    async write({ id, data }) {
      const terminal = terminals.get(id);
      // 断线期间不接收、不重放输入；旧代际回包也不影响新终端。
      if (!terminal || terminal.closed || pageClosed) return;
      let current: Connection | undefined = connection;
      if (!current && pending) {
        try {
          current = await pending.ready;
        } catch {
          return;
        }
      }
      if (
        !current ||
        connection !== current ||
        terminal.closed ||
        !terminals.has(id) ||
        pageClosed
      ) {
        return;
      }
      await current.service.write({ id: terminal.remoteId, data }).catch(() => {});
    },
    async resize({ id, cols, rows }) {
      const terminal = terminals.get(id);
      if (!terminal || terminal.closed || pageClosed) return;
      let current: Connection | undefined = connection;
      if (!current && pending) {
        try {
          current = await pending.ready;
        } catch {
          return;
        }
      }
      if (
        !current ||
        connection !== current ||
        terminal.closed ||
        !terminals.has(id) ||
        pageClosed
      ) {
        return;
      }
      await current.service.resize({ id: terminal.remoteId, cols, rows });
    },
    async dispose({ id }) {
      const terminal = terminals.get(id);
      if (!terminal || terminal.closed) return;
      terminal.closed = true;
      unbind(terminal);
      if (connection) {
        disposeRemote(terminal, connection);
      } else if (pending && !pageClosed) {
        void pending.ready
          .then((current) => {
            if (connection === current && terminals.has(id) && !pageClosed) {
              disposeRemote(terminal, current);
            }
          })
          .catch(() => {});
      }
    },
    async listTerminalIdsUnderPath(params) {
      if (pageClosed || (!connection && !pending)) return [];
      let current: Connection;
      try {
        current = await getReadyConnection();
      } catch (error) {
        if (error instanceof Error && error.name === "ConnectionClosed") {
          return [];
        }
        throw error;
      }
      const ids = new Set(await current.service.listTerminalIdsUnderPath(params));
      return [...terminals.values()]
        .filter((terminal) => !terminal.closed && ids.has(terminal.remoteId))
        .map((terminal) => terminal.id);
    },
    onDynamicData: (id) => terminals.get(id)?.data.event ?? Event.None,
    onDynamicExit: (id) => terminals.get(id)?.exit.event ?? Event.None,
  };

  return {
    service,
    getSubprotocol(): string {
      return resumeToken
        ? `${STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX}${resumeToken}`
        : STANDALONE_TERMINAL_OWNER_SUBPROTOCOL;
    },
    getResumeToken(): string | undefined {
      return resumeToken;
    },
    isClosed(): boolean {
      return pageClosed;
    },
    trackSocket(socket: WebSocket): void {
      if (!pageClosed) {
        activeSocket = socket;
      }
    },
    beginConnect(
      socket: WebSocket,
      remote: ITerminalService,
      fetchOwnerState: () => Promise<StandaloneTerminalOwnerState>,
    ): void {
      if (pageClosed) return;
      activeSocket = socket;
      if (pending && pending.socket !== socket) {
        const previousPending = pending;
        previousPending.cancelled = true;
        previousPending.rejectReady(createConnectionClosedError());
      }
      let resolveReady!: (value: Connection) => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<Connection>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // 终端尚未被调用时断线/失败不应触发未捕获 Promise 拒绝。
      ready.catch(() => {});
      const currentPending: PendingConnection = {
        socket,
        ready,
        rejectReady,
        cancelled: false,
      };
      pending = currentPending;

      void (async () => {
        try {
          const state1 = await fetchOwnerState();
          if (currentPending.cancelled || activeSocket !== socket || pageClosed) {
            currentPending.rejectReady(createConnectionClosedError());
            return;
          }
          resumeToken = state1.resumeToken;
          const current: Connection = { socket, service: remote, ownerId: state1.ownerId };
          connection = current;

          const activeIds = new Set(state1.terminalIds);
          const tracked = new Set<string>();
          const reboundTerminals: Terminal[] = [];
          for (const terminal of Array.from(terminals.values())) {
            unbind(terminal);
            if (terminal.ownerId !== state1.ownerId || !activeIds.has(terminal.remoteId)) {
              finish(terminal, 1);
            } else {
              tracked.add(terminal.remoteId);
              if (terminal.closed) {
                disposeRemote(terminal, current);
              } else {
                bind(terminal, current);
                reboundTerminals.push(terminal);
              }
            }
          }
          // 创建已到 Host、但页面没有收到 ID 时，不把那个无人持有的终端留在旧 owner。
          for (const id of activeIds) {
            if (!tracked.has(id)) void remote.dispose({ id }).catch(() => {});
          }

          // Close race：首份快照之后、onDynamicExit 订阅建立前若有 PTY 退出，
          // 紧随订阅之后再读取一次有序快照，立刻清理在窗口期退出的终端。
          if (reboundTerminals.length > 0) {
            const state2 = await fetchOwnerState();
            if (
              currentPending.cancelled ||
              connection !== current ||
              activeSocket !== socket ||
              pageClosed
            ) {
              currentPending.rejectReady(createConnectionClosedError());
              return;
            }
            const stillActiveIds = new Set(state2.terminalIds);
            for (const terminal of reboundTerminals) {
              if (terminal.ownerId !== state2.ownerId || !stillActiveIds.has(terminal.remoteId)) {
                finish(terminal, 1);
              }
            }
          }

          if (pending === currentPending) {
            pending = undefined;
          }
          resolveReady(current);
        } catch (error) {
          if (connection?.socket === socket) {
            connection = undefined;
          }
          if (pending === currentPending) {
            pending = undefined;
          }
          rejectReady(
            error instanceof Error ? error : new Error("Standalone terminal owner unavailable"),
          );
        }
      })();
    },
    disconnect(socket: WebSocket): void {
      if (activeSocket === socket) {
        activeSocket = undefined;
      }
      if (pending?.socket === socket) {
        const cancelledPending = pending;
        pending = undefined;
        cancelledPending.cancelled = true;
        cancelledPending.rejectReady(createConnectionClosedError());
      }
      if (connection?.socket === socket) {
        connection = undefined;
        for (const terminal of terminals.values()) unbind(terminal);
      }
    },
    close(): void {
      if (pageClosed) return;
      pageClosed = true;
      const socket = activeSocket;
      const token = resumeToken;
      if (pending) {
        const cancelledPending = pending;
        pending = undefined;
        cancelledPending.cancelled = true;
        cancelledPending.rejectReady(createConnectionClosedError());
      }
      if (socket && socket.readyState === WS_READY_STATE_OPEN) {
        socket.close(STANDALONE_TERMINAL_OWNER_CLOSE_CODE);
      } else if (token) {
        // 页面在短断线/重连握手窗口退出时无法发出 WS 4001 帧，走同源保活接口显式回收。
        options.onExplicitCloseWithoutOpenSocket?.(token);
      }
      activeSocket = undefined;
      connection = undefined;
      for (const terminal of Array.from(terminals.values())) {
        terminal.closed = true;
        finish(terminal);
      }
    },
  };
}

export type StandaloneTerminalPage = ReturnType<typeof createStandaloneTerminalPage>;

function withTerminalServiceOverride(
  services: RemoteServiceAccess,
  terminalService: ITerminalService,
): IServiceAccessor {
  // 不展开 RemoteServiceAccess 实例，保留其原型链、不可枚举属性与 getter/Proxy 行为。
  return new Proxy(services, {
    get(target, property, receiver) {
      if (property === "terminalService") {
        return terminalService;
      }
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === "terminalService") {
        return {
          configurable: true,
          enumerable: true,
          value: terminalService,
          writable: false,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

export interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  standaloneTerminalPage?: StandaloneTerminalPage;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /**
   * 是否暴露 windowControllerService。普通 Web 的 Headless Host 不注册该通道，
   * 默认 false 让 services.windowControllerService 保持 undefined，消费方回退到 zcodeTaskService。
   */
  exposeWindowController?: boolean;
  /**
   * 是否暴露 managedWorktreeService。仅独立 Web 本地连接（非 /ws/remote/<id> 跨机代理）
   * 由入口显式开启；缺省 false，避免远程/手机误订阅未注册频道。
   */
  managedWorktreeService?: boolean;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
      ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const terminalPage = options?.standaloneTerminalPage;
    const terminalProtocol = terminalPage?.getSubprotocol();
    const ws = terminalProtocol ? new WebSocket(wsUrl, terminalProtocol) : new WebSocket(wsUrl);
    terminalPage?.trackSocket(ws);
    let settled = false;
    let closed = false;
    // 修复依据：普通 Web 的 close 未释放 ChannelClient，旧请求和新请求都会永久等待。
    // 连接适配器拥有这三个对象；终结时必须一起释放，不把请求带入下一条连接。
    const socket = wrapBrowserWebSocket(ws);
    const protocol = new SocketProtocol(socket);
    const client = new ChannelClient(protocol);
    const finish = (event: WebSocketConnectionCloseEvent) => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      options?.signal?.removeEventListener("abort", onAbort);
      const error = new Error("WebSocket connection closed");
      error.name = "ConnectionClosed";
      terminalPage?.disconnect(ws);
      client.dispose(error);
      protocol.dispose();
      ws.close();
      if (!settled) reject(error);
      options?.onClose?.(event);
    };
    const onAbort = () => finish({ code: 1000, reason: "cancelled", wasClean: true });
    const deadline = setTimeout(
      () => finish({ code: 1006, reason: "connect-timeout", wasClean: false }),
      options?.connectTimeoutMs ?? 15_000,
    );
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.signal?.aborted) {
      onAbort();
      return;
    }

    ws.addEventListener("error", () => {
      finish({ code: 1006, reason: "transport-error", wasClean: false });
    });
    ws.addEventListener("close", (event) => {
      finish({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });

    ws.addEventListener("open", () => {
      if (closed) return;
      if (terminalPage?.isClosed()) {
        ws.close(STANDALONE_TERMINAL_OWNER_CLOSE_CODE);
        finish({
          code: STANDALONE_TERMINAL_OWNER_CLOSE_CODE,
          reason: "terminal-page-closed",
          wasClean: true,
        });
        return;
      }
      terminalPage?.trackSocket(ws);
      options?.onOpenSocket?.(ws);
      clearTimeout(deadline);
      settled = true;
      // 普通 Web 的 Host 不注册 window-controller；缺省避免选中一个不可用的代理。
      const services = new RemoteServiceAccess(client, {
        exposeWindowController: options?.exposeWindowController ?? false,
        managedWorktreeService: options?.managedWorktreeService ?? false,
      });
      if (!terminalPage) {
        resolve(services);
        return;
      }
      // 首屏挂载在 WS open 时立即完成，不阻塞在终端状态查询；终端作用域就绪仅作用于终端调用。
      terminalPage.beginConnect(ws, services.terminalService, () =>
        client
          .getChannel(ServiceChannels.Terminal)
          .call<StandaloneTerminalOwnerState>("getStandaloneOwnerState", []),
      );
      resolve(withTerminalServiceOverride(services, terminalPage.service));
    });
  });
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean; signal?: AbortSignal } = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  // bridge 只释放传输时，旧 RPC 会永久等待，发送前已 claim 的草稿也无法进入失败恢复。
  // 生命周期由调用方持有；终结时复用 ChannelClient 的统一拒绝，包括等待 Initialize 的请求。
  const dispose = () => client.dispose();
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener("abort", dispose, { once: true });
  return new RemoteServiceAccess(client, options);
}
