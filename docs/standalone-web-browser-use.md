# 独立 HTTP Web Browser Use（`agent.browsers.*`）规格

## 1. 背景与定位

在独立 HTTP Web 模式（`packages/server/src/entry-http.ts`）中，Agent 侧通过 `node_repl` 注入的 `agent.browsers.list()` 调用协议方法 `interaction/browserList`，此前由于 `entry-http.ts` 与 `createServerHostServices` 未接入 `browserControlExecutor`，`zcodeAgentService` 始终返回 `{ browsers: [] }`，导致 `agent.browsers.list()` 为空。

独立 HTTP Web 复用官方受管无头 Chromium，区分两种运行环境：

1. **Desktop 内嵌浏览器（`type: "iab"`）**：仅存在于 Electron Desktop（`WebContentsView` + Main CDP），支持界面可见性、Chrome 导入与用户标签接管；独立 HTTP 服务端不引入 Electron。
2. **独立 HTTP 受管 CDP 运行时（`type: "cdp"`）**：复用官方 `@zcode/adapters/browser` 的 `createManagedCdpBrowserRuntime`，由 `@zcode/server` 受管模块 `server-browser-control` 持有并注入 `createServerHostServices`，为 `agent.browsers.*` 提供真实 headless Chromium / Playwright 执行后端。

独立部署早期预装的外部 `@playwright/mcp` 不服务 `agent.browsers.*`。2026-11-15 官方 Browser Use 网页访问与信息读取验证通过后，移除镜像中的 `/opt/browser-mcp` 安装、专属 CI 探针及当前服务器用户级 `browser` MCP 配置。保留 Chromium、发行包 `agent/node_modules/playwright-core`、Node REPL 与 Browser Use 插件；部署验收脚本直接复用发行包的 `playwright-core`，不再依赖外部 MCP 的间接依赖。

## 2. 所有者与架构边界

```mermaid
flowchart LR
  Agent["Agent CLI (node_repl / browser-client)"] -->|"ZCode Protocol: interaction/browserList & browserExecute"| AgentSvc["packages/services: zcodeAgentService"]
  AgentSvc -->|"BrowserControlExecutor (窄契约)"| Bridge["packages/server/src/browser-control (server-browser-control)"]
  Bridge -->|"BrowserControlPort + AbortSignal"| Runtime["@zcode/adapters/browser: createManagedCdpBrowserRuntime"]
  Runtime -->|"Playwright Chromium (headless, 无 9222 TCP 调试端口)"| Chromium["System Chromium (/usr/bin/chromium)"]
  Entry["packages/server/src/entry-http.ts"] -->|"创建 / 注入 / SIGINT·SIGTERM await close()"| Bridge
  Entry -->|"disposeServiceResourcesAndWait"| AgentSvc
```

- **单所有者原则**：
  - `ManagedCdpBrowserRuntime`（由 `packages/server/src/browser-control` 包装管理，生命周期归 `entry-http.ts`）是独立 HTTP 进程内 headless Chromium 与每会话 `BrowserContext` 的唯一所有者。
  - `packages/services` 仅通过 `BrowserControlExecutor`（即 `BrowserAmbientContextExecutor` 别名）接收并转发 `list` / `execute`，不依赖 `@zcode/adapters` 或 CLI 具体实现。
  - `packages/server` 仅通过 `@zcode/adapters/browser` 公开入口构建 runtime，不修改官方 `@zcode/adapters/browser` 源码，不造平行浏览器框架。
- **启动方式**：不修改 `Dockerfile` 中 `ZCODE_AGENT_SERVER_ARGS_JSON`（保持 `["/app/zcode/agent/zcode.cjs","app-server","--stdio"]`）；`agent.browsers.*` 统一经由服务端的 `interaction/browserList` 与 `interaction/browserExecute` 闭环执行。

## 3. 契约与生命周期规则

### 3.1 启用门禁

- 仅独立 HTTP 入口（`packages/server/src/entry-http.ts`）装配 `server-browser-control`；`packages/zcode-server-cli`（source server / SSH / WSL / Docker 远端核心）、stdio server 与 Desktop Host 行为不变。
- `collectBrowserAmbientContext` 会在每次 prompt 发送前调用 `executor.list(...)`，而受管 runtime 的 `list()` 会按需启动 Chromium（不开放 `--remote-debugging-port=9222` 等 TCP 调试端口，仅使用 Playwright 默认管道）。因此默认仅在独立 Web 兼容模式开启（`ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS === "1"`）或显式设置 `ZCODE_STANDALONE_BROWSER_USE=1` 时启用；设置 `ZCODE_STANDALONE_BROWSER_USE=0` 时显式禁用。

### 3.2 命令与会话隔离规则

1. **Discovery（`list`）**：
   - 调用 `browserControlPort.list({ sessionId, turnId, signal })`，不使用假 descriptor 占位；若无可用 Playwright/Chromium，显式抛出/传播错误，不返回虚假成功。
   - 返回列表经 `@zcode/shared` 的 `browserBackendDescriptorSchema` 校验。
