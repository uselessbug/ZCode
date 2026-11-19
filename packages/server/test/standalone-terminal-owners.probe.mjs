import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    const binPath = realpathSync(join(repoRoot, "node_modules/.bin/esbuild"));
    return await import(pathToFileURL(resolve(dirname(binPath), "../lib/main.js")).href);
  }
}

const esbuild = await loadEsbuild();

async function bundleSourceModules() {
  const virtualEntry = `
    export * from ${JSON.stringify(join(repoRoot, "packages/rpc/src/index.ts"))};
    export {
      STANDALONE_TERMINAL_OWNER_CLOSE_API_PATH,
      STANDALONE_TERMINAL_OWNER_CLOSE_CODE,
      STANDALONE_TERMINAL_OWNER_SUBPROTOCOL,
      STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX,
    } from ${JSON.stringify(join(repoRoot, "packages/shared/src/server-remote.ts"))};
    export { ServiceChannels } from ${JSON.stringify(join(repoRoot, "packages/shared/src/channels.ts"))};
    export {
      createStandaloneTerminalOwners,
      createTerminalScope,
    } from ${JSON.stringify(join(repoRoot, "packages/services/src/terminal/terminalService.ts"))};
    export {
      connectViaWebSocket,
      createStandaloneTerminalPage,
    } from ${JSON.stringify(join(repoRoot, "packages/client/src/websocket.ts"))};
    export { RemoteServiceAccess } from ${JSON.stringify(join(repoRoot, "packages/client/src/remoteServiceAccess.ts"))};
  `;

  const result = await esbuild.build({
    stdin: {
      contents: virtualEntry,
      resolveDir: repoRoot,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    plugins: [
      {
        name: "zcode-workspace-aliases",
        setup(build) {
          build.onResolve({ filter: /^@zcode\/rpc$/ }, () => ({
            path: join(repoRoot, "packages/rpc/src/index.ts"),
          }));
          build.onResolve({ filter: /^@zcode\/shared$/ }, () => ({
            path: "zcode-shared-stub",
            namespace: "probe-stub",
          }));
          build.onResolve({ filter: /^@zcode\/services$/ }, () => ({
            path: "zcode-services-stub",
            namespace: "probe-stub",
          }));
          build.onResolve({ filter: /^#src\/memoryDiagnostics\.js$/ }, () => ({
            path: "memory-diagnostics-stub",
            namespace: "probe-stub",
          }));
          build.onResolve({ filter: /^\.\/terminalProfile\.js$/ }, (args) => {
            if (args.importer.includes("terminalService.ts")) {
              return { path: "terminal-profile-stub", namespace: "probe-stub" };
            }
            return undefined;
          });
          build.onResolve({ filter: /^node-pty$/ }, () => ({
            path: "node-pty-stub",
            namespace: "probe-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "probe-stub" }, async (args) => {
            if (args.path === "zcode-shared-stub") {
              return {
                contents: `
                  export * from ${JSON.stringify(join(repoRoot, "packages/shared/src/server-remote.ts"))};
                  export { ServiceChannels } from ${JSON.stringify(join(repoRoot, "packages/shared/src/channels.ts"))};
                `,
                resolveDir: repoRoot,
                loader: "ts",
              };
            }
            if (args.path === "zcode-services-stub") {
              return {
                contents: `
                  import { ServiceChannels } from ${JSON.stringify(join(repoRoot, "packages/shared/src/channels.ts"))};
                  const desc = (channelName) => ({ channelName });
                  export const IGenUiService = desc(ServiceChannels.GenUi);
                  export const IFileService = desc(ServiceChannels.File);
                  export const IMediaPreviewService = desc(ServiceChannels.MediaPreview);
                  export const IGitService = desc(ServiceChannels.Git);
                  export const IGitCheckpointService = desc(ServiceChannels.GitCheckpoint);
                  export const ISystemService = desc(ServiceChannels.System);
                  export const ITerminalService = desc(ServiceChannels.Terminal);
                  export const ISettingService = desc(ServiceChannels.Setting);
                  export const IOnboardingRecordService = desc(ServiceChannels.OnboardingRecord);
                  export const ICredentialService = desc(ServiceChannels.Credential);
                  export const IBroadcastService = desc(ServiceChannels.Broadcast);
                  export const IZCodeTaskService = desc(ServiceChannels.ZCodeTask);
                  export const IZCodeAgentService = desc(ServiceChannels.ZCodeAgent);
                  export const IZCodeSessionService = desc(ServiceChannels.ZCodeSession);
                  export const IProjectService = desc(ServiceChannels.Project);
                  export const IManagedWorktreeService = desc(ServiceChannels.ManagedWorktrees);
                  export const ITaskGroupService = desc(ServiceChannels.TaskGroups);
                  export const IRemoteProjectService = desc(ServiceChannels.RemoteProjects);
                  export const ICuaPermissionService = desc(ServiceChannels.CuaPermission);
                  export const IConversationShareService = desc(ServiceChannels.ConversationShare);
                  export const IBotsService = desc(ServiceChannels.Bots);
                  export const IFileWatcherService = desc(ServiceChannels.FileWatcher);
                  export const IOAuthService = desc(ServiceChannels.OAuth);
                  export const IModelSelectionService = desc(ServiceChannels.ModelSelection);
                  export const IProviderSettingsService = desc(ServiceChannels.ProviderSettings);
                  export const IProviderProvisioningTargetService = desc(ServiceChannels.ProviderProvisioningTarget);
                  export const ISourceServerWorkspaceService = desc(ServiceChannels.SourceServerWorkspace);
                  export const ISourceServerManagementService = desc(ServiceChannels.SourceServerManagement);
                  export const IDeviceSyncStateService = desc(ServiceChannels.DeviceSyncState);
                  export const IProviderProvisioningStatusService = desc(ServiceChannels.ProviderProvisioningStatus);
                  export const IExtensionsService = desc(ServiceChannels.Extensions);
                  export const IExtensionViewsService = desc(ServiceChannels.ExtensionViews);
                  export const IExtensionGrantsService = desc(ServiceChannels.ExtensionGrants);
                  export const IVoiceInputService = desc(ServiceChannels.VoiceInput);
                  export const IUsageStatsService = desc(ServiceChannels.UsageStats);
                  export const ICodingPlanSubscriptionService = desc(ServiceChannels.CodingPlanSubscription);
                  export const IClientConfigService = desc(ServiceChannels.ClientConfig);
                  export const IClientScenesService = desc(ServiceChannels.ClientScenes);
                  export const ICloudContentService = desc(ServiceChannels.CloudContent);
                  export const IMarketingTouchService = desc(ServiceChannels.MarketingTouch);
                  export const IOffPeakTaskService = desc(ServiceChannels.OffPeakTask);
                  export const IHighspeedCardService = desc(ServiceChannels.HighspeedCard);
                  export const ISkillsService = desc(ServiceChannels.Skills);
                  export const ISkillSyncService = desc(ServiceChannels.SkillSync);
                  export const IUserConfigSyncService = desc(ServiceChannels.UserConfigSync);
                  export const IMcpSyncService = desc(ServiceChannels.McpSync);
                  export const IPluginUiBridgeService = desc(ServiceChannels.PluginUiBridge);
                  export const IPluginUiSamplingService = desc(ServiceChannels.PluginUiSampling);
                  export const IPluginUiAppToolsService = desc(ServiceChannels.PluginUiAppTools);
                  export const IPluginSyncService = desc(ServiceChannels.PluginSync);
                  export const IPluginsService = desc(ServiceChannels.Plugins);
                  export const IPluginManagementService = desc(ServiceChannels.PluginManagement);
                  export const ISubagentsService = desc(ServiceChannels.Subagents);
                  export const ICommandsService = desc(ServiceChannels.Commands);
                  export const IHooksService = desc(ServiceChannels.Hooks);
                  export const IMemoryService = desc(ServiceChannels.Memory);
                  export const IOutputStyleService = desc(ServiceChannels.OutputStyle);
                  export const ISettingsSyncService = desc(ServiceChannels.SettingsSync);
                  export const IFeedbackService = desc(ServiceChannels.Feedback);
                  export const IPromptAttachmentTransferService = desc(ServiceChannels.PromptAttachmentTransfer);
                  export const IWindowControllerService = desc(ServiceChannels.WindowController);
                  export const IWindowProjectService = desc(ServiceChannels.WindowProject);
                  export const IWindowRemoteProjectService = desc(ServiceChannels.WindowRemoteProjects);
                  export const IWindowProjectChangesService = desc(ServiceChannels.WindowProjectChanges);
                `,
                resolveDir: repoRoot,
                loader: "ts",
              };
            }
            if (args.path === "memory-diagnostics-stub") {
              return {
                contents: `export function registerMemoryDiagnosticsProvider() { return { dispose() {} }; }`,
                loader: "js",
              };
            }
            if (args.path === "terminal-profile-stub") {
              return {
                contents: `export function resolveTerminalFontProfile() { return { fontFamily: "monospace", source: "default" }; }`,
                loader: "js",
              };
            }
            return { contents: `export default {};`, loader: "js" };
          });
        },
      },
    ],
  });

  const code = result.outputFiles[0].text;
  const tempDir = mkdtempSync(join(tmpdir(), "zcode-terminal-probe-"));
  const bundlePath = join(tempDir, "bundle.mjs");
  writeFileSync(bundlePath, code, "utf8");
  try {
    return await import(pathToFileURL(bundlePath).href);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const runtime = await bundleSourceModules();
await esbuild.stop?.();
const {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ProxyChannel,
  ServiceChannels,
  STANDALONE_TERMINAL_OWNER_CLOSE_API_PATH,
  STANDALONE_TERMINAL_OWNER_CLOSE_CODE,
  STANDALONE_TERMINAL_OWNER_SUBPROTOCOL,
  STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX,
  createStandaloneTerminalOwners,
  createTerminalScope,
  connectViaWebSocket,
  createStandaloneTerminalPage,
  RemoteServiceAccess,
} = runtime;

function attachWsFrameTransport(socket, onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const closeOnce = (code = 1005) => {
    if (closed) return;
    closed = true;
    onClose(code);
  };
  const sendFrame = (opcode, payload) => {
    if (closed || socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + payloadLen));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + maskLen + payloadLen);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const closePayload = Buffer.alloc(2);
        closePayload.writeUInt16BE(code, 0);
        sendFrame(0x8, closePayload);
        socket.end();
        closeOnce(code);
        return;
      }
      if (opcode === 0x9) {
        sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        onMessage(payload);
      }
    }
  });
  socket.on("close", () => closeOnce(1006));
  socket.on("error", () => closeOnce(1006));
  return {
    sendBinary(buf) {
      sendFrame(0x2, Buffer.from(buf));
    },
    dropUnclean() {
      if (closed) return;
      closed = true;
      socket.destroy();
      onClose(1006);
    },
    terminate() {
      if (closed) return;
      closed = true;
      socket.destroy();
      onClose(1006);
    },
  };
}

