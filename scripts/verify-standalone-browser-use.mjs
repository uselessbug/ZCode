/* eslint-disable max-lines -- 独立 HTTP Web Browser Use 全链路与任务生命周期清理集成回归。 */
// 独立 HTTP Web Browser Use（`agent.browsers.*`）定向回归验收脚本。
//
// 针对 docs/standalone-web-browser-use.md 描述的受管无头 CDP 运行时：
//   Agent CLI -> interaction/browserList|browserExecute -> zcodeAgentService
//            -> BrowserControlExecutor（@zcode/services/node 的窄桥别名）
//            -> packages/server/src/browser-control 的 createServerBrowserControl
//            -> @zcode/adapters/browser 的 createManagedCdpBrowserRuntime -> /usr/bin/chromium
//
// 本脚本不修改任何核心源码 / Dockerfile / spec / docs，也不新增公开 HTTP 路由。
// 它用 esbuild 把「受测源码」窄打包成可加载模块（不安装全量依赖、不伪造被测行为），
// 再驱动真实工厂 + 真实 /usr/bin/chromium + Playwright 完成端到端断言。
//
// 解析策略（复用仓库既有 standalone-*.mjs 的窄加载思路）：
//   - @zcode/adapters/browser -> apps/zcode-cli/packages/adapters/src/browser/index.ts（官方适配器源码）
//   - @zcode/shared           -> 仅 re-export browser-use 真实 zod schema 的 shim（不重写逻辑）
//   - Playwright              -> createRequire('/app/zcode/agent/zcode.cjs')('playwright-core')
//
// 运行：
//   node scripts/verify-standalone-browser-use.mjs
//   node scripts/verify-standalone-browser-use.mjs --runtime-root <releaseRoot>
//
// 退出码：任一断言失败或必需阶段缺失 -> 非 0。

import {
  verifyFactoryRealBrowser,
  makeContext,
  isPngBase64,
  listCdp,
} from "./verify-standalone-browser-use.factory.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ARGS = process.argv.slice(2);
const RUNTIME_ROOT_ARG = (() => {
  const index = CLI_ARGS.indexOf("--runtime-root");
  return index >= 0 ? CLI_ARGS[index + 1] : undefined;
})();

const CHROMIUM = process.env.CHROME_EXECUTABLE_PATH?.trim() || "/usr/bin/chromium";
const AGENT_ENTRY =
  process.env.ZCODE_VERIFY_AGENT_ENTRY?.trim() ||
  (RUNTIME_ROOT_ARG
    ? join(resolve(RUNTIME_ROOT_ARG), "agent/zcode.cjs")
    : existsSync("/app/zcode/agent/zcode.cjs")
      ? "/app/zcode/agent/zcode.cjs"
      : join(REPO_ROOT, "packages/server/package.json"));
const BROWSER_CONTROL_DIR = join(REPO_ROOT, "packages/server/src/browser-control");
const APP_SERVER_STUB = join(REPO_ROOT, "scripts/verify-standalone-browser-use.app-server.mjs");
const ADAPTER_BROWSER_ENTRY = join(
  REPO_ROOT,
  "apps/zcode-cli/packages/adapters/src/browser/index.ts",
);
// services/node.ts 需要的完整依赖（chokidar/node-pty/... 不在仓库最小 node_modules 内）。
const DEP_ROOT_CANDIDATES = [
  process.env.ZCODE_VERIFY_NODE_MODULES?.trim(),
  join(REPO_ROOT, "node_modules"),
  "/app/zcode/agent/node_modules",
  "/workspace/maintenance/ZCode-upstream-3.18.2/node_modules",
].filter(Boolean);

const gaps = [];
const phases = [];

function pass(name, detail) {
  phases.push({ name, status: "PASS", detail });
  console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
}
function gap(name, detail) {
  gaps.push({ name, detail });
  process.exitCode = 1;
  phases.push({ name, status: "GAP", detail });
  console.log(`GAP  ${name} :: ${detail}`);
}

// ---------------------------------------------------------------------------
// 环境与依赖解析
// ---------------------------------------------------------------------------

function resolveEsbuildModule() {
  try {
    return createRequire(join(REPO_ROOT, "package.json")).resolve("esbuild");
  } catch {
    // 精简验证环境只链接了 esbuild 可执行文件，回退到该工具所在包。
  }
  const binLink = join(REPO_ROOT, "node_modules/.bin/esbuild");
  if (!existsSync(binLink)) return null;
  const binTarget = realpathSync(binLink); // <pkg>/bin/esbuild
  const pkgDir = resolve(dirname(binTarget), "..");
  const libEntry = join(pkgDir, "lib/main.js");
  return existsSync(libEntry) ? libEntry : null;
}

function resolveEsbuildCli() {
  const binLink = join(REPO_ROOT, "node_modules/.bin/esbuild");
  return existsSync(binLink) ? binLink : null;
}

function resolvePlaywright() {
  if (!existsSync(AGENT_ENTRY)) {
    throw new Error(`trusted agent entry not found: ${AGENT_ENTRY}`);
  }
  const agentRequire = createRequire(AGENT_ENTRY);
  const playwright = agentRequire("playwright-core");
  if (typeof playwright?.chromium?.launch !== "function") {
    throw new Error("playwright-core does not expose chromium.launch");
  }
  return playwright;
}

function findFullDepRoot() {
  for (const root of DEP_ROOT_CANDIDATES) {
    // chokidar 是 services 独有依赖；zod 是共享依赖。
    if (existsSync(join(root, "zod")) && existsSync(join(root, "chokidar"))) return root;
  }
  return null;
}

