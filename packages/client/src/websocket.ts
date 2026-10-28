import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /**
   * 是否暴露 windowControllerService。普通 Web 的 Headless Host 不注册该通道，
   * 默认 false 让 services.windowControllerService 保持 undefined，消费方回退到 zcodeTaskService。
   */
  exposeWindowController?: boolean;
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
    const ws = new WebSocket(wsUrl);
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
      clearTimeout(deadline);
      settled = true;
      options?.onOpenSocket?.(ws);
      // 普通 Web 的 Host 不注册 window-controller；缺省不暴露该代理，避免消费方选中
      // 惰性构造的"看似存在"对象后首次调用才报 Unknown channel。
      resolve(new RemoteServiceAccess(client, { exposeWindowController: options?.exposeWindowController ?? false }));
    });
  });
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean } = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, options);
}