function createFakePtyService() {
  let seq = 0;
  const ptys = new Map();
  return {
    ptys,
    emitData(id, data) {
      ptys.get(id)?.data.fire(data);
    },
    triggerNaturalExit(id, code = 0) {
      const pty = ptys.get(id);
      if (!pty) return;
      ptys.delete(id);
      pty.exit.fire(code);
      pty.data.dispose();
      pty.exit.dispose();
    },
    service: {
      async create(params) {
        const id = `pty-${++seq}`;
        ptys.set(id, {
          cwd: params.cwd ?? "/workspace",
          data: new Emitter(),
          exit: new Emitter(),
          writes: [],
        });
        return {
          id,
          shell: "/bin/sh",
          fontFamily: "monospace",
          fontFamilySource: "default",
        };
      },
      async write({ id, data }) {
        const pty = ptys.get(id);
        if (!pty) throw new Error(`Unknown terminal ${id}`);
        pty.writes.push(data);
      },
      async resize() {},
      async dispose({ id }) {
        const pty = ptys.get(id);
        if (!pty) return;
        ptys.delete(id);
        pty.data.dispose();
        pty.exit.dispose();
      },
      async listTerminalIdsUnderPath({ path }) {
        return [...ptys.entries()].filter(([, pty]) => pty.cwd.startsWith(path)).map(([id]) => id);
      },
      onDynamicData(id) {
        const pty = ptys.get(id);
        if (!pty) throw new Error(`Unknown terminal ${id}`);
        return pty.data.event;
      },
      onDynamicExit(id) {
        const pty = ptys.get(id);
        if (!pty) throw new Error(`Unknown terminal ${id}`);
        return pty.exit.event;
      },
    },
  };
}

