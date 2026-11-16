import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

export function makeContext(overrides = {}) {
  return {
    requestId: randomUUID(),
    sessionId: "session-default",
    turnId: "turn-1",
    workspaceKey: "workspace-default",
    workspacePath: "/tmp/verify-standalone-browser-use",
    clientMode: "web-remote-replayable",
    sessionContext: "live",
    ...overrides,
  };
}

export function isPngBase64(base64) {
  if (typeof base64 !== "string" || base64.length === 0) return false;
  const head = Buffer.from(base64.slice(0, 16), "base64");
  return (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  );
}

export async function listCdp(executor, context) {
  const descriptors = await executor.list(context);
  assert.ok(Array.isArray(descriptors), "list must return an array");
  const cdp = descriptors.find((descriptor) => descriptor.type === "cdp");
  assert.ok(cdp, `list must expose a cdp backend, got ${JSON.stringify(descriptors)}`);
  assert.equal(typeof cdp.id, "string");
  assert.equal(typeof cdp.generation, "number");
  assert.equal(cdp.name, "ZCode Headless Chromium");
  return cdp;
}

export function exec(executor, context, command, extra = {}) {
  return executor.execute({ ...context, ...extra, command });
}

// ---------------------------------------------------------------------------
// Phase: 真实工厂 + 真实 Chromium 全链路回归
// ---------------------------------------------------------------------------