2. **Scoped / Cached 门禁**：
   - `sessionContext === "cached"` 时拒绝创建新浏览器上下文或执行页面命令，显式返回 `ok: false`（`backend_unavailable`）。
   - 受管 CDP descriptor 不声明 `metadata.controlScopes === "1"`，因此 `openScope` / `releaseScope` 请求在桥层显式拒绝（`ok: false`、`backend_unavailable`，`openScope` 附带 `scope: { id: controlScopeId, state: "rejected" }`）。
3. **伪命令转译与取消**：
   - `turnEnded` -> 调用 `port.turnEnded({ sessionId: sessionKey, turnId })`（不再透传进 `port.execute` 返回 `capability_unsupported`）。
   - `closeSession`（`closeTabs !== true`）使旧租约立即失效（旧 `browserId` 后续 `execute`/`cancel`/`close` 均被拒绝或忽略），底层调用 `runtime.releaseSession(sessionKey)` 保留 Playwright `BrowserContext`、已打开页面与 Cookie 进入空闲驻留（受 `maxReleasedSessions` / `releasedSessionIdleTtlMs` 约束），下次同一 `sessionKey` 调用 `list`/`execute` 自动复用原上下文并获得新租约 `browserId`。
   - `closeSession`（`closeTabs === true`）与宿主机生命周期方法 `closeTaskSessions({ workspacePath, workspaceIdentity?, sessionIds })` 使活跃租约失效，并调用底层 `port.closeSession({ sessionId: sessionKey })` 彻底销毁对应 `BrowserContext`。`closeTaskSessions` 仅查找内存中已记录的复合 `sessionKey`，不启动 Chromium 或调用 `list()`；调用底层 `runtime.list` 前先登记追踪键与代次（epoch），若首次 `list` 在途期间收到匹配的关闭请求，立即递增代次并中止在途请求，待 `list` 返回后销毁刚创建的上下文且不签发租约。手动归档（`archiveTask`）、自动归档（`taskAutoArchiveScheduler`）、任务删除（`deleteArchivedTask`/`deleteArchivedTasks` 及 `zcodeTaskIndexSyncer` 删除事实）、归档永久删除（`executeSessionDeletion`）及项目数据清理（`purgeSessionData` 中 `deleted` 会话，含已删 `owned` 子会话、不含 `kept`）成功后统一经 per-`sessionKey` 串行队列触发 `closeTaskSessions`，清理异常仅记 `warn` 不回滚已提交业务状态；`zcodeAgentService` 转发 `interaction/browserList` 与 `interaction/browserExecute` 时将工作区身份归一到所属 CLI runtime 主工作区，使受管 worktree 会话的浏览器上下文与 `closeTaskSessions` 归属一致。
   - `cancelRequest` -> 在桥内查找目标 `command.requestId` 对应的外部 `AbortController` 并触发 `abort()`，返回 `{ ok: true, value: { cancelled }, elapsedMs }`；同时尊重同 `sessionKey` 作用域校验。
4. **会话隔离与重新接入**：
   - 复合键：`sessionKey = JSON.stringify([workspaceKey, remoteSessionId ?? null, clientMode, sessionId])`，隔离工作区、远端会话和客户端模式；底层 `runtime` 统一以稳定的 `sessionKey` 作为 `sessionId`，对外描述符与执行结果继续使用每次租约独立的随机 `browserId`（`lease.id`）。
   - Discovery 只有在真实后端可用后才返回描述符，并为当前会话建立租约。桥层将租约 ID 映射到真实 backend ID 和 generation，执行结果也返回同一租约身份。
   - 普通关闭只释放租约并保留上下文进入空闲驻留；同一历史会话再次 discovery 后获得新租约并沿用原页面/Cookie，旧 `browserId` 不可执行或关闭新租约。`closeTabs: true` 与归档/删除触发的 `closeTaskSessions` 彻底销毁上下文，再次 discovery 为全新空白上下文。无需依赖官方 adapter 的 generation 在正常重启后递增。
5. **结果校验**：
   - `execute()` 返回值经 `@zcode/shared` 的 `browserCommandResultSchema` 校验，避免 `any` 强转掩盖协议字段漂移。

### 3.3 Playwright 加载、Chromium 解析与进程回收

1. **Playwright 解析**：
   - 发行包布局下，`packages/server`（位于 `<root>/server/entry-http.js`）通过相对固定布局 `<root>/agent/zcode.cjs` 使用 `createRequire` 加载已随包 stage 的 `<root>/agent/node_modules/playwright-core`。
   - 本地源码开发模式下从当前包声明依赖 `playwright-core` 加载。
   - 不扫描用户目录或全局任意路径。