function parseSubprotocol(header) {
  if (!header) return { kind: "none" };
  const parts = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 1) return { kind: "invalid" };
  const p = parts[0];
  if (p === STANDALONE_TERMINAL_OWNER_SUBPROTOCOL) return { kind: "fresh", raw: p };
  if (p.startsWith(STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX)) {
    const token = p.slice(STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX.length);
    if (/^[A-Za-z0-9_-]{16,128}$/.test(token))
      return { kind: "resume", resumeToken: token, raw: p };
  }
  return { kind: "invalid" };
}

async function startProbeServer({ graceMs = 150 } = {}) {
  const fakePty = createFakePtyService();
  const owners = createStandaloneTerminalOwners({
    graceMs,
    onCleanupError: (err) => {
      throw err;
    },
  });
  const activeTransports = new Set();
  let ownerStateDelayMs = 0;
  let failNextOwnerState = false;
  let afterNextOwnerStateSnapshot = null;

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === STANDALONE_TERMINAL_OWNER_CLOSE_API_PATH) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          owners.disposeByToken(String(parsed?.resumeToken ?? ""));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const subprotocol = parseSubprotocol(req.headers["sec-websocket-protocol"]);
    if (subprotocol.kind === "invalid") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    if (subprotocol.raw) {
      headers.push(`Sec-WebSocket-Protocol: ${subprotocol.raw}`);
    }
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);

    let transport;
    let onFrame = () => {};
    let onTransportClose = () => {};
    transport = attachWsFrameTransport(
      socket,
      (payload) => onFrame(payload),
      (code) => onTransportClose(code),
    );
    activeTransports.add(transport);

    const onData = new Emitter();
    const onClose = new Emitter();
    const onEnd = new Emitter();
    const iSocket = {
      onData: onData.event,
      onClose: onClose.event,
      onEnd: onEnd.event,
      write(buffer) {
        transport.sendBinary(buffer.buffer);
      },
      end() {
        transport.terminate();
      },
      drain() {
        return Promise.resolve();
      },
      dispose() {
        transport.terminate();
      },
    };
    const protocol = new SocketProtocol(iSocket);
    const channelServer = new ChannelServer(protocol, "server");

    let lease = null;
    let legacyScope = null;
    let terminalService;
    if (subprotocol.kind === "fresh" || subprotocol.kind === "resume") {
      lease = owners.bind(subprotocol, fakePty.service, () => transport.terminate());
      const baseTerminal = lease.service;
      terminalService = {
        create: (p) => baseTerminal.create(p),
        write: (p) => baseTerminal.write(p),
        resize: (p) => baseTerminal.resize(p),
        dispose: (p) => baseTerminal.dispose(p),
        listTerminalIdsUnderPath: (p) => baseTerminal.listTerminalIdsUnderPath(p),
        onDynamicData: (id) => baseTerminal.onDynamicData(id),
        onDynamicExit: (id) => baseTerminal.onDynamicExit(id),
        async getStandaloneOwnerState() {
          if (ownerStateDelayMs > 0) {
            await new Promise((r) => setTimeout(r, ownerStateDelayMs));
          }
          if (failNextOwnerState) {
            failNextOwnerState = false;
            throw new Error("Injected terminal owner error");
          }
          const state = await baseTerminal.getStandaloneOwnerState();
          const hook = afterNextOwnerStateSnapshot;
          if (hook) {
            afterNextOwnerStateSnapshot = null;
            queueMicrotask(hook);
          }
          return state;
        },
      };
    } else {
      legacyScope = createTerminalScope(fakePty.service, (err) => {
        throw err;
      });
      terminalService = legacyScope.service;
    }

    channelServer.registerChannel(
      ServiceChannels.Terminal,
      ProxyChannel.fromService(terminalService),
    );
    channelServer.registerChannel(
      ServiceChannels.System,
      ProxyChannel.fromService({ info: async () => ({ ok: true }) }),
    );

    onFrame = (payload) => onData.fire(VSBuffer.wrap(new Uint8Array(payload)));
    onTransportClose = (code) => {
      activeTransports.delete(transport);
      lease?.release({ explicitEnd: code === STANDALONE_TERMINAL_OWNER_CLOSE_CODE });
      legacyScope?.dispose();
      onClose.fire();
      onEnd.fire();
      channelServer.dispose();
      protocol.dispose();
    };
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return {
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    closeApiUrl: `http://127.0.0.1:${port}${STANDALONE_TERMINAL_OWNER_CLOSE_API_PATH}`,
    fakePty,
    owners,
    setOwnerStateDelayMs(ms) {
      ownerStateDelayMs = ms;
    },
    failNextOwnerStateOnce() {
      failNextOwnerState = true;
    },
    onAfterNextOwnerState(fn) {
      afterNextOwnerStateSnapshot = fn;
    },
    dropAllTransportsUnclean() {
      for (const t of Array.from(activeTransports)) t.dropUnclean();
    },
    async close() {
      owners.disposeAll();
      for (const t of Array.from(activeTransports)) t.terminate();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Immediate mount on WS open (not blocked by terminal RPC) + Proxy preservation + scoped terminal failure
{
  const srv = await startProbeServer();
  try {
    srv.setOwnerStateDelayMs(80);
    const pageA = createStandaloneTerminalPage();
    const start = Date.now();
    const services = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageA });
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 60,
      `Expected immediate mount without waiting on terminal RPC, got ${elapsed}ms`,
    );
    assert.equal(
      services instanceof RemoteServiceAccess,
      true,
      "Must preserve RemoteServiceAccess prototype",
    );
    assert.ok(
      "providerProvisioningTargetService" in services,
      "Must preserve non-enumerable properties",
    );

    // Non-terminal RPC works immediately; terminal create waits for owner handshake and succeeds.
    assert.deepEqual(await services.systemService.info(), { ok: true });
    const created = await services.terminalService.create({
      cols: 80,
      rows: 24,
      cwd: "/workspace",
    });
    assert.equal(srv.fakePty.ptys.size, 1);
    const tokenA = pageA.getResumeToken();
    assert.ok(tokenA && tokenA.length >= 16, "Server must return unguessable resumeToken");

    // Scoped terminal failure: when owner handshake fails on a connection, system RPC stays alive, terminal create rejects.
    srv.setOwnerStateDelayMs(0);
    srv.failNextOwnerStateOnce();
    const pageFail = createStandaloneTerminalPage();
    const failServices = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageFail });
    assert.deepEqual(await failServices.systemService.info(), { ok: true });
    await assert.rejects(() => failServices.terminalService.create({ cols: 80, rows: 24 }));
    pageFail.close();

    // Cleanup pageA
    await services.terminalService.dispose({ id: created.id });
    pageA.close();
    await wait(30);
    assert.equal(srv.fakePty.ptys.size, 0);
  } finally {
    await srv.close();
  }
}