// ---------------------------------------------------------------------------
// esbuild 窄打包
// ---------------------------------------------------------------------------

function writeSharedBrowserShim(dir) {
  // 官方浏览器适配器/工厂只用到 browser-use 的 zod schema。shared barrel 会连锁加载
  // model-config / session-control 等无关模块，这里只 re-export 真实实现（不是另写逻辑）。
  const browserUse = join(REPO_ROOT, "packages/shared/src/browser-use");
  const lines = [
    "command-metadata.ts",
    "commands.ts",
    "backend.ts",
    "snapshot.ts",
    "result.ts",
  ].map((file) => `export * from ${JSON.stringify(join(browserUse, file))};`);
  const shimPath = join(dir, "shared-browser-use-shim.ts");
  writeFileSync(shimPath, `${lines.join("\n")}\n`);
  return shimPath;
}

function buildFactoryBundle(outDir) {
  const cli = resolveEsbuildCli();
  if (!cli) throw new Error("esbuild CLI not available (node_modules/.bin/esbuild)");
  if (!existsSync(ADAPTER_BROWSER_ENTRY)) {
    throw new Error(`official browser adapter missing: ${ADAPTER_BROWSER_ENTRY}`);
  }
  if (!existsSync(join(BROWSER_CONTROL_DIR, "index.ts"))) {
    throw new Error(`server browser-control factory missing: ${BROWSER_CONTROL_DIR}/index.ts`);
  }
  mkdirSync(outDir, { recursive: true });
  const shimPath = writeSharedBrowserShim(outDir);
  const outfile = join(outDir, "browser-control.mjs");
  execFileSync(
    cli,
    [
      join(BROWSER_CONTROL_DIR, "index.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--external:playwright-core",
      `--alias:@zcode/adapters/browser=${ADAPTER_BROWSER_ENTRY}`,
      `--alias:@zcode/shared=${shimPath}`,
      `--outfile=${outfile}`,
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );
  return outfile;
}

async function loadEsbuildModule() {
  const libEntry = resolveEsbuildModule();
  if (!libEntry) throw new Error("verify-tools esbuild lib not resolvable");
  const mod = await import(pathToFileURL(libEntry).href);
  return mod.default ?? mod;
}

function makeWorkspacePlugin() {
  const packagesDir = join(REPO_ROOT, "packages");
  const servicesSrc = join(packagesDir, "services/src");
  const sharedSrc = join(packagesDir, "shared/src");

  const resolveZcode = (spec) => {
    const parts = spec.split("/"); // ["@zcode", "<pkg>", ...sub]
    const pkgName = parts[1];
    const sub = parts.slice(2).join("/");
    const pkgDir = join(packagesDir, pkgName);
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) return null;
    let pkgJson;
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      return null;
    }
    const pick = (target) => {
      const value = typeof target === "string" ? target : (target?.import ?? target?.default);
      if (!value) return null;
      const candidate = join(pkgDir, value);
      return existsSync(candidate) ? candidate : null;
    };
    if (!sub) {
      return (
        pick(pkgJson.exports?.["."]) ??
        pick(pkgJson.exports) ??
        pick(pkgJson.main) ??
        (existsSync(join(pkgDir, "src/index.ts")) ? join(pkgDir, "src/index.ts") : null)
      );
    }
    const subEntry = pkgJson.exports?.[`./${sub}`];
    if (subEntry) {
      const resolved = pick(subEntry);
      if (resolved) return resolved;
    }
    for (const candidate of [
      join(pkgDir, "src", `${sub}.ts`),
      join(pkgDir, "src", sub, "index.ts"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  const resolveHashSrc = (spec) => {
    const rest = spec.slice("#src/".length);
    const candidates = [];
    for (const base of [servicesSrc, sharedSrc]) {
      candidates.push(join(base, rest));
      if (rest.endsWith(".js")) candidates.push(join(base, `${rest.slice(0, -3)}.ts`));
      candidates.push(join(base, rest, "index.ts"));
      if (rest.endsWith(".js")) candidates.push(join(base, rest.slice(0, -3), "index.ts"));
    }
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  };

  return {
    name: "zcode-workspace-resolver",
    setup(build) {
      build.onResolve({ filter: /^@zcode\// }, (args) => {
        const resolved = resolveZcode(args.path);
        return resolved ? { path: resolved } : undefined;
      });
      build.onResolve({ filter: /^#src\// }, (args) => {
        const resolved = resolveHashSrc(args.path);
        return resolved ? { path: resolved } : undefined;
      });
    },
  };
}

async function buildServicesBundle({ outDir, nodeModulesRoot }) {
  const esbuild = await loadEsbuildModule();
  mkdirSync(outDir, { recursive: true });
  if (nodeModulesRoot && !existsSync(join(outDir, "node_modules"))) {
    symlinkSync(nodeModulesRoot, join(outDir, "node_modules"), "dir");
  }
  // 单一模块图入口：node.ts 的 barrel + 注册用的 IZCodeAgentService 符号，保证 ServiceCollection
  // 注册/取出用同一个符号实例。
  const entryPath = join(outDir, "services-entry.ts");
  writeFileSync(
    entryPath,
    [
      `export * from ${JSON.stringify(join(REPO_ROOT, "packages/services/src/node.ts"))};`,
      `export { IZCodeAgentService, IZCodeTaskService, IProviderSettingsService } from ${JSON.stringify(join(REPO_ROOT, "packages/services/src/index.ts"))};`,
      `export { TaskIndexRepo } from ${JSON.stringify(join(REPO_ROOT, "packages/services/src/session/taskIndexRepo.ts"))};`,
      `export { buildServerRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from ${JSON.stringify(join(REPO_ROOT, "packages/shared/src/remote-workspace-identity.ts"))};`,
      "",
    ].join("\n"),
  );
  const outfile = join(outDir, "services-node.mjs");
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    // 依赖（含 native）从可信 node_modules 运行时解析，避免把 node-pty 等打进包。
    packages: "external",
    plugins: [makeWorkspacePlugin()],
    logLevel: "silent",
  });
  return outfile;
}

async function buildAmbientContextBundle(outDir) {
  const esbuild = await loadEsbuildModule();
  mkdirSync(outDir, { recursive: true });
  const shimPath = writeSharedBrowserShim(outDir);
  const outfile = join(outDir, "ambient.mjs");
  await esbuild.build({
    entryPoints: [
      join(REPO_ROOT, "packages/services/src/zcode-agent/zcodeAgentBrowserAmbientContext.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    alias: { "@zcode/shared": shimPath },
    logLevel: "silent",
  });
  return outfile;
}

async function buildProtocolBundle(outDir) {
  const esbuild = await loadEsbuildModule();
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, "protocol.mjs");
  await esbuild.build({
    entryPoints: [join(REPO_ROOT, "packages/shared/src/zcode-protocol/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    alias: {
      "@zcode/session-control/contracts": join(
        REPO_ROOT,
        "packages/session-control/src/contract.ts",
      ),
      "@zcode/model-option-map": join(REPO_ROOT, "packages/model-option-map/src/index.ts"),
    },
    external: ["playwright-core"],
    logLevel: "silent",
  });
  return outfile;
}

// ---------------------------------------------------------------------------
// 本地 HTTP fixture
// ---------------------------------------------------------------------------

const FIXTURE_TITLE = "BSBTEST_FIXTURE";
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${FIXTURE_TITLE}</title></head>
<body><h1 id="heading">fixture</h1>
<input id="name" />
<button id="go">Go</button>
<div id="out"></div>
<script>
document.getElementById("go").addEventListener("click", () => {
  document.getElementById("out").textContent = "hello " + document.getElementById("name").value;
});
</script></body></html>`;

function startFixtureServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FIXTURE_HTML);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 工厂执行桥调用助手
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase: 发行包布局加载器（resolvePackagedAgentEntryPath / loadServerPlaywrightChromium）
// ---------------------------------------------------------------------------

async function verifyPackagedLayout({ releaseRoot, bundlePath, existing = false }) {
  const agentDir = join(releaseRoot, "agent");
  const serverDir = join(releaseRoot, "server");
  const agentEntry = join(agentDir, "zcode.cjs");
  if (existing) {
    assert.ok(existsSync(agentEntry), "runtime root must contain the packaged Agent entry");
    assert.ok(
      existsSync(join(agentDir, "node_modules/playwright-core")),
      "runtime root must contain Playwright; verification must not repair missing assets",
    );
    releaseRoot = mkdtempSync(join(tmpdir(), "zcode-browser-layout-"));
    mkdirSync(join(releaseRoot, "server"));
    symlinkSync(agentDir, join(releaseRoot, "agent"), "dir");
  } else {
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(agentEntry, "module.exports = {};\n");
    mkdirSync(join(agentDir, "node_modules"));
    const runtimeRequire = createRequire(AGENT_ENTRY);
    symlinkSync(
      dirname(runtimeRequire.resolve("playwright-core/package.json")),
      join(agentDir, "node_modules/playwright-core"),
      "dir",
    );
  }
  const expectedAgentEntry = join(releaseRoot, "agent/zcode.cjs");
  const packagedBundle = join(releaseRoot, "server/browser-control.mjs");
  writeFileSync(packagedBundle, readFileSync(bundlePath));

  const module = await import(`${pathToFileURL(packagedBundle).href}?packaged=1`);

  const resolvedEntry = module.resolvePackagedAgentEntryPath();
  assert.equal(
    resolve(resolvedEntry),
    resolve(expectedAgentEntry),
    "resolvePackagedAgentEntryPath must target <root>/agent/zcode.cjs",
  );

  const loaded = await module.loadServerPlaywrightChromium();
  assert.equal(typeof loaded?.chromium?.launch, "function", "packaged loader must expose chromium");

  // 反向证明：loader 不依赖仓库路径——把 agent 入口判定为不存在时，只能回落 import("playwright-core")，
  // 而发行包 server 目录下没有可解析的 playwright-core，必须失败（说明上面的成功来自打包布局）。
  let fellBack = false;
  try {
    await module.loadServerPlaywrightChromium({ existsSync: () => false });
  } catch {
    fellBack = true;
  }
  assert.ok(
    fellBack,
    "loader must resolve playwright-core from the packaged agent layout, not an ambient repo path",
  );

  // 默认 loadPlaywright（打包布局解析）驱动真实 Chromium。
  const handle = module.createServerBrowserControl({ executablePath: CHROMIUM });
  try {
    const cdp = await listCdp(
      handle.executor,
      makeContext({ sessionId: "packaged", workspaceKey: "packaged" }),
    );
    assert.equal(cdp.type, "cdp");
    pass(
      "packaged-layout-loader",
      `resolvePackagedAgentEntryPath + loadServerPlaywrightChromium -> real chromium (type=${cdp.type})`,
    );
  } finally {
    await handle.close().catch(() => {});
    if (existing) rmSync(releaseRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase: services 注入 / 透传（动态，非静态替代）
// ---------------------------------------------------------------------------

async function verifyServicesInjection({
  factoryModule,
  playwright,
  depRoot,
  buildDir,
  fixtureUrl,
}) {
  const servicesDir = join(buildDir, "services");
  let servicesEntry;
  try {
    servicesEntry = await buildServicesBundle({ outDir: servicesDir, nodeModulesRoot: depRoot });
  } catch (error) {
    gap("services.bundle", `services/node.ts bundle failed: ${error?.message ?? error}`);
    return;
  }
  const services = await import(pathToFileURL(servicesEntry).href);
  if (typeof services.createServerHostServices !== "function") {
    gap("services.bundle", "bundle does not export createServerHostServices");
    return;
  }

  const homeRoot = mkdtempSync(join(tmpdir(), "zcode-verify-browser-home-"));
  const browserHandle = factoryModule.createServerBrowserControl({
    executablePath: CHROMIUM,
    loadPlaywright: async () => playwright,
  });
  const previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR,
    ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS: process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS,
  };
  process.env.HOME = homeRoot;
  process.env.USERPROFILE = homeRoot;
  process.env.ZCODE_DATA_BASE_DIR = homeRoot;
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";

  let host;
  try {
    // 真实 createServerHostServices：把真实工厂 executor 注入真实 services 图。
    // 这是「实际注入」而非静态读取：construction 走真实 createLocalServices 装配并把
    // browserControlExecutor 透传给 zcodeAgentService options（见下动态触达断言）。
    host = await services.createServerHostServices({
      sourceServerId: "verify-standalone-browser-use",
      zcodeBuiltinProviderConfigFilePath: join(
        REPO_ROOT,
        "config/provider/zcode-builtin.test.json",
      ),
      credentialCipherProvider: { encrypt: async (v) => v, decrypt: async (v) => v },
      browserControlExecutor: browserHandle.executor,
    });
    assert.ok(host?.services, "createServerHostServices must return services");
    pass("services.injection", "createServerHostServices accepts real factory executor");
  } catch (error) {
    gap("services.injection", `createServerHostServices failed: ${error?.message ?? error}`);
    return;
  } finally {
    if (host?.services) {
      await services.disposeServiceResourcesAndWait(host.services).catch(() => {});
    }
    await browserHandle.close().catch(() => {});
    process.env.HOME = previousEnv.HOME;
    process.env.USERPROFILE = previousEnv.USERPROFILE;
    process.env.ZCODE_DATA_BASE_DIR = previousEnv.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS =
      previousEnv.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS;
    rmSync(homeRoot, { recursive: true, force: true });
  }

  // 动态触达：真实 services 函数 collectBrowserAmbientContext（prompt 前的 browser ambient 收集）
  // 直接调用真实工厂 executor.list。它只认可 type==="iab"，因此受管 CDP 期望返回 undefined，
  // 但 list 必须被真实调用（证明 services -> executor 链路而非静态读取）。
  try {
    const ambientEntry = await buildAmbientContextBundle(join(buildDir, "ambient"));
    const ambient = await import(pathToFileURL(ambientEntry).href);
    const spyHandle = factoryModule.createServerBrowserControl({
      executablePath: CHROMIUM,
      loadPlaywright: async () => playwright,
    });
    let listCalls = 0;
    let executeCalls = 0;
    const spy = {
      list: async (input) => {
        listCalls += 1;
        return spyHandle.executor.list(input);
      },
      execute: async (input) => {
        executeCalls += 1;
        return spyHandle.executor.execute(input);
      },
    };
    try {
      const result = await ambient.collectBrowserAmbientContext(spy, {
        sessionId: "ambient-session",
        workspacePath: "/tmp/verify-standalone-browser-use",
        clientMode: "web-remote-replayable",
      });
      assert.ok(listCalls >= 1, "collectBrowserAmbientContext must call executor.list");
      assert.equal(result, undefined, "managed cdp is not an IAB ambient backend");
      pass(
        "services.ambient-reachability",
        `real collectBrowserAmbientContext -> factory.list (calls=${listCalls}, execute=${executeCalls})`,
      );
    } finally {
      await spyHandle.close().catch(() => {});
    }
  } catch (error) {
    gap("services.ambient-reachability", `ambient bundle/call failed: ${error?.message ?? error}`);
  }

  // 真实协议参数/结果 schema 往返：用处理器同形参数调用真实工厂 executor，
  // 结果再过真实 zcodeBrowserExecuteResultSchema（= browserCommandResultSchema）校验。
  try {
    const protocolEntry = await buildProtocolBundle(join(buildDir, "protocol"));
    const protocol = await import(pathToFileURL(protocolEntry).href);
    const probe = factoryModule.createServerBrowserControl({
      executablePath: CHROMIUM,
      loadPlaywright: async () => playwright,
    });
    try {
      const listParams = protocol.zcodeBrowserListParamsSchema.parse({
        requestId: randomUUID(),
        sessionId: "protocol-session",
        turnId: "protocol-turn",
        workspaceKey: "protocol-workspace",
        workspacePath: "/tmp/verify-standalone-browser-use",
        clientMode: "web-remote-replayable",
        sessionContext: "live",
      });
      const descriptors = await probe.executor.list(listParams);
      const cdp = descriptors.find((d) => d.type === "cdp");
      assert.ok(cdp, "protocol params must reach a cdp backend");

      const executeParams = protocol.zcodeBrowserExecuteParamsSchema.parse({
        requestId: randomUUID(),
        sessionId: "protocol-session",
        turnId: "protocol-turn",
        browserId: cdp.id,
        browserGeneration: cdp.generation,
        workspaceKey: "protocol-workspace",
        workspacePath: "/tmp/verify-standalone-browser-use",
        clientMode: "web-remote-replayable",
        sessionContext: "live",
        command: { method: "newTab" },
      });
      const rawResult = await probe.executor.execute(executeParams);
      // 工厂返回经 shared schema 校验；这里再用真实协议结果 schema 做协议边界往返。
      const parsed = protocol.zcodeBrowserExecuteResultSchema.parse(rawResult);
      assert.equal(parsed.ok, true, "protocol execute result must round-trip");

      // 在协议会话上跑完整链路，确认真实工厂在 handler 同形参数下执行。
      const navResult = await probe.executor.execute(
        protocol.zcodeBrowserExecuteParamsSchema.parse({
          requestId: randomUUID(),
          sessionId: "protocol-session",
          browserId: cdp.id,
          browserGeneration: cdp.generation,
          workspaceKey: "protocol-workspace",
          workspacePath: "/tmp/verify-standalone-browser-use",
          clientMode: "web-remote-replayable",
          sessionContext: "live",
          command: { method: "navigate", url: fixtureUrl, tabId: parsed.tab?.tabId },
        }),
      );
      assert.equal(
        protocol.zcodeBrowserExecuteResultSchema.parse(navResult).ok,
        true,
        "handler-shaped protocol params must drive real navigation",
      );
      pass(
        "services.protocol-roundtrip",
        "real zcodeBrowserList/ExecuteParams -> factory -> real commandResult schema ok",
      );
    } finally {
      await probe.close().catch(() => {});
    }
  } catch (error) {
    gap(
      "services.protocol-roundtrip",
      `protocol schema round-trip failed: ${error?.message ?? error}`,
    );
  }

  await verifyInteractionRpc({ services, factoryModule, playwright, fixtureUrl, buildDir });
  await verifyTaskLifecycleCleanup({ services, factoryModule, playwright, fixtureUrl });
}

// 验证归档 / 删除 / 数据清理统一触发 closeTaskSessions，且清理异常不回滚业务状态。
async function verifyTaskLifecycleCleanup({ services, factoryModule, playwright, fixtureUrl }) {
  if (
    typeof services.createLocalServices !== "function" ||
    !services.IZCodeTaskService ||
    !services.IZCodeAgentService ||
    !services.TaskIndexRepo
  ) {
    gap("services.lifecycle-cleanup", "services bundle lacks task/agent/repo exports");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "zcode-verify-browser-lifecycle-"));
  const workspacePath = join(root, "ws-lifecycle");
  mkdirSync(workspacePath, { recursive: true });
  const serverId = "verify-browser-lifecycle";
  const workerPath = join(root, "lifecycle-worker.mjs");
  writeFileSync(
    workerPath,
    `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (buf.includes("\\n")) {
    const idx = buf.indexOf("\\n");
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { protocolName: "ZCode Protocol", protocolVersion: 1 } }) + "\\n");
      continue;
    }
    if (msg.method === "runtime/capabilities") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
      continue;
    }
    if (msg.method === "provider/refreshRegistry") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { refreshed: true } }) + "\\n");
      continue;
    }
    if (msg.method === "provider/updateAccountConfig") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          receivedRevision: msg.params.revision ?? "rev-1",
          providerCount: Array.isArray(msg.params.providers) ? msg.params.providers.length : 0,
          status: "received",
        },
      }) + "\\n");
      continue;
    }
    if (msg.method === "workspace/updateInteractionPreferences") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          workspace: msg.params.workspace,
          askUserQuestionAutoResolutionEnabled: msg.params.askUserQuestionAutoResolutionEnabled ?? true,
          snoozedInteractionCount: 0,
        },
      }) + "\\n");
      continue;
    }
    if (msg.method === "workspace/updateModelIoPreferences") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          workspace: msg.params.workspace,
          fullRetentionEnabled: msg.params.fullRetentionEnabled ?? false,
          updatedSessionCount: 0,
        },
      }) + "\\n");
      continue;
    }
    if (msg.method === "workspace/updateOffPeakToolPolicy" || msg.method === "workspace/updateDynamicWorkflowPolicy") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { workspace: msg.params.workspace, enabled: false },
      }) + "\\n");
      continue;
    }
    if (msg.method === "v4/conversation/subscribe") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" } },
      }) + "\\n");
      continue;
    }
    if (msg.method === "v4/sessionsIndex/reconcile" || msg.method === "session/list") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessions: [] } }) + "\\n");
      continue;
    }
    if (msg.method === "v4/command") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { status: "accepted", commandId: msg.params.commandId, revisionAtDecision: 1 } }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/deletionExecute") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessionId: msg.params.sessionId, status: "deleted", sessionIds: [msg.params.sessionId, "sess-perm-child"], retainedArtifacts: 0 } }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/purge") {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          deleted: [{
            sessionId: "sess-purge-deleted",
            bytes: 10,
            sessionIds: ["sess-purge-deleted", "sess-purge-owned-child"],
          }],
          kept: [{ sessionId: "sess-purge-kept", reason: "running" }],
          failed: [{ sessionId: "sess-purge-failed", code: "EACCES" }],
          memory: [],
        },
      }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  }
});
`,
  );
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR,
    ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS: process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS,
  };
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.ZCODE_DATA_BASE_DIR = root;
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";

  const browserHandle = factoryModule.createServerBrowserControl({
    executablePath: CHROMIUM,
    loadPlaywright: async () => playwright,
  });
  const closedCalls = [];
  let shouldFailClose = false;
  const instrumentedExecutor = {
    list: (input) => browserHandle.executor.list(input),
    execute: (input) => browserHandle.executor.execute(input),
    closeTaskSessions: async (params) => {
      closedCalls.push(params);
      if (shouldFailClose) throw new Error("simulated closeTaskSessions failure");
      await browserHandle.executor.closeTaskSessions?.(params);
    },
  };
  let collection;
  try {
    const hostId = services.remoteHostIdFromWorkspaceIdentity(
      services.buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: "/" }),
    );
    services.setDataBaseDir(root);
    await services.migrateApplicationStorage(undefined, hostId);
    const aliasRepo = new services.SourceServerWorkspaceAliasRepo();
    const sourceServerWorkspaceService = services.createSourceServerWorkspaceService(aliasRepo, {
      defaultWorkspaceIdentity: (targetPath) =>
        services.buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: targetPath }),
    });
    const identity = (await sourceServerWorkspaceService.resolveWorkspace({ workspacePath }))
      .canonicalWorkspaceKey;
    collection = services.createLocalServices({
      credentialCipherProvider: { encrypt: async (v) => v, decrypt: async (v) => v },
      zcodeBuiltinProviderConfigFilePath: join(
        REPO_ROOT,
        "config/provider/zcode-builtin.test.json",
      ),
      serviceAuthorityMode: "standalone-server",
      projectStorageHostId: hostId,
      sourceServerWorkspaceService,
      allowStandaloneCloudWorkspaces: true,
      standaloneWorkspaceRoot: root,
      allowStandaloneMultiRoot: true,
      browserControlExecutor: instrumentedExecutor,
      zcodeAgentCommandResolver: () => ({
        command: process.execPath,
        args: [workerPath],
      }),
    });

    const providerSettings = collection.get(services.IProviderSettingsService);
    await providerSettings.createPersonalProvider({
      templateId: "zai-standard-api",
      providerName: "Browser Lifecycle Provider",
      initialConfig: {
        access: { type: "api-key", apiKey: "sk-test-browser-lifecycle" },
      },
    });

    const repo = new services.TaskIndexRepo(undefined, hostId);
    await repo.ensureReady();
    for (const sid of ["sess-archive-1", "sess-del-1", "sess-perm-1"]) {
      await repo.applyCliFacts({
        meta: {
          taskId: sid,
          traceId: `trace-${sid}`,
          title: sid,
          workspacePath,
          workspaceIdentity: identity,
          createdAt: Date.now() - 1000,
          updatedAt: Date.now() - 1000,
          mode: "build",
          provider: "glm",
        },
      });
    }
    repo.close();

    const taskService = collection.get(services.IZCodeTaskService);
    const agentService = collection.get(services.IZCodeAgentService);

    // 1. archiveTask 触发 closeTaskSessions
    await taskService.archiveTask({
      taskId: "sess-archive-1",
      workspacePath,
      workspaceIdentity: identity,
    });
    assert.deepEqual(closedCalls.at(-1)?.sessionIds, ["sess-archive-1"]);

    // 2. deleteArchivedTask 触发 closeTaskSessions（且异常时不回滚已提交删除）
    shouldFailClose = true;
    const deletedOk = await taskService.deleteArchivedTask({
      taskId: "sess-archive-1",
      workspacePath,
      workspaceIdentity: identity,
    });
    assert.equal(deletedOk, true, "closeTaskSessions error must not roll back deleteArchivedTask");
    assert.deepEqual(closedCalls.at(-1)?.sessionIds, ["sess-archive-1"]);
    shouldFailClose = false;

    // 3. executeSessionDeletion 成功后触发 closeTaskSessions（含子会话）
    const delResult = await agentService.executeSessionDeletion({
      sessionId: "sess-perm-1",
      workspace: { workspacePath, workspaceIdentity: identity },
      revision: "rev-1",
      operationId: "op-1",
    });
    assert.equal(delResult.status, "deleted");
    assert.deepEqual(closedCalls.at(-1)?.sessionIds, ["sess-perm-1", "sess-perm-child"]);

    // 4. purgeSessionData 展开已删会话树全部 sessionIds（parent + owned-child）销毁上下文，
    //    并严格保留 kept（运行中/被引用）与 failed 会话上下文。
    const openSessionWithTab = async (sessionId) => {
      const ctx = makeContext({
        sessionId,
        workspaceKey: identity,
        workspacePath,
        workspaceIdentity: identity,
      });
      const cdp = await listCdp(browserHandle.executor, ctx);
      const tab = await browserHandle.executor.execute({
        ...ctx,
        browserId: cdp.id,
        browserGeneration: cdp.generation,
        command: { method: "newTab" },
      });
      assert.equal(tab.ok, true);
      const nav = await browserHandle.executor.execute({
        ...ctx,
        browserId: cdp.id,
        browserGeneration: cdp.generation,
        command: { method: "navigate", url: fixtureUrl, tabId: tab.tab?.tabId },
      });
      assert.equal(nav.ok, true);
      return { ctx, cdp };
    };
    await openSessionWithTab("sess-purge-deleted");
    await openSessionWithTab("sess-purge-owned-child");
    const keptSession = await openSessionWithTab("sess-purge-kept");

    const purgeResult = await agentService.purgeSessionData({
      workspace: { workspacePath, workspaceIdentity: identity },
      sessionIds: ["sess-purge-deleted", "sess-purge-kept", "sess-purge-failed"],
      directories: [],
    });
    assert.equal(purgeResult.deleted.length, 1);
    assert.equal(purgeResult.kept.length, 1);
    assert.deepEqual(closedCalls.at(-1)?.sessionIds, [
      "sess-purge-deleted",
      "sess-purge-owned-child",
    ]);

    for (const destroyedId of ["sess-purge-deleted", "sess-purge-owned-child"]) {
      const freshCtx = makeContext({
        sessionId: destroyedId,
        workspaceKey: identity,
        workspacePath,
        workspaceIdentity: identity,
      });
      const freshCdp = await listCdp(browserHandle.executor, freshCtx);
      const listed = await browserHandle.executor.execute({
        ...freshCtx,
        browserId: freshCdp.id,
        browserGeneration: freshCdp.generation,
        command: { method: "list" },
      });
      assert.equal(
        listed.tabs?.length,
        0,
        `${destroyedId} context must be destroyed by purgeSessionData`,
      );
    }
    const keptTabs = await browserHandle.executor.execute({
      ...keptSession.ctx,
      requestId: randomUUID(),
      browserId: keptSession.cdp.id,
      browserGeneration: keptSession.cdp.generation,
      command: { method: "list" },
    });
    assert.equal(keptTabs.ok, true, "kept session lease must stay active");
    assert.equal(keptTabs.tabs?.length, 1, "kept session tab must remain preserved");

    pass(
      "services.lifecycle-cleanup",
      "archiveTask/deleteArchivedTask/executeSessionDeletion/purgeSessionData(deleted-only) -> closeTaskSessions",
    );
  } catch (error) {
    gap("services.lifecycle-cleanup", error?.stack ?? String(error));
  } finally {
    if (collection) await services.disposeServiceResourcesAndWait(collection).catch(() => {});
    await browserHandle.close().catch(() => {});
    process.env.HOME = savedEnv.HOME;
    process.env.USERPROFILE = savedEnv.USERPROFILE;
    process.env.ZCODE_DATA_BASE_DIR = savedEnv.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS =
      savedEnv.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS;
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitForStubLog(logFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = readFileSync(logFile, "utf8");
    } catch {
      text = "";
    }
    const entries = text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (entries.some((entry) => entry.step === "done" || entry.step === "error")) return entries;
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

// 真实 services 链路：createLocalServices(真实 browserControlExecutor) -> zcodeAgentService，
// 由脚本化 app-server 子进程发起 interaction/browserList 与 interaction/browserExecute 反向请求。
async function verifyInteractionRpc({ services, factoryModule, playwright, fixtureUrl }) {
  if (typeof services.createLocalServices !== "function" || !services.IZCodeAgentService) {
    gap(
      "services.interaction-rpc-e2e",
      "services bundle lacks createLocalServices / IZCodeAgentService",
    );
    return;
  }
  if (!existsSync(APP_SERVER_STUB)) {
    gap("services.interaction-rpc-e2e", `stub app-server missing: ${APP_SERVER_STUB}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "zcode-verify-browser-rpc-"));
  const logFile = join(root, "stub.ndjson");
  const workspacePath = join(root, "ws-stub");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(logFile, "");
  const serverId = "verify-standalone-browser-use";
  const savedEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR,
    ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS: process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS,
    ZCODE_SERVER_ID: process.env.ZCODE_SERVER_ID,
  };
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.ZCODE_DATA_BASE_DIR = root;
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";
  process.env.ZCODE_SERVER_ID = serverId;

  const browserHandle = factoryModule.createServerBrowserControl({
    executablePath: CHROMIUM,
    loadPlaywright: async () => playwright,
  });
  let collection;
  try {
    const hostId = services.remoteHostIdFromWorkspaceIdentity(
      services.buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: "/" }),
    );
    assert.ok(hostId, "standalone host id must resolve");
    services.setDataBaseDir(root);
    await services.migrateApplicationStorage(undefined, hostId);
    const aliasRepo = new services.SourceServerWorkspaceAliasRepo();
    const sourceServerWorkspaceService = services.createSourceServerWorkspaceService(aliasRepo, {
      defaultWorkspaceIdentity: (targetWorkspacePath) =>
        services.buildServerRemoteWorkspaceIdentity({
          serverId,
          workspacePath: targetWorkspacePath,
        }),
    });
    const identity = (await sourceServerWorkspaceService.resolveWorkspace({ workspacePath }))
      .canonicalWorkspaceKey;

    collection = services.createLocalServices({
      credentialCipherProvider: { encrypt: async (v) => v, decrypt: async (v) => v },
      zcodeBuiltinProviderConfigFilePath: join(
        REPO_ROOT,
        "config/provider/zcode-builtin.test.json",
      ),
      serviceAuthorityMode: "standalone-server",
      projectStorageHostId: hostId,
      sourceServerWorkspaceService,
      allowStandaloneCloudWorkspaces: true,
      standaloneWorkspaceRoot: root,
      allowStandaloneMultiRoot: true,
      browserControlExecutor: browserHandle.executor,
      zcodeAgentCommandResolver: (ctx) => ({
        command: process.execPath,
        args: [APP_SERVER_STUB],
        cwd: ctx.workspacePath,
        env: {
          ...process.env,
          ZCODE_BSBROWSER_STUB: "1",
          ZCODE_BSBROWSER_LOG: logFile,
          ZCODE_BSBROWSER_WS: ctx.workspacePath,
          ZCODE_BSBROWSER_ID: identity,
          ZCODE_BSBROWSER_URL: fixtureUrl,
        },
      }),
    });

    const agentService = collection.get(services.IZCodeAgentService);
    // initialize 触发真实 CLI 连接握手（listSessions 可能只读索引不拉起进程）。
    await agentService
      .initialize({ workspacePath, workspaceIdentity: identity })
      .catch((error) => console.log(`initialize note: ${error?.message ?? error}`));
    await agentService.listSessions({ workspacePath, workspaceIdentity: identity });

    const entries = await waitForStubLog(logFile, 30_000);
    const done = entries.find((entry) => entry.step === "done");
    const stubError = entries.find((entry) => entry.step === "error");
    assert.ok(!stubError, `stub app-server error: ${JSON.stringify(stubError)}`);
    assert.ok(done, `stub app-server did not complete: ${JSON.stringify(entries)}`);

    const listEntry = entries.find((entry) => entry.step === "list-ok");
    const browsers = listEntry?.response?.result?.browsers ?? [];
    assert.ok(
      browsers.some((browser) => browser.type === "cdp"),
      `interaction/browserList via services must return cdp: ${JSON.stringify(listEntry ?? entries)}`,
    );

    const evaluateEntry = entries.find((entry) => entry.step === "evaluate");
    assert.equal(
      evaluateEntry?.response?.result?.value,
      FIXTURE_TITLE,
      `interaction/browserExecute evaluate via services must read the fixture: ${JSON.stringify(evaluateEntry)}`,
    );
    const screenshotEntry = entries.find((entry) => entry.step === "screenshot");
    assert.ok(
      isPngBase64(screenshotEntry?.response?.result?.image?.base64),
      `interaction/browserExecute screenshot via services must return a PNG: ${JSON.stringify(screenshotEntry)}`,
    );
    pass(
      "services.interaction-rpc-e2e",
      "real zcodeAgentService interaction/browserList|Execute -> factory executor -> real chromium (scripted app-server)",
    );
  } catch (error) {
    let rawLog = "";
    try {
      rawLog = readFileSync(logFile, "utf8");
    } catch {
      rawLog = "<no log>";
    }
    gap(
      "services.interaction-rpc-e2e",
      `interaction RPC e2e failed: ${error?.message ?? error} | stubLog=${rawLog.replace(/\n/g, " ")}`,
    );
  } finally {
    if (collection) await services.disposeServiceResourcesAndWait(collection).catch(() => {});
    await browserHandle.close().catch(() => {});
    process.env.HOME = savedEnv.HOME;
    process.env.USERPROFILE = savedEnv.USERPROFILE;
    process.env.ZCODE_DATA_BASE_DIR = savedEnv.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS =
      savedEnv.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS;
    process.env.ZCODE_SERVER_ID = savedEnv.ZCODE_SERVER_ID;
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(CHROMIUM)) throw new Error(`real chromium not found: ${CHROMIUM}`);
  const playwright = resolvePlaywright();
  console.log(`env: chromium=${CHROMIUM} playwright=${AGENT_ENTRY}`);

  if (!existsSync(join(BROWSER_CONTROL_DIR, "index.ts"))) {
    gap(
      "factory.export",
      `${BROWSER_CONTROL_DIR}/index.ts not found; waiting for builder to land createServerBrowserControl`,
    );
    printSummary();
    return;
  }

  const buildDir = mkdtempSync(join(tmpdir(), "zcode-verify-browser-build-"));
  const fixture = await startFixtureServer();
  try {
    const bundlePath = buildFactoryBundle(join(buildDir, "factory"));
    const factoryModule = await import(pathToFileURL(bundlePath).href);
    assert.equal(
      typeof factoryModule.createServerBrowserControl,
      "function",
      "factory must export createServerBrowserControl",
    );
    assert.equal(typeof factoryModule.isStandaloneBrowserControlEnabled, "function");
    assert.equal(typeof factoryModule.loadServerPlaywrightChromium, "function");
    assert.equal(typeof factoryModule.resolvePackagedAgentEntryPath, "function");
    pass("factory.exports", Object.keys(factoryModule).join(","));

    await verifyFactoryRealBrowser(factoryModule, playwright, fixture.url, {
      pass,
      gap,
      CHROMIUM,
      FIXTURE_TITLE,
    });

    const releaseRoot = RUNTIME_ROOT_ARG ? resolve(RUNTIME_ROOT_ARG) : join(buildDir, "release");
    if (RUNTIME_ROOT_ARG) {
      if (!existsSync(releaseRoot)) {
        gap("packaged-layout", `--runtime-root does not exist: ${releaseRoot}`);
      } else {
        await verifyPackagedLayout({ releaseRoot, bundlePath, existing: true });
      }
    } else {
      await verifyPackagedLayout({ releaseRoot, bundlePath });
    }

    const depRoot = findFullDepRoot();
    if (!depRoot) {
      gap(
        "services.deps",
        `no full dependency root found (needs zod+chokidar). candidates=${DEP_ROOT_CANDIDATES.join(", ")}`,
      );
    } else {
      try {
        await verifyServicesInjection({
          factoryModule,
          playwright,
          depRoot,
          buildDir,
          fixtureUrl: fixture.url,
        });
      } catch (error) {
        gap("services", `services phase error: ${error?.stack ?? error}`);
      }
    }
  } finally {
    await fixture.close().catch(() => {});
    rmSync(buildDir, { recursive: true, force: true });
  }
  printSummary();
}

function printSummary() {
  console.log("\n==== verify-standalone-browser-use summary ====");
  for (const phase of phases) {
    console.log(`  [${phase.status}] ${phase.name} :: ${phase.detail ?? ""}`);
  }
  console.log(`  gaps: ${gaps.length}`);
  console.log(JSON.stringify({ phases, gaps }, null, 2));
}

main().catch((error) => {
  console.error("\nFATAL", error?.stack ?? error);
  printSummary();
  process.exitCode = 1;
});
