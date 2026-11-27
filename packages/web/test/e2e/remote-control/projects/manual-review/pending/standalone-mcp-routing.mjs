// 独立 Web MCP 配置路由运行时验收（无浏览器、不启动 GUI、不联网）。
//
// 覆盖：真实临时 HOME 的用户/项目 MCP 磁盘配置 read/save/toggle；独立 Web base Host
// 无 identity 时的真实 store 路由；桌面 platform 通道与 legacy common 迁移；
// relay/home-only 未连桥的失败语义；跨 target、同 target 换服务与入口 setter 单独换绑的
// stale 丢弃；base Host pending（null）拒读且不误迁云端配置。
//
// 说明：本脚本只做运行时（store/service 路由）验证，不挂载真实 React Root，因此不构成
// render/GUI 级验收；真实 Root mount 需要完整依赖与浏览器环境。
//
// 运行：
//   node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-mcp-routing.mjs
// 依赖（本地验证环境；仓库 node_modules 已 gitignore）：
//   - Node 24（自带 .ts 类型擦除，不需要构建产物）
//   - 仓库声明的依赖 react / zustand（packages/ui）与 zod（packages/shared）可从仓库解析
//     （最小验证环境用 gitignored node_modules 软链提供；缺失时脚本会在 import 阶段直接报错，
//     不会静默跳过被测路由）。
//
// 本脚本自举子进程并在子进程内使用临时 HOME，不修改运行者真实 HOME 或全局 env。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const selfUrl = import.meta.url;

if (process.env.ZCODE_MCP_ROUTING_CHILD === "1") {
  await runChild();
} else {
  await runParent();
}