2. **Chromium 解析与沙箱**：
   - `server-browser-control`（由 `entry-http.ts` 调用）显式读取 `CHROME_EXECUTABLE_PATH` 环境变量并作为 `executablePath` 传入 `createManagedCdpBrowserRuntime`（官方 `resolveInstalledBrowserExecutable` 本身不读取 `CHROME_EXECUTABLE_PATH`）；未设置时复用 `resolveInstalledBrowserExecutable` 探测 Playwright / 系统常见路径（如 `/usr/bin/chromium`），不在运行时下载浏览器；保持官方 adapter 的启动参数策略。
3. **优雅退出与启动失败清理**：
   - `entry-http.ts` 启动阶段或服务初始化失败时确保回收已创建的 `browserControl`。
   - 监听 `SIGINT` / `SIGTERM`，先关闭 HTTP server 并等待 `disposeServiceResourcesAndWait(services)`，再 `await browserControl.close()` 尝试释放 Chromium 实例后退出。注：官方 `ManagedCdpBrowserRuntime.close()` 内部对 Playwright `browser.close()` 使用有界超时等待（默认 1,500ms），极端挂起场景下可能存在 late-close 超时限制。

## 4. 验收场景

1. **真实 Chromium 与 Services 链路闭环**（无模型调用）：
   - 通过 `createServerHostServices({ browserControlExecutor })` 装配真实 `ServiceCollection`，经 `IZCodeAgentService` 真实处理的 `interaction/browserList` 与 `interaction/browserExecute` 通道验证 `agent.browsers.list()` 返回 `type: "cdp"`。
   - 对本地 HTTP fixture 执行 `newTab` -> `navigate` -> `evaluate` -> `screenshot`，断言真实页面标题/DOM 结果与非空 PNG 字节。
2. **隔离、生命周期与守卫**：
   - 不同 `workspaceKey` / `remoteSessionId` / `clientMode` / `sessionId` 相互隔离，各自 tab 与 DOM 状态互不串线。
   - `sessionContext: "cached"` 拒绝新建 context/执行。
   - `openScope` / `releaseScope` 显式拒绝。
   - `cancelRequest` 中止在途请求并返回取消态。
   - `turnEnded` 正常收尾当轮请求。
   - `closeSession` 后旧租约请求被拒绝；同一历史会话再次 discovery 可正常使用，旧租约的重复关闭不影响新租约。
   - `close()` 可关闭本轮已启动的 Chromium 实例并拒绝后续请求（受官方 adapter 有界关闭等待限制，不宣称极端挂起下强制 kill 全部衍生进程）。
3. **双模式加载验证**：
   - 源码目录模式（declared dependency）与模拟/真实统一发行包布局（`<root>/server` -> `<root>/agent/zcode.cjs` -> `<root>/agent/node_modules/playwright-core`）均能成功加载并驱动真实 Chromium。

## 5. 验证状态

- 本地真实 Chromium、脚本化 app-server 回归 15 项与发行布局加载器校验通过，涵盖服务协议反向请求、页面读写与截图、隔离、取消、关闭和同一历史会话重新接入。
- 代码提交 `ab4ab3ac`（同批含 `ce24c4cf` 清理）随 `29c3c4dc` 通过 GitHub Actions [`43723274317`](https://github.com/uselessbug/ZCode/actions/runs/43723274317) 全量门禁、容器内 `ci-browser` Browser Use 回归与 ARM64 发行镜像构建校验，并发布镜像 `sha-29c3c4dc`（完整 CI 与镜像 digest 证据见[独立 Web 部署与实机验证清单](maintenance/standalone-web-deployment-checklist.md)）。
- 2026-11-15 镜像 `sha-29c3c4dc`（源码 `29c3c4dc0ecfe54b640b40a332a97862619787af`）已部署上线（容器 `healthy`、`restarts: 0`），线上网页访问与读取实测通过且用户确认（具体验证范围与证据见[独立 Web 部署与实机验证清单](maintenance/standalone-web-deployment-checklist.md)）。
- 独立 Browser MCP 已完整移除：
  - **运行时配置与容器镜像均已清理生效且线上实测通过**：2026-11-15 先行从当前服务器配置删除 `mcp.servers.browser`（保留 `mcp.servers.rea` 与官方 `browser-use` 插件）；2026-11-16 提交 `f643ee64` 通过 GitHub Actions [`43789255724`](https://github.com/uselessbug/ZCode/actions/runs/43789255724) 发布 `latest` 与 `sha-f643ee64` 并部署上线，`Dockerfile` `/opt/browser-mcp` 安装、专属 CI 探针及设置页旧文案随本次发布与镜像生效（验收脚本已独立更新为复用发行包 `playwright-core`）。2026-11-16T02:10:54Z 探针确认容器内 `/opt/browser-mcp` 不存在、配置中 `browser` 不存在、官方 `browser-use` 插件开启且发行包 `playwright-core` 可用；同批新容器线上经 `browser-use` -> `agent.browsers` 发现新受管 CDP 并实际访问 `https://example.com/` 读取标题 `Example Domain`、多语正文与 `Learn more` IANA 链接成功（详细证据见[独立 Web 部署与实机验证清单](maintenance/standalone-web-deployment-checklist.md)）。