// 2. Short reconnect within grace + two independent owners + explicit 4001 close isolation + forged token isolation
{
  const srv = await startProbeServer({ graceMs: 120 });
  try {
    const pageA = createStandaloneTerminalPage();
    const pageB = createStandaloneTerminalPage();

    const svcA1 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageA });
    const svcB = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageB });
    const termA = await svcA1.terminalService.create({ cols: 80, rows: 24, cwd: "/workspace/a" });
    const termB = await svcB.terminalService.create({ cols: 80, rows: 24, cwd: "/workspace/b" });

    assert.notEqual(pageA.getResumeToken(), pageB.getResumeToken());
    assert.deepEqual(await svcA1.terminalService.listTerminalIdsUnderPath({ path: "/workspace" }), [
      termA.id,
    ]);
    assert.deepEqual(await svcB.terminalService.listTerminalIdsUnderPath({ path: "/workspace" }), [
      termB.id,
    ]);

    const receivedA = [];
    pageA.service.onDynamicData(termA.id)((chunk) => receivedA.push(chunk));
    const exitCodesA = [];
    pageA.service.onDynamicExit(termA.id)((code) => exitCodesA.push(code));

    // Unknown/forged token must NOT claim or affect pageA/pageB; gets fresh isolated owner.
    const forgedSubprotocol = `${STANDALONE_TERMINAL_OWNER_SUBPROTOCOL_PREFIX}forged-token-0123456789abcdef`;
    let forgedStatePromise;
    const forgedPage = {
      getSubprotocol: () => forgedSubprotocol,
      getResumeToken: () => undefined,
      isClosed: () => false,
      trackSocket() {},
      beginConnect(_ws, _remote, fetchState) {
        forgedStatePromise = fetchState();
      },
      disconnect() {},
      close() {},
    };
    await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: forgedPage });
    const forgedState = await forgedStatePromise;
    assert.notEqual(forgedState.resumeToken, pageA.getResumeToken());
    assert.notEqual(forgedState.resumeToken, pageB.getResumeToken());
    assert.deepEqual(forgedState.terminalIds, []);
    assert.equal(srv.fakePty.ptys.size, 2);

    // Drop transports uncleanly, reconnect pageA and pageB within grace.
    srv.dropAllTransportsUnclean();
    await wait(30);
    assert.equal(srv.fakePty.ptys.size, 2, "Both PTYs must remain alive during short grace");

    const svcA2 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageA });
    const svcB2 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageB });
    await svcA2.terminalService.write({ id: termA.id, data: "hello-after-reconnect" });
    await wait(20);
    const ptyEntryA = [...srv.fakePty.ptys.entries()].find(([, p]) => p.cwd === "/workspace/a");
    assert.ok(ptyEntryA, "pageA PTY must still exist");
    assert.ok(
      ptyEntryA[1].writes.includes("hello-after-reconnect"),
      "Reconnected pageA must write to same preserved PTY",
    );
    srv.fakePty.emitData(ptyEntryA[0], "output-chunk");
    await wait(20);
    assert.deepEqual(receivedA, ["output-chunk"]);
    assert.deepEqual(exitCodesA, []);

    // Explicit close (4001) on pageA disposes ONLY pageA's PTY; pageB's PTY remains alive.
    pageA.close();
    await wait(30);
    assert.equal(srv.fakePty.ptys.size, 1, "Explicit close on pageA must dispose only pageA PTY");
    await svcB2.terminalService.write({ id: termB.id, data: "still-alive-B" });
    await wait(20);
    assert.ok(
      [...srv.fakePty.ptys.values()].some((p) => p.writes.includes("still-alive-B")),
      "pageB PTY must stay unaffected",
    );

    // Expired disconnect isolation: disconnect pageB and wait past graceMs.
    srv.dropAllTransportsUnclean();
    await wait(180);
    assert.equal(srv.fakePty.ptys.size, 0, "Expired grace must dispose pageB PTY");

    const exitCodesB = [];
    pageB.service.onDynamicExit(termB.id)((code) => exitCodesB.push(code));
    const oldTokenB = pageB.getResumeToken();
    const svcB3 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageB });
    await svcB3.terminalService.listTerminalIdsUnderPath({ path: "/workspace" });
    assert.notEqual(
      pageB.getResumeToken(),
      oldTokenB,
      "Expired token must issue fresh isolated owner",
    );
    assert.deepEqual(exitCodesB, [1], "Stale terminal handle must exit on expired owner");
    pageB.close();
  } finally {
    await srv.close();
  }
}