async function runParent() {
  const root = await mkdtemp(join(tmpdir(), "zcode-mcp-routing-"));
  const home = join(root, "home");
  const workspaceRoot = join(root, "workspaces");
  await mkdir(home, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(selfUrl)], {
      env: {
        ...process.env,
        // fixture 子进程隔离：被测服务读 HOME 解析 ~/.zcode，这里只在该子进程内替换。
        HOME: home,
        USERPROFILE: home,
        ZCODE_MCP_ROUTING_CHILD: "1",
        ZCODE_MCP_ROUTING_HOME: home,
        ZCODE_MCP_ROUTING_WSROOT: workspaceRoot,
      },
      stdio: "inherit",
    });
    assert.equal(result.status, 0, `子进程验收失败，exit=${result.status}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runChild() {
  const home = process.env.ZCODE_MCP_ROUTING_HOME;
  const workspaceRoot = process.env.ZCODE_MCP_ROUTING_WSROOT;
  assert.ok(home && workspaceRoot, "缺少 fixture 环境变量");

  // 被测 store 的浏览器前置：loadMcpFromUserDirectory 要求 window 存在；legacy common 走 localStorage。
  const storage = new Map();
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };

  const { register } = await import("node:module");
  register("./standalone-mcp-routing.loader.mjs", selfUrl);

  const { useMcpStore, setMcpStorePlatform } =
    await import("../../../../../../../ui/src/store/mcpStore.ts");
  const { createMcpSyncService } =
    await import("../../../../../../../services/src/mcp-sync/mcpSyncService.ts");

  const store = () => useMcpStore.getState();
  const serverNames = () =>
    store()
      .nativeServers.map((s) => s.name)
      .sort();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const userConfigPath = join(home, ".zcode/cli/config.json");
  const workspaceConfigPath = (workspacePath) => join(workspacePath, ".zcode/config.json");
  const readServers = async (filePath) => {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return raw?.mcp?.servers ?? {};
  };
  const seedLegacyCommon = () => {
    storage.set(
      "zcode-mcp-config",
      JSON.stringify({ mcp: { mcpServers: { legacy: { command: "legacy-cmd" } } } }),
    );
  };

  const writeJson = async (filePath, value) => {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  };

  // 桌面/远控 platform 通道的观察桩：只记录调用，不实现真实目录读写（真实读写由 mcpSyncService 覆盖）。
  const makePlatformStub = ({ failLoad = false } = {}) => {
    const calls = { load: 0, save: 0, savePayloads: [] };
    return {
      calls,
      loadMcpFromUserDirectory: async () => {
        calls.load += 1;
        if (failLoad) {
          throw new Error("zcode-remote-home-only-unbridged");
        }
        return { servers: [] };
      },
      saveMcpToUserDirectory: async (payload) => {
        calls.save += 1;
        calls.savePayloads.push(payload);
        return { success: true };
      },
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    };
  };

  // 远端/换服务场景的目录服务桩：只用于观察 stale 丢弃，不覆盖真实磁盘读写（由 mcpSyncService 覆盖）。
  const makeDirectoryService = (label, { delayMs = 0 } = {}) => ({
    calls: { load: 0, save: 0 },
    loadMcpFromUserDirectory: async () => {
      if (delayMs) {
        await sleep(delayMs);
      }
      return {
        servers: [
          {
            source: "zcodeagentmcp",
            scope: "user",
            name: label,
            config: { command: `${label}-cmd` },
            enabled: true,
          },
        ],
      };
    },
    saveMcpToUserDirectory: async () => {},
  });

  const mcpSync = createMcpSyncService();

  // ---------------------------------------------------------------------------
  // 1. 独立 Web base Host：无 identity/authority 时走入口注入的 server mcpSyncService
  // ---------------------------------------------------------------------------
  const workspaceUser = join(workspaceRoot, "user-scope");
  const workspaceProject = join(workspaceRoot, "project-scope");
  await mkdir(workspaceUser, { recursive: true });
  await mkdir(workspaceProject, { recursive: true });
  await writeJson(userConfigPath, {
    mcp: { servers: { browser: { command: "browser-cmd" }, rea: { command: "rea-cmd" } } },
  });
  await writeJson(workspaceConfigPath(workspaceProject), {
    mcp: { servers: { proj: { command: "proj-cmd" } } },
  });
  seedLegacyCommon();

  const webPlatform = makePlatformStub();
  setMcpStorePlatform(webPlatform, mcpSync);

  assert.equal(
    await store().ensureLoadedForWorkspace(workspaceUser, mcpSync, undefined, undefined),
    true,
    "独立 Web base Host 用户级配置应读取成功",
  );
  assert.deepEqual(serverNames(), ["browser", "rea"], "应展示服务端用户级 MCP");
  assert.equal(webPlatform.calls.load, 0, "不得回退到无桌面代理的 Web platform");
  assert.deepEqual(
    Object.keys(await readServers(userConfigPath)).sort(),
    ["browser", "rea"],
    "base Host 不得把旧 localStorage common 迁进服务器配置",
  );
  assert.ok(storage.has("zcode-mcp-config"), "未确认写入前不得清理旧 common");
  console.log("PASS 独立 Web base Host 用户级读取，旧 common 不误迁云端");

  assert.equal(
    await store().ensureLoadedForWorkspace(workspaceProject, mcpSync, undefined, undefined),
    true,
  );
  assert.deepEqual(serverNames(), ["browser", "proj", "rea"], "项目级应叠加服务器项目配置");
  assert.ok(
    store().servers.some((s) => s.name === "rea"),
    "store 投影（已安装分组数据源）应包含服务端 MCP",
  );
  console.log("PASS 独立 Web 项目级读取叠加用户级");

  // ---------------------------------------------------------------------------
  // 2. 独立 Web 保存与启停落盘到真实服务器配置
  // ---------------------------------------------------------------------------
  await store().addScopedMcpServer("zcodeagentmcp", "added", { command: "added-cmd" });
  let userServers = await readServers(userConfigPath);
  assert.equal(userServers.added?.command, "added-cmd", "保存应落到服务器用户配置");

  const reaServer = store().servers.find((s) => s.name === "rea");
  assert.ok(reaServer, "应能定位 rea server 条目");
  await store().toggleServer(reaServer.id, false);
  userServers = await readServers(userConfigPath);
  assert.equal(userServers.rea?.enabled, false, "启停应落到服务器配置");
  assert.equal(userServers.rea?.enable, undefined, "不得写回 legacy enable 字段");
  console.log("PASS 独立 Web 保存与启停真实落盘");

  // ---------------------------------------------------------------------------
  // 3. 桌面本机 platform 通道与 legacy common 迁移保持原样
  // ---------------------------------------------------------------------------
  const workspaceDesktop = join(workspaceRoot, "desktop-scope");
  await mkdir(workspaceDesktop, { recursive: true });
  seedLegacyCommon();
  const desktopPlatform = makePlatformStub();
  setMcpStorePlatform(desktopPlatform);
  assert.equal(
    await store().ensureLoadedForWorkspace(workspaceDesktop, undefined, undefined, undefined),
    true,
  );
  assert.ok(desktopPlatform.calls.load >= 1, "桌面本机目标应走 platform 通道读取");
  assert.equal(
    desktopPlatform.calls.savePayloads.some((p) => p.name === "legacy"),
    true,
    "桌面本机应保留 legacy common 迁移写入",
  );
  assert.equal(storage.has("zcode-mcp-config"), false, "桌面迁移完成后清理旧 common");
  console.log("PASS 桌面 platform 通道与 legacy common 迁移保持原样");

  // ---------------------------------------------------------------------------
  // 4. relay/home-only 未连桥：platform 通道失败时不提交假空、不置 ready
  // ---------------------------------------------------------------------------
  const workspaceHomeOnly = join(workspaceRoot, "home-only-scope");
  await mkdir(workspaceHomeOnly, { recursive: true });
  const homeOnlyPlatform = makePlatformStub({ failLoad: true });
  setMcpStorePlatform(homeOnlyPlatform);
  assert.equal(
    await store().ensureLoadedForWorkspace(workspaceHomeOnly, undefined, undefined, undefined),
    false,
    "未连桥读取失败应返回 false，保持 not-ready",
  );
  assert.deepEqual(serverNames(), [], "失败时不得把假空当成功提交");
  console.log("PASS relay/home-only 未连桥失败不静默写空");

  // ---------------------------------------------------------------------------
  // 5. 跨 Host 远端缺目录服务 fail-closed
  // ---------------------------------------------------------------------------
  const workspaceRemote = join(workspaceRoot, "remote-scope");
  await mkdir(workspaceRemote, { recursive: true });
  const remotePlatform = makePlatformStub();
  setMcpStorePlatform(remotePlatform);
  assert.equal(
    await store().ensureLoadedForWorkspace(
      workspaceRemote,
      undefined,
      "remote-identity",
      undefined,
    ),
    false,
    "远端目标缺目录服务必须 fail-closed",
  );
  assert.equal(remotePlatform.calls.load, 0, "远端目标严禁回退桌面本机 platform");
  assert.deepEqual(serverNames(), []);
  console.log("PASS 远端目标缺目录服务 fail-closed，不回退本机");

  // ---------------------------------------------------------------------------
  // 6. 跨 target 异步 stale 丢弃
  // ---------------------------------------------------------------------------
  const workspaceA = join(workspaceRoot, "stale-a");
  const workspaceB = join(workspaceRoot, "stale-b");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  const slowA = makeDirectoryService("a-slow", { delayMs: 60 });
  const fastB = makeDirectoryService("b-fast");
  setMcpStorePlatform(webPlatform, slowA);
  const pendingA = store().ensureLoadedForWorkspace(workspaceA, slowA, undefined, undefined);
  setMcpStorePlatform(webPlatform, fastB);
  const pendingB = store().ensureLoadedForWorkspace(workspaceB, fastB, undefined, undefined);
  const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
  assert.equal(resultA, false, "跨 target 旧读取应被丢弃");
  assert.equal(resultB, true);
  assert.deepEqual(serverNames(), ["b-fast"], "不得提交 A 的过期结果");
  assert.equal(store().currentProjectPath, workspaceB);
  console.log("PASS 跨 target 异步 stale 丢弃");

  // ---------------------------------------------------------------------------
  // 7. 同 target 换服务（重连）：旧 in-flight load 不得覆盖新 Host snapshot
  // ---------------------------------------------------------------------------
  const workspaceReconnect = join(workspaceRoot, "reconnect");
  await mkdir(workspaceReconnect, { recursive: true });
  const oldOwner = makeDirectoryService("old-owner", { delayMs: 60 });
  const freshOwner = makeDirectoryService("fresh-owner");
  setMcpStorePlatform(webPlatform, oldOwner);
  const pendingOld = store().ensureLoadedForWorkspace(
    workspaceReconnect,
    oldOwner,
    undefined,
    undefined,
  );
  await sleep(10);
  setMcpStorePlatform(webPlatform, freshOwner);
  const pendingFresh = store().ensureLoadedForWorkspace(
    workspaceReconnect,
    freshOwner,
    undefined,
    undefined,
  );
  const [resultOld, resultFresh] = await Promise.all([pendingOld, pendingFresh]);
  assert.equal(resultOld, false, "同 target 换服务后旧 load 不得返回成功");
  assert.equal(resultFresh, true);
  assert.deepEqual(serverNames(), ["fresh-owner"], "新 Host snapshot 不得被旧配置覆盖");
  assert.equal(store().currentDirectoryService, freshOwner);
  console.log("PASS 同 target 换服务时旧 load 丢弃");

  // ---------------------------------------------------------------------------
  // 8. base Host pending（null）：拒读且不误迁旧 common
  // ---------------------------------------------------------------------------
  const workspacePending = join(workspaceRoot, "base-pending");
  await mkdir(workspacePending, { recursive: true });
  seedLegacyCommon();
  const pendingPlatform = makePlatformStub();
  setMcpStorePlatform(pendingPlatform, null);
  assert.equal(
    await store().ensureLoadedForWorkspace(workspacePending, undefined, undefined, undefined),
    false,
    "base Host 服务未绑定时必须 fail-closed",
  );
  assert.equal(pendingPlatform.calls.load, 0, "base Host pending 不得回退 Web platform");
  assert.equal(pendingPlatform.calls.save, 0, "base Host pending 不得通过 platform 落盘");
  assert.deepEqual(serverNames(), []);
  assert.ok(storage.has("zcode-mcp-config"), "base Host pending 不得迁移旧 common");
  console.log("PASS base Host pending 拒读且不误迁");

  // ---------------------------------------------------------------------------
  // 9. 入口 setter 单独换绑（不重新 ensure）：旧 in-flight load 必须失效
  //    对应 Root layout setter 已换成 baseB / pending，但子组件还没发起新 ensure 的窗口。
  // ---------------------------------------------------------------------------
  const workspaceSetter = join(workspaceRoot, "setter-rebind");
  await mkdir(workspaceSetter, { recursive: true });
  const setterOldBase = makeDirectoryService("setter-old-base", { delayMs: 60 });
  const setterNewBase = makeDirectoryService("setter-new-base");
  setMcpStorePlatform(webPlatform, setterOldBase);
  const pendingSetterOld = store().ensureLoadedForWorkspace(
    workspaceSetter,
    setterOldBase,
    undefined,
    undefined,
  );
  await sleep(10);
  // 只改入口归属，不调用新的 ensure。
  setMcpStorePlatform(webPlatform, setterNewBase);
  assert.equal(await pendingSetterOld, false, "入口换绑后旧 load 不得返回成功");
  assert.deepEqual(serverNames(), [], "入口换绑后旧 Host 结果不得提交");
  // 新绑定自己的 ensure 仍应正常读取新 Host。
  assert.equal(
    await store().ensureLoadedForWorkspace(workspaceSetter, setterNewBase, undefined, undefined),
    true,
  );
  assert.deepEqual(serverNames(), ["setter-new-base"]);
  console.log("PASS 入口 setter 换绑时旧 load 失效");

  // 同样窗口切换到 base Host pending(null)：旧 load 也不得提交、不得迁移。
  const setterPendingOld = makeDirectoryService("setter-pending-old", { delayMs: 60 });
  setMcpStorePlatform(webPlatform, setterPendingOld);
  const pendingBeforeNull = store().ensureLoadedForWorkspace(
    workspaceSetter,
    setterPendingOld,
    undefined,
    undefined,
  );
  await sleep(10);
  seedLegacyCommon();
  setMcpStorePlatform(webPlatform, null);
  assert.equal(await pendingBeforeNull, false, "入口切到 pending 后旧 load 不得返回成功");
  // 同一 target 只换绑服务不清空已有投影（既有行为），这里只要求旧 load 的结果不被提交。
  assert.deepEqual(
    serverNames(),
    ["setter-new-base"],
    "入口切到 pending 后旧结果不得提交，也不得清掉既有投影",
  );
  assert.ok(storage.has("zcode-mcp-config"), "入口切到 pending 不得触发旧 common 迁移");
  console.log("PASS 入口 setter 切到 pending 时旧 load 失效");

  // ---------------------------------------------------------------------------
  // 10. 同一 base Host、不同 directoryService wrapper 并发 ensure 不得互相取消
  //     设置页与会话 hook 各自传 wrapper 对象；base 归属未变时真实 base 读取必须照常回包。
  // ---------------------------------------------------------------------------
  const workspaceWrapper = join(workspaceRoot, "wrapper-same-base");
  await mkdir(workspaceWrapper, { recursive: true });
  const baseCalls = { load: 0, save: 0 };
  const slowBaseHost = {
    loadMcpFromUserDirectory: async (payload) => {
      baseCalls.load += 1;
      await sleep(50);
      return mcpSync.loadMcpFromUserDirectory(payload);
    },
    saveMcpToUserDirectory: async (payload) => {
      baseCalls.save += 1;
      return mcpSync.saveMcpToUserDirectory(payload);
    },
  };
  const wrapperOne = {
    loadMcpFromUserDirectory: (payload) => slowBaseHost.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => slowBaseHost.saveMcpToUserDirectory(payload),
  };
  const wrapperTwo = {
    loadMcpFromUserDirectory: (payload) => slowBaseHost.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => slowBaseHost.saveMcpToUserDirectory(payload),
  };
  setMcpStorePlatform(webPlatform, slowBaseHost);
  const ensureWrapperOne = store().ensureLoadedForWorkspace(
    workspaceWrapper,
    wrapperOne,
    undefined,
    undefined,
  );
  await sleep(10);
  const ensureWrapperTwo = store().ensureLoadedForWorkspace(
    workspaceWrapper,
    wrapperTwo,
    undefined,
    undefined,
  );
  const [wrapperResultOne, wrapperResultTwo] = await Promise.all([
    ensureWrapperOne,
    ensureWrapperTwo,
  ]);
  assert.equal(wrapperResultOne, true, "同 base 的不同 wrapper ensure 不得取消真实 base 读取");
  assert.equal(wrapperResultTwo, true);
  assert.ok(baseCalls.load >= 1, "必须真实读取 base Host");
  assert.deepEqual(serverNames(), ["added", "browser", "rea"], "投影必须来自真实 base Host 回包");
  console.log("PASS 同 base Host 不同 wrapper 并发 ensure 不互相取消");

  // ---------------------------------------------------------------------------
  // 11. base Host 模式下手动 legacy common 迁移必须是 no-op
  // ---------------------------------------------------------------------------
  seedLegacyCommon();
  const beforeMigrateNames = serverNames();
  assert.deepEqual(
    await store().migrateLegacyCommonMcp(),
    { totalCount: 0, importedCount: 0, skippedCount: 0 },
    "base Host 模式下手动 legacy 迁移必须 no-op",
  );
  assert.deepEqual(serverNames(), beforeMigrateNames, "no-op 不得覆盖真实 base 列表");
  assert.ok(storage.has("zcode-mcp-config"), "no-op 不得清理旧 common");
  console.log("PASS base Host 手动 legacy 迁移 no-op");

  console.log("ALL PASS standalone-mcp-routing");
}
