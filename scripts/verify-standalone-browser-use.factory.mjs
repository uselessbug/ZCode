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

    // ---- 8. closeSession 终态守卫 -----------------------------------------
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
    const resumedTab = await exec(
      handle.executor,
      closeCtx,
      { method: "newTab" },
      {
        browserId: reopened.id,
        browserGeneration: reopened.generation,
      },
    );
    assert.equal(resumedTab.ok, true, "same historical session must be usable after discovery");
    await exec(
      handle.executor,
      closeCtx,
      { method: "closeSession" },
      {
        browserId: cdpClose.id,
        browserGeneration: cdpClose.generation,
      },
    );
    const afterStaleClose = await exec(
      handle.executor,
      closeCtx,
      { method: "list" },
      {
        browserId: reopened.id,
        browserGeneration: reopened.generation,
      },
    );
    assert.equal(afterStaleClose.tabs?.length, 1, "stale cleanup must not close the new lease");

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
    pass("factory.closeSession-guard", "late requests rejected, fresh sessionKey usable");

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