// 3. Early explicit close while reconnecting (keepalive POST) + track socket on open before owner check + close race
{
  const srv = await startProbeServer({ graceMs: 5_000 });
  try {
    const closeCalls = [];
    const page = createStandaloneTerminalPage({
      onExplicitCloseWithoutOpenSocket(token) {
        closeCalls.push(token);
        void fetch(srv.closeApiUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ resumeToken: token }),
        });
      },
    });
    const svc = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: page });
    await svc.terminalService.create({ cols: 80, rows: 24, cwd: "/workspace" });
    assert.equal(srv.fakePty.ptys.size, 1);

    // Drop WS, then close page while no socket is open -> keepalive close endpoint disposes immediately (before 5s grace!).
    srv.dropAllTransportsUnclean();
    await wait(20);
    page.close();
    await wait(40);
    assert.equal(closeCalls.length, 1);
    assert.equal(
      srv.fakePty.ptys.size,
      0,
      "Keepalive close endpoint must dispose PTY immediately while reconnecting",
    );

    // Close on open BEFORE getStandaloneOwnerState finishes (socket tracked on open, sends 4001 immediately).
    srv.setOwnerStateDelayMs(100);
    const pageEarlyClose = createStandaloneTerminalPage();
    await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageEarlyClose });
    // Close immediately while getStandaloneOwnerState is still in flight; 4001 close frame closes socket on server.
    pageEarlyClose.close();
    srv.setOwnerStateDelayMs(0);
    await wait(40);
    assert.equal(srv.fakePty.ptys.size, 0);

    // Close race: terminal exits right after state1 snapshot, before onDynamicExit subscription arrives.
    const pageRace = createStandaloneTerminalPage();
    const svcRace1 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageRace });
    const raceTerm = await svcRace1.terminalService.create({
      cols: 80,
      rows: 24,
      cwd: "/workspace",
    });
    const raceExits = [];
    pageRace.service.onDynamicExit(raceTerm.id)((code) => raceExits.push(code));

    srv.dropAllTransportsUnclean();
    await wait(20);
    const [ptyId] = [...srv.fakePty.ptys.keys()];
    srv.onAfterNextOwnerState(() => {
      srv.fakePty.triggerNaturalExit(ptyId, 7);
    });
    const svcRace2 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageRace });
    await svcRace2.terminalService.listTerminalIdsUnderPath({ path: "/workspace" });
    await wait(30);
    assert.equal(raceExits.length, 1, "Close race exit must be delivered to local terminal proxy");
    assert.equal(raceExits[0], 7, "Recorded exit code replay should preserve exit code");

    // Second close race: forced dispose (no exit event emitted) between state1 and EventListen -> state2 catches it!
    const raceTerm2 = await svcRace2.terminalService.create({
      cols: 80,
      rows: 24,
      cwd: "/workspace",
    });
    const raceExits2 = [];
    pageRace.service.onDynamicExit(raceTerm2.id)((code) => raceExits2.push(code));
    srv.dropAllTransportsUnclean();
    await wait(20);
    const [ptyId2] = [...srv.fakePty.ptys.keys()];
    srv.onAfterNextOwnerState(() => {
      void srv.fakePty.service.dispose({ id: ptyId2 });
    });
    const svcRace3 = await connectViaWebSocket(srv.wsUrl, { standaloneTerminalPage: pageRace });
    await svcRace3.terminalService.listTerminalIdsUnderPath({ path: "/workspace" });
    await wait(30);
    assert.deepEqual(
      raceExits2,
      [1],
      "Ordered state2 verification must close terminal killed without exit event",
    );
    pageRace.close();
  } finally {
    await srv.close();
  }
}

