# server-browser-control

独立 HTTP Web 服务端的受管无头 Chromium 执行桥（适配 `@zcode/services/node` 的 `BrowserControlExecutor` 到 `@zcode/adapters/browser` 的 `createManagedCdpBrowserRuntime`）。

不变量：

- 仅由独立 HTTP 入口（`packages/server/src/entry-http.ts`）按启用策略创建并注入，不改变 source server / SSH / stdio / Desktop 行为。
- 复用 `@zcode/adapters/browser` 公开入口与系统 Chromium，不在 `packages/server` 另造浏览器框架或引入 Electron。
- 发行包布局下经 `../agent/zcode.cjs` 的 `createRequire` 加载随包 stage 的 `agent/node_modules/playwright-core`；源码开发模式下从声明依赖加载，不扫描用户目录。
- 生命周期命令（`cancelRequest` / `turnEnded` / `closeSession`）优先分流，不被 `sessionContext === "cached"` 拦截；`turnEnded` 与 `closeSession` 调用 port 方法，`cancelRequest` 经 `requestId` 对应的 `AbortController` 取消。
- 无 `controlScopes` 能力时显式拒绝 `openScope` / `releaseScope`。
- 复合会话键 `JSON.stringify([workspaceKey, remoteSessionId ?? null, clientMode, sessionId])` 隔离工作区、远端会话和客户端模式。Discovery 为当前会话建立浏览器租约；关闭会话释放租约，后续 discovery 可以重新建立。租约 ID 随真实 backend descriptor 返回，旧租约的命令及清理请求不能操作新租约。
- 启动失败与 `SIGINT`/`SIGTERM` 退出路径均等待 `close()` 收口。