export async function verifyFactoryRealBrowser(factoryModule, playwright, fixtureUrl, reporting) {
  const { pass, gap, CHROMIUM, FIXTURE_TITLE } = reporting;
  const handle = factoryModule.createServerBrowserControl({
    executablePath: CHROMIUM,
    loadPlaywright: async () => playwright,
  });

  const baseline = countChromiumProcesses();
  try {
    // ---- 1. list -> cdp ---------------------------------------------------
    const ctxA = makeContext({
      sessionId: "session-A",
      workspaceKey: "workspace-A",
      turnId: "turn-A",
    });
    const cdpA = await listCdp(handle.executor, ctxA);
    pass("factory.list", `type=cdp id=${cdpA.id} generation=${cdpA.generation}`);

    // ---- 2. newTab -> navigate -> evaluate -> locator fill/click -> screenshot
    const tabA = await exec(
      handle.executor,
      ctxA,
      { method: "newTab" },
      {
        browserId: cdpA.id,
        browserGeneration: cdpA.generation,
      },
    );
    assert.equal(tabA.ok, true, `newTab failed: ${JSON.stringify(tabA)}`);
    const tabIdA = tabA.tab?.tabId;
    assert.ok(tabIdA, "newTab must return tab.tabId");

    const navA = await exec(
      handle.executor,
      ctxA,
      {
        method: "navigate",
        url: fixtureUrl,
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(navA.ok, true, `navigate failed: ${JSON.stringify(navA)}`);
    assert.equal(navA.state?.title, FIXTURE_TITLE, "navigate must land on real fixture title");

    const titleA = await exec(
      handle.executor,
      ctxA,
      {
        method: "evaluate",
        expression: "document.title",
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(titleA.ok, true);
    assert.equal(titleA.value, FIXTURE_TITLE, "evaluate must read real DOM title");

    const fillA = await exec(
      handle.executor,
      ctxA,
      {
        method: "playwright",
        action: { name: "locator", selector: "#name", operation: "fill", value: "world" },
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(fillA.ok, true, `locator fill failed: ${JSON.stringify(fillA)}`);

    const clickA = await exec(
      handle.executor,
      ctxA,
      {
        method: "playwright",
        action: { name: "locator", selector: "#go", operation: "click" },
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(clickA.ok, true, `locator click failed: ${JSON.stringify(clickA)}`);

    const outA = await exec(
      handle.executor,
      ctxA,
      {
        method: "evaluate",
        expression: "document.getElementById('out').textContent",
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(outA.value, "hello world", "locator fill+click must drive real DOM handler");

    const shotA = await exec(
      handle.executor,
      ctxA,
      {
        method: "screenshot",
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(shotA.ok, true, `screenshot failed: ${JSON.stringify(shotA)}`);
    assert.equal(shotA.image?.mimeType, "image/png");
    assert.ok(isPngBase64(shotA.image?.base64), "screenshot must be a non-empty PNG");
    pass(
      "factory.real-browser-chain",
      `newTab->navigate->evaluate->locator.fill/click->screenshot ok (png=${Math.round((shotA.image.base64.length * 3) / 4)}B)`,
    );

    // ---- 3. 会话/路由隔离 -------------------------------------------------
    const ctxB = makeContext({
      sessionId: "session-B",
      workspaceKey: "workspace-B",
      turnId: "turn-B",
    });
    const cdpB = await listCdp(handle.executor, ctxB);
    const tabB = await exec(
      handle.executor,
      ctxB,
      { method: "newTab" },
      {
        browserId: cdpB.id,
        browserGeneration: cdpB.generation,
      },
    );
    assert.equal(tabB.ok, true);
    const tabIdB = tabB.tab?.tabId;
    assert.notEqual(tabIdB, tabIdA, "different sessionKey must own a different tab");

    await exec(
      handle.executor,
      ctxB,
      {
        method: "navigate",
        url: `${fixtureUrl}?b=1`,
        tabId: tabIdB,
      },
      { browserId: cdpB.id, browserGeneration: cdpB.generation },
    );
    const searchB = await exec(
      handle.executor,
      ctxB,
      {
        method: "evaluate",
        expression: "document.location.search",
        tabId: tabIdB,
      },
      { browserId: cdpB.id, browserGeneration: cdpB.generation },
    );
    assert.equal(searchB.value, "?b=1");

    // B 的导航/输入不得串到 A。
    const outAStill = await exec(
      handle.executor,
      ctxA,
      {
        method: "evaluate",
        expression: "document.getElementById('out').textContent",
        tabId: tabIdA,
      },
      { browserId: cdpA.id, browserGeneration: cdpA.generation },
    );
    assert.equal(outAStill.value, "hello world", "session A DOM must stay isolated from B");

    // 同一 sessionId、不同 clientMode -> 不同 sessionKey，仍隔离。
    const ctxRoute = makeContext({
      sessionId: "session-A",
      workspaceKey: "workspace-A",
      clientMode: "desktop-continuous",
    });
    const cdpRoute = await listCdp(handle.executor, ctxRoute);
    const tabRoute = await exec(
      handle.executor,
      ctxRoute,
      { method: "newTab" },
      {
        browserId: cdpRoute.id,
        browserGeneration: cdpRoute.generation,
      },
    );
    assert.notEqual(
      tabRoute.tab?.tabId,
      tabIdA,
      "same sessionId with different clientMode must be isolated",
    );
    const routeTabs = await exec(
      handle.executor,
      ctxRoute,
      { method: "list" },
      {
        browserId: cdpRoute.id,
        browserGeneration: cdpRoute.generation,
      },
    );
    assert.equal(routeTabs.tabs?.length, 1, "different route must not see session A tabs");
    pass("factory.session-isolation", "workspaceKey / clientMode routes isolated");

    // ---- 4. cached 拒绝 ---------------------------------------------------
    const cachedList = await handle.executor.list(
      makeContext({ sessionId: "session-cached", sessionContext: "cached" }),
    );
    assert.deepEqual(cachedList, [], "cached list must return no browsers");
    const cachedExec = await exec(
      handle.executor,
      makeContext({ sessionId: "session-cached", sessionContext: "cached" }),
      { method: "newTab" },
    );
    assert.equal(cachedExec.ok, false);
    assert.equal(cachedExec.error?.code, "backend_unavailable");
    pass("factory.cached-rejected", "cached list=[] and execute backend_unavailable");

    // ---- 5. openScope / releaseScope 拒绝 ---------------------------------
    const openScope = await exec(
      handle.executor,
      ctxA,
      { method: "openScope" },
      { controlScopeId: "scope-1" },
    );
    assert.equal(openScope.ok, false);
    assert.equal(openScope.error?.code, "backend_unavailable");
    assert.equal(openScope.scope?.id, "scope-1");
    assert.equal(openScope.scope?.state, "rejected");
    const releaseScope = await exec(handle.executor, ctxA, { method: "releaseScope" });
    assert.equal(releaseScope.ok, false);
    assert.equal(releaseScope.error?.code, "backend_unavailable");
    pass("factory.scopes-rejected", "openScope/releaseScope rejected with scope.state=rejected");

    // ---- 6. cancelRequest 中止在途请求 ------------------------------------
    const cancelCtx = makeContext({
      sessionId: "session-A",
      workspaceKey: "workspace-A",
      turnId: "turn-cancel",
    });
    const inFlight = exec(
      handle.executor,
      cancelCtx,
      {
        method: "playwrightWaitForTimeout",
        timeoutMs: 8000,
        tabId: tabIdA,
      },
      {
        requestId: "req-cancel",
        browserId: cdpA.id,
        browserGeneration: cdpA.generation,
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    const cancelResult = await exec(handle.executor, cancelCtx, {
      method: "cancelRequest",
      requestId: "req-cancel",
    });
    assert.equal(cancelResult.ok, true);
    assert.equal(cancelResult.value?.cancelled, true, "cancelRequest must report cancelled");
    const cancelled = await inFlight;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error?.code, "cancelled", "in-flight request must be aborted");
    pass("factory.cancelRequest", "in-flight aborted, cancelled=true");

    // ---- 7. turnEnded 收尾当轮 --------------------------------------------
    const turnCtx = makeContext({
      sessionId: "session-A",
      workspaceKey: "workspace-A",
      turnId: "turn-end",
    });
    const inFlightTurn = exec(
      handle.executor,
      turnCtx,
      {
        method: "playwrightWaitForTimeout",
        timeoutMs: 8000,
        tabId: tabIdA,
      },
      {
        requestId: "req-turn",
        browserId: cdpA.id,
        browserGeneration: cdpA.generation,
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    const turnEnded = await exec(handle.executor, turnCtx, {
      method: "turnEnded",
      turnId: "turn-end",
    });
    assert.equal(turnEnded.ok, true);
    const turnCancelled = await inFlightTurn;
    assert.equal(turnCancelled.ok, false);
    assert.equal(turnCancelled.error?.code, "cancelled");
    pass("factory.turnEnded", "turn-scoped in-flight aborted");

    // ---- 8. closeSession 释放保持上下文 vs closeTabs / closeTaskSessions 彻底销毁 ----
    const closeCtx = makeContext({
      sessionId: "session-close",
      workspaceKey: "workspace-A",
    });
    const cdpClose = await listCdp(handle.executor, closeCtx);
    const tabClose = await exec(
      handle.executor,
      closeCtx,
      { method: "newTab" },
      {
        browserId: cdpClose.id,
        browserGeneration: cdpClose.generation,
      },
    );
    assert.equal(tabClose.ok, true);
    const navClose = await exec(
      handle.executor,
      closeCtx,
      { method: "navigate", url: fixtureUrl, tabId: tabClose.tab?.tabId },
      { browserId: cdpClose.id, browserGeneration: cdpClose.generation },
    );
    assert.equal(navClose.ok, true);
    const cookieSet = await exec(
      handle.executor,
      closeCtx,
      {
        method: "evaluate",
        expression: "document.cookie = 'zcode_keep=1; path=/'; document.cookie",
        tabId: tabClose.tab?.tabId,
      },
      { browserId: cdpClose.id, browserGeneration: cdpClose.generation },
    );
    assert.equal(cookieSet.ok, true);
    assert.match(String(cookieSet.value ?? ""), /zcode_keep=1/);

    // 普通 closeSession（不带 closeTabs）：旧租约失效，但底层 BrowserContext 与页面/Cookie 保留。
    const closeResult = await exec(handle.executor, closeCtx, { method: "closeSession" });
    assert.equal(closeResult.ok, true, "closeSession must succeed");

    const lateExec = await exec(
      handle.executor,
      closeCtx,
      { method: "newTab" },
      {
        browserId: cdpClose.id,
        browserGeneration: cdpClose.generation,
      },
    );
    assert.equal(lateExec.ok, false, "late request after closeSession must be rejected");
    assert.equal(lateExec.error?.code, "backend_unavailable");
    assert.match(lateExec.error?.message ?? "", /unavailable/i);

    const reopened = await listCdp(handle.executor, closeCtx);
    assert.notEqual(reopened.id, cdpClose.id, "resumed session must get a new browser lease");
    await exec(
      handle.executor,
      closeCtx,
      { method: "closeSession" },
      {
        browserId: cdpClose.id,
        browserGeneration: cdpClose.generation,
      },
    );
    const afterReopenTabs = await exec(
      handle.executor,
      closeCtx,
      { method: "list" },
      {
        browserId: reopened.id,
        browserGeneration: reopened.generation,
      },
    );
    assert.equal(afterReopenTabs.tabs?.length, 1, "normal closeSession must preserve open tabs");
    const cookiePreserved = await exec(
      handle.executor,
      closeCtx,
      {
        method: "evaluate",
        expression: "document.cookie",
        tabId: afterReopenTabs.tabs?.[0]?.tabId,
      },
      {
        browserId: reopened.id,
        browserGeneration: reopened.generation,
      },
    );
    assert.match(
      String(cookiePreserved.value ?? ""),
      /zcode_keep=1/,
      "normal closeSession must preserve cookies across leases",
    );

    // closeSession({ closeTabs: true }) 彻底销毁上下文，再 list 为全新空白上下文。
    const closeTabsResult = await exec(
      handle.executor,
      closeCtx,
      { method: "closeSession", closeTabs: true },
      {
        browserId: reopened.id,
        browserGeneration: reopened.generation,
      },
    );
    assert.equal(closeTabsResult.ok, true);
    const afterCloseTabs = await listCdp(handle.executor, closeCtx);
    assert.notEqual(afterCloseTabs.id, reopened.id);
    const afterCloseTabsList = await exec(
      handle.executor,
      closeCtx,
      { method: "list" },
      {
        browserId: afterCloseTabs.id,
        browserGeneration: afterCloseTabs.generation,
      },
    );
    assert.equal(
      afterCloseTabsList.tabs?.length,
      0,
      "closeTabs=true must destroy BrowserContext and yield a blank context on next list",
    );

    // closeTaskSessions：同时覆盖“已普通释放入池”与“活跃租约”两种上下文，彻底关闭。
    const taskTab = await exec(
      handle.executor,
      closeCtx,
      { method: "newTab" },
      {
        browserId: afterCloseTabs.id,
        browserGeneration: afterCloseTabs.generation,
      },
    );
    assert.equal(taskTab.ok, true);
    await exec(handle.executor, closeCtx, { method: "closeSession" });
    await handle.executor.closeTaskSessions?.({
      workspacePath: closeCtx.workspacePath,
      sessionIds: [closeCtx.sessionId],
    });
    const afterTaskDestroy = await listCdp(handle.executor, closeCtx);
    const afterTaskDestroyList = await exec(
      handle.executor,
      closeCtx,
      { method: "list" },
      {
        browserId: afterTaskDestroy.id,
        browserGeneration: afterTaskDestroy.generation,
      },
    );
    assert.equal(
      afterTaskDestroyList.tabs?.length,
      0,
      "closeTaskSessions must destroy released BrowserContext",
    );

    // 活跃态 closeTaskSessions：失效活跃租约并彻底销毁上下文。
    await exec(
      handle.executor,
      closeCtx,
      { method: "newTab" },
      {
        browserId: afterTaskDestroy.id,
        browserGeneration: afterTaskDestroy.generation,
      },
    );
    await handle.executor.closeTaskSessions?.({
      workspacePath: closeCtx.workspacePath,
      sessionIds: [closeCtx.sessionId],
    });
    const lateAfterDestroy = await exec(
      handle.executor,
      closeCtx,
      { method: "list" },
      {
        browserId: afterTaskDestroy.id,
        browserGeneration: afterTaskDestroy.generation,
      },
    );
    assert.equal(lateAfterDestroy.ok, false);
    assert.equal(lateAfterDestroy.error?.code, "backend_unavailable");
    const afterActiveDestroy = await listCdp(handle.executor, closeCtx);
    const afterActiveDestroyList = await exec(
      handle.executor,
      closeCtx,
      { method: "list" },
      {
        browserId: afterActiveDestroy.id,
        browserGeneration: afterActiveDestroy.generation,
      },
    );
    assert.equal(
      afterActiveDestroyList.tabs?.length,
      0,
      "closeTaskSessions on active lease must yield a blank context on next list",
    );

    // 新 sessionKey 独立可用（不复活旧会话）。
    const freshCtx = makeContext({
      sessionId: "session-fresh",
      workspaceKey: "workspace-A",
    });
    const cdpFresh = await listCdp(handle.executor, freshCtx);
    const freshTab = await exec(
      handle.executor,
      freshCtx,
      { method: "newTab" },
      {
        browserId: cdpFresh.id,
        browserGeneration: cdpFresh.generation,
      },
    );
    assert.equal(freshTab.ok, true, "a fresh sessionKey must remain usable");
    pass(
      "factory.closeSession-guard",
      "release preserves context/cookie; closeTabs & closeTaskSessions destroy context; fresh sessionKey usable",
    );

    // 无浏览器上下文会话调用 closeTaskSessions 不得启动 Chromium。
    const coldHandle = factoryModule.createServerBrowserControl({
      executablePath: CHROMIUM,
      loadPlaywright: async () => playwright,
    });
    try {
      const beforeCold = countChromiumProcesses();
      await coldHandle.executor.closeTaskSessions?.({
        workspacePath: "/tmp/never-opened-workspace",
        sessionIds: ["never-opened-session"],
      });
      assert.ok(
        beforeCold < 0 || countChromiumProcesses() <= beforeCold,
        "closeTaskSessions must not launch Chromium for untouched sessions",
      );
      pass("factory.closeTaskSessions-no-launch", "closeTaskSessions does not launch Chromium");
    } finally {
      await coldHandle.close().catch(() => {});
    }

    // ---- 9. close() 清理 --------------------------------------------------
    await handle.close();
    let disposed = false;
    try {
      await handle.executor.list(makeContext({ sessionId: "session-after-close" }));
    } catch {
      disposed = true;
    }
    assert.ok(disposed, "executor.list after close() must throw");
    const reaped = await waitForChromiumReap(baseline);
    if (!reaped) {
      gap(
        "factory.close-process-reap",
        `chromium process count did not return to baseline (baseline=${baseline}, now=${countChromiumProcesses()})`,
      );
    } else {
      pass("factory.close", `disposed + chromium reaped (baseline=${baseline})`);
    }

    // ---- 10. 首次 list 在途并发 closeTaskSessions 与新 list 交错竞态 --------
    // 挂起旧 list -> closeTaskSessions -> 发起新 list 并 execute 打开页面 -> 放行旧 list：
    // 旧 list 被取消，closeTaskSessions 仅销毁旧上下文，新租约的上下文与页面完好存活。
    {
      let enteredLoad = 0;
      let releaseLoad;
      const loadEntered = new Promise((r) => {
        releaseLoad = r;
      });
      let releasePlaywright;
      const playwrightGate = new Promise((r) => {
        releasePlaywright = r;
      });
      const raceHandle = factoryModule.createServerBrowserControl({
        executablePath: CHROMIUM,
        loadPlaywright: async () => {
          enteredLoad += 1;
          if (enteredLoad === 1) {
            releaseLoad();
            await playwrightGate;
          }
          return playwright;
        },
      });
      const raceCtx = makeContext({
        sessionId: "session-race-list",
        workspaceKey: "workspace-race",
        workspacePath: "/tmp/verify-standalone-browser-race",
      });
      const beforeRace = countChromiumProcesses();
      try {
        // 10a. 同一事件循环无 await 间隔紧接调用 list() -> closeTaskSessions()：
        // 同步登记保证首次发现尚未进入队列微任务槽位也能被立即取消且不签发租约。
        const syncRaceCtx = makeContext({
          sessionId: "session-sync-race-list",
          workspaceKey: "workspace-race",
          workspacePath: "/tmp/verify-standalone-browser-race",
          requestId: "req-sync-race",
        });
        const syncListing = raceHandle.executor.list(syncRaceCtx);
        await raceHandle.executor.closeTaskSessions?.({
          workspacePath: syncRaceCtx.workspacePath,
          sessionIds: [syncRaceCtx.sessionId],
        });
        await assert.rejects(
          syncListing,
          /cancelled/i,
          "zero-await list -> closeTaskSessions must cancel first discovery",
        );

        const listFlight = raceHandle.executor.list(raceCtx);
        await loadEntered;
        assert.equal(enteredLoad, 1);
        // 挂起旧 list -> 并发 closeTaskSessions -> 立即发起新 list
        const closeFlight = raceHandle.executor.closeTaskSessions?.({
          workspacePath: raceCtx.workspacePath,
          sessionIds: [raceCtx.sessionId],
        });
        const newListCtx = makeContext({
          ...raceCtx,
          requestId: "req-new-after-close-race",
        });
        const newListFlight = raceHandle.executor.list(newListCtx);
        // 放行旧 list：旧 list 必须取消，新 list 必须拿到全新可用租约并保持存活
        releasePlaywright();
        await assert.rejects(
          listFlight,
          /cancelled/i,
          "in-flight list invalidated by closeTaskSessions must reject",
        );
        await closeFlight;
        const newDescriptors = await newListFlight;
        const newCdp = newDescriptors.find((d) => d.type === "cdp");
        assert.ok(newCdp, "new list after closeTaskSessions must obtain a valid cdp lease");
        const tabRace = await exec(
          raceHandle.executor,
          { ...newListCtx, requestId: randomUUID() },
          { method: "newTab" },
          { browserId: newCdp.id, browserGeneration: newCdp.generation },
        );
        assert.equal(tabRace.ok, true, `newTab failed: ${JSON.stringify(tabRace)}`);
        const navRace = await exec(
          raceHandle.executor,
          { ...newListCtx, requestId: randomUUID() },
          { method: "navigate", url: fixtureUrl, tabId: tabRace.tab?.tabId },
          { browserId: newCdp.id, browserGeneration: newCdp.generation },
        );
        assert.equal(navRace.ok, true, `navigate failed: ${JSON.stringify(navRace)}`);
        const evalRace = await exec(
          raceHandle.executor,
          { ...newListCtx, requestId: randomUUID() },
          { method: "evaluate", expression: "document.title", tabId: tabRace.tab?.tabId },
          { browserId: newCdp.id, browserGeneration: newCdp.generation },
        );
        assert.equal(
          evalRace.value,
          FIXTURE_TITLE,
          "new lease page must stay alive after old list settles",
        );
        const listStillAlive = await exec(
          raceHandle.executor,
          { ...newListCtx, requestId: randomUUID() },
          { method: "list" },
          { browserId: newCdp.id, browserGeneration: newCdp.generation },
        );
        assert.equal(
          listStillAlive.tabs?.length,
          1,
          "new lease tab must not be closed by late old list",
        );

        // 彻底关闭并确认进程回收
        await raceHandle.executor.closeTaskSessions?.({
          workspacePath: raceCtx.workspacePath,
          sessionIds: [raceCtx.sessionId],
        });
        const reapedRace = await waitForChromiumReap(beforeRace < 0 ? 0 : beforeRace);
        assert.equal(
          reapedRace,
          true,
          "browser context after closeTaskSessions must be cleaned up",
        );
        pass(
          "factory.closeTaskSessions-inflight-list-race",
          "old list cancelled -> closeTaskSessions -> new list & page stay alive without late close",
        );
      } finally {
        releasePlaywright?.();
        await raceHandle.close().catch(() => {});
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function countChromiumProcesses() {
  try {
    const output = execFileSync("ps", ["-eo", "args", "--no-headers"], {
      encoding: "utf8",
    });
    return output.split("\n").filter((line) => /chromium/i.test(line) && !/ps -eo/i.test(line))
      .length;
  } catch {
    return -1;
  }
}

async function waitForChromiumReap(baseline, timeoutMs = 8000) {
  if (baseline < 0) return true; // ps 不可用，跳过进程计数断言（不误报）
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countChromiumProcesses() <= baseline) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return countChromiumProcesses() <= baseline;
}