// 4. Legacy / no-subprotocol /ws gets attachment-local scope with isolated teardown on disconnect
{
  const srv = await startProbeServer({ graceMs: 5_000 });
  try {
    let ws1;
    let ws2;
    const legacy1 = await connectViaWebSocket(srv.wsUrl, {
      onOpenSocket(ws) {
        ws1 = ws;
      },
    });
    const legacy2 = await connectViaWebSocket(srv.wsUrl, {
      onOpenSocket(ws) {
        ws2 = ws;
      },
    });
    const t1 = await legacy1.terminalService.create({ cols: 80, rows: 24, cwd: "/workspace" });
    const t2 = await legacy2.terminalService.create({ cols: 80, rows: 24, cwd: "/workspace" });
    assert.equal(srv.fakePty.ptys.size, 2);
    assert.deepEqual(
      await legacy1.terminalService.listTerminalIdsUnderPath({ path: "/workspace" }),
      [t1.id],
    );
    assert.deepEqual(
      await legacy2.terminalService.listTerminalIdsUnderPath({ path: "/workspace" }),
      [t2.id],
    );

    // Disconnect legacy1 only -> only t1 is torn down immediately; t2 stays alive.
    ws1.close();
    await wait(30);
    assert.equal(srv.fakePty.ptys.size, 1, "Disconnecting legacy1 must tear down only legacy1 PTY");
    assert.deepEqual(
      await legacy2.terminalService.listTerminalIdsUnderPath({ path: "/workspace" }),
      [t2.id],
    );
    ws2.close();
    await wait(30);
    assert.equal(srv.fakePty.ptys.size, 0, "Disconnecting legacy2 must tear down legacy2 PTY");
  } finally {
    await srv.close();
  }
}

console.log("STANDALONE_TERMINAL_OWNERS_PROBE_OK");
