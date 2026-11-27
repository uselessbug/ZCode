// 独立 HTTP Browser Use 的「脚本化 app-server」fixture。
//
// 被 verify-standalone-browser-use.mjs 通过 createLocalServices 的 zcodeAgentCommandResolver 拉起，
// 用来在真实 services -> zcodeAgentService 链路上触发 interaction/browserList 与
// interaction/browserExecute 反向请求，验证 browserControlExecutor 的真实注入与到达。
//
// 它只做最小协议响应与反向请求，不伪造被测执行器行为；断言在父进程读取的日志上完成。
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logFile = process.env.ZCODE_BSBROWSER_LOG;
const workspacePath = process.env.ZCODE_BSBROWSER_WS;
const workspaceIdentity = process.env.ZCODE_BSBROWSER_ID;
const fixtureUrl = process.env.ZCODE_BSBROWSER_URL;

const log = (payload) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(payload)}\n`);
};
const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

log({ step: "boot", pid: process.pid });

let nextId = 1;
const pending = new Map();
const request = (method, params) => {
  const id = `stub-${nextId++}`;
  return new Promise((resolveRequest) => {
    pending.set(id, resolveRequest);
    send({ id, method, params });
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let launched = false;

async function driveBrowser() {
  if (launched) return;
  launched = true;
  const common = {
    sessionId: "stub-session",
    turnId: "stub-turn",
    workspaceKey: workspaceIdentity,
    workspacePath,
    workspaceIdentity,
    clientMode: "web-remote-replayable",
    sessionContext: "live",
  };
  try {
    let cdp;
    for (let attempt = 1; attempt <= 12 && !cdp; attempt += 1) {
      const listResponse = await request("interaction/browserList", {
        requestId: `stub-req-list-${attempt}`,
        ...common,
      });
      const result = listResponse?.result;
      const errorMessage = listResponse?.error?.message;
      cdp = (result?.browsers ?? []).find((candidate) => candidate.type === "cdp");
      if (cdp) {
        log({ step: "list-ok", response: listResponse });
      } else {
        log({ step: "list-retry", attempt, error: errorMessage ?? "no cdp yet" });
        await sleep(400);
      }
    }
    if (!cdp) {
      log({ step: "error", message: "no cdp backend after retries" });
      log({ step: "done" });
      return;
    }
    log({ step: "cdp", browserId: cdp.id, generation: cdp.generation });
    const execute = async (name, command) => {
      const response = await request("interaction/browserExecute", {
        requestId: `stub-req-${name}`,
        browserId: cdp.id,
        browserGeneration: cdp.generation,
        ...common,
        command,
      });
      log({ step: name, response });
      return response;
    };
    const newTab = await execute("newTab", { method: "newTab" });
    const tabId = newTab?.result?.tab?.tabId;
    await execute("navigate", { method: "navigate", url: fixtureUrl, tabId });
    await execute("evaluate", { method: "evaluate", expression: "document.title", tabId });
    await execute("screenshot", { method: "screenshot", tabId });
    log({ step: "done" });
  } catch (error) {
    log({ step: "error", message: error instanceof Error ? error.message : String(error) });
    log({ step: "done" });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method !== undefined && message.id !== undefined) {
    if (message.method === "initialize") {
      send({
        id: message.id,
        result: {
          protocolVersion: "0.1.0",
          serverInfo: { name: "zcode-cli-stub", version: "3.18.2" },
          capabilities: { v4: true, v4Topics: true },
          sessionCount: 0,
        },
      });
      return;
    }
    if (message.method === "runtime/capabilities") {
      send({ id: message.id, result: { v4: true, sessionLifecycleWorkspace: true } });
      return;
    }
    if (message.method === "session/list" || message.method === "v4/session/list") {
      send({ id: message.id, result: { sessions: [] } });
      return;
    }
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const resolveRequest = pending.get(message.id);
    if (resolveRequest) {
      pending.delete(message.id);
      resolveRequest(message);
    }
  }
});

// 服务器在 wireClient 后才会把 initialWorkspace 登记进路由；稍等再发起反向请求。
setTimeout(() => void driveBrowser(), 1500);
