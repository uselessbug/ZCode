# server-browser-control

独立 HTTP Web 服务端的受管无头 Chromium 执行桥（适配 `@zcode/services/node` 的 `BrowserControlExecutor` 到 `@zcode/adapters/browser` 的 `createManagedCdpBrowserRuntime`）。

不变量：

- 仅由独立 HTTP 入口（`packages/server/src/entry-http.ts`）按启用策略创建并注入，不改变 source server / SSH / stdio / Desktop 行为。
- 复用 `@zcode/adapters/browser` 公开入口与系统 Chromium，不在 `packages/server` 另造浏览器框架或引入 Electron。
- 发行包布局下经 `../agent/zcode.cjs` 的 `createRequire` 加载随包 stage 的 `agent/node_modules/playwright-core`；源码开发模式下从声明依赖加载，不扫描用户目录。
- 生命周期命令（`cancelRequest` / `turnEnded` / `closeSession`）优先分流，不被 `sessionContext === "cached"` 拦截；`turnEnded` 与 `closeSession` 调用 port 方法，`cancelRequest` 经 `requestId` 对应的 `AbortController` 取消。
- 无 `controlScopes` 能力时显式拒绝 `openScope` / `releaseScope`。
- 复合会话键 `JSON.stringify([workspaceKey, remoteSessionId ?? null, clientMode, sessionId])` 隔离工作区、远端会话和客户端模式。底层 `runtime` 以稳定的复合 `sessionKey` 作为 `sessionId`，而对外 descriptor 与结果中的 `browserId` 仍保持每次租约独立的随机 `lease.id`。
- `closeSession` 在 `closeTabs !== true` 时立即使旧租约失效并调用 `runtime.releaseSession(sessionKey)` 保留 `BrowserContext`、页面与 Cookie 进入空闲驻留（受 `maxReleasedSessions` / `releasedSessionIdleTtlMs` 限制），同一会话下次 discovery 获得新 `browserId` 并自动复用原上下文；`closeTabs === true` 时失效租约并调用 `runtime.closeSession(sessionKey)` 彻底关闭上下文。
- `executor.closeTaskSessions({ workspacePath, workspaceIdentity?, sessionIds })` 按内存中已登记的复合 `sessionKey` 查找匹配会话（绝不启动 Chromium 或调用 `list()`），失效活跃租约并彻底调用 `runtime.closeSession(sessionKey)` 销毁上下文，供归档、任务删除、永久删除与项目数据清理成功后回收。首次 `list` 在途之前即登记追踪键与代次，在途期间触发 `closeTaskSessions` 或 `closeTabs: true` 时递增代次并中止在途请求，`list` 晚到返回时立即清理已创建的上下文且不签发租约。
- 启动失败与 `SIGINT`/`SIGTERM` 退出路径均等待 `close()` 收口。
