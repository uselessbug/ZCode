/* eslint-disable max-lines -- 独立 HTTP 定时任务执行链与冻结目录快照回归集中在单脚本。 */
// 独立 HTTP 定时任务执行链回归：真实 SQLite + AutomationRepo + AutomationService +
// SourceServerWorkspaceAliasRepo + automation-runtime + node.ts createServerHostServices。
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-automation-runtime.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const esbuildPath = (() => {
  try {
    return require.resolve("esbuild");
  } catch {
    return join(
      dirname(dirname(realpathSync(join(repoRoot, "node_modules/.bin/esbuild")))),
      "lib/main.js",
    );
  }
})();
const { build } = await import(pathToFileURL(esbuildPath).href);
const temporary = await mkdtemp(join(tmpdir(), "zcode-automation-runtime-"));
const ENV_KEYS = [
  "HOME",
  "ZCODE_DATA_DIR",
  "ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS",
  "ZCODE_CREDENTIAL_SECRET",
  "ZCODE_AGENT_SERVER_COMMAND",
  "ZCODE_AGENT_SERVER_ARGS_JSON",
  "ZCODE_DEFAULT_WORKSPACE_DIR",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let db;
let mod;
let hostServicesEnabled;
let hostServicesDisabled;
let frozenServices;

try {
  const shared = join(repoRoot, "packages/shared/src");
  const services = join(repoRoot, "packages/services/src");
  const cronerShim = join(temporary, "croner-shim.ts");
  const noopShim = join(temporary, "noop-shim.ts");
  await Promise.all([
    writeFile(
      cronerShim,
      `export class Cron { private readonly expr: string; constructor(expr: string) { const parts = expr.trim().split(/\\s+/); if (parts.length !== 5 || parts.some((p) => !/^[\\d*,/-]+$/.test(p))) throw new Error("Invalid cron"); this.expr = expr.trim(); } nextRun(from?: Date): Date | null { const base = from ? from.getTime() : Date.now(); const first = this.expr.split(/\\s+/)[0]; if (first.startsWith("*/")) { const n = Number(first.slice(2)); if (Number.isInteger(n) && n > 0) return new Date(Math.floor(base / (n * 60_000) + 1) * n * 60_000); } return new Date(base + 60_000); } previousRuns(_limit: number, from?: Date): Date[] { return [new Date((from?.getTime() ?? Date.now()) - 60_000)]; } }`,
    ),
    writeFile(
      noopShim,
      `export default {}; export const watch = () => ({ on: () => {}, close: async () => {} }); export const fetch = async () => { throw new Error("unexpected fetch"); }; export const Agent = class {}; export const ProxyAgent = class {}; export const WebSocket = class {}; export const parse = () => ({}); export const open = () => {}; export const ZipFile = class {}; export const Entry = {}; export const pki = {}; export const random = { getBytesSync: () => "" }; export const EntryClass = class {}; export const Client = class {};`,
    ),
  ]);
  const outfile = join(temporary, "automation-bundle.cjs");
  const resolveExternal = (path, importer) => {
    if (path === "electron") return { path, external: true };
    try {
      const resolved = (importer ? createRequire(importer) : require).resolve(path);
      return isAbsolute(resolved) ? { path: resolved } : { path, external: true };
    } catch {
      return { path: noopShim };
    }
  };
  await build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(join(services, "node.ts"))};`,
        `export { createProjectService } from ${JSON.stringify(join(services, "project/index.ts"))};`,
        `export { IZCodeAgentService, IProjectService, IModelSelectionService, IProviderSettingsService, ICredentialService } from ${JSON.stringify(join(services, "index.ts"))};`,
        `export { projectStorage } from ${JSON.stringify(join(services, "project-storage/index.ts"))};`,
        `export { TaskIndexRepo } from ${JSON.stringify(join(services, "session/taskIndexRepo.ts"))};`,
        `export { runTasksDatabaseMigrations } from ${JSON.stringify(join(services, "session/tasksDatabase/migrations.ts"))};`,
        `export { createServerCredentialCipher } from ${JSON.stringify(join(shared, "credential-security/module.ts"))};`,
        `export { buildServerRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from ${JSON.stringify(join(shared, "index.ts"))};`,
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(outfile).href) },
    logLevel: "silent",
    plugins: [
      {
        name: "source-only-automation-fixture",
        setup(b) {
          b.onResolve({ filter: /^croner$/ }, () => {
            try {
              return { path: require.resolve("croner") };
            } catch {
              return { path: cronerShim };
            }
          });
          b.onResolve({ filter: /^@zcode\// }, ({ path }) => {
            const [, name, ...subpath] = path.split("/");
            const packageRoot = join(repoRoot, "packages", name);
            const entry = require(join(packageRoot, "package.json")).exports?.[
              subpath.length ? `./${subpath.join("/")}` : "."
            ];
            return {
              path: join(
                packageRoot,
                typeof entry === "string" ? entry : (entry?.import ?? entry?.default),
              ),
            };
          });
          b.onResolve({ filter: /^#session-control\// }, ({ path }) => ({
            path: join(repoRoot, "packages/session-control/src", `${path.slice(17)}.ts`),
          }));
          b.onResolve({ filter: /^#src\// }, ({ path, importer }) => ({
            path: join(
              importer.startsWith(shared) ? shared : services,
              path.slice(5).replace(/\.js$/, ".ts"),
            ),
          }));
          b.onResolve({ filter: /^[^./#@][^:]*$/ }, ({ path, importer }) =>
            resolveExternal(path, importer),
          );
          b.onResolve({ filter: /^@[^/]+\/[^/]+/ }, ({ path, importer }) =>
            path.startsWith("@zcode/") ? null : resolveExternal(path, importer),
          );
        },
      },
    ],
  });

  mod = require(outfile);
  const { AutomationRepo, AutomationService, createAutomationRuntime, createAutomationExecutor } =
    mod;
  const { buildServerRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } = mod;

  const dataBaseDir = join(temporary, "data-base");
  const homeDir = join(temporary, "home");
  await Promise.all([mkdir(dataBaseDir, { recursive: true }), mkdir(homeDir, { recursive: true })]);
  process.env.HOME = homeDir;
  process.env.ZCODE_DATA_DIR = dataBaseDir;
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";
  mod.setDataBaseDir(dataBaseDir);

  const serverId = "http-runtime-test";
  const serverIdentity = (workspacePath) =>
    buildServerRemoteWorkspaceIdentity({ serverId, workspacePath });
  const ownerHostId = remoteHostIdFromWorkspaceIdentity(serverIdentity("/"));
  const dbPath = join(temporary, "runtime-unit.sqlite");
  const workspaceRoot = join(temporary, "workspace");
  const dirNames =
    "proj-a legacy-a explicit-local-a ssh-only-a shared-alias-a coexist-no-alias-a foreign-a".split(
      " ",
    );
  const [
    projectDir,
    legacyDir,
    explicitLocalDir,
    sshOnlyDir,
    sharedAliasDir,
    coexistNoAliasDir,
    foreignDir,
  ] = dirNames.map((name) => join(workspaceRoot, name));
  await Promise.all(
    [
      projectDir,
      legacyDir,
      explicitLocalDir,
      sshOnlyDir,
      sharedAliasDir,
      coexistNoAliasDir,
      foreignDir,
    ].map((d) => mkdir(d, { recursive: true })),
  );

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  await mod.runTasksDatabaseMigrations(db, { dbPath });
  await mod.projectStorage.migrate(db, {
    hostId: ownerHostId,
    backupDirectories: [join(temporary, "backup")],
  });

  const aliasRepo = new mod.SourceServerWorkspaceAliasRepo({
    taskDbPath: dbPath,
    sessionDbPath: join(temporary, "cli-db.sqlite"),
    backupRoot: join(temporary, "alias-backups"),
  });
  const sourceServerWorkspaceService = mod.createSourceServerWorkspaceService(aliasRepo, {
    defaultWorkspaceIdentity: serverIdentity,
  });

  const standalonePolicy = {
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspaceRoot,
    allowStandaloneMultiRoot: true,
  };
  const projectRepo = mod.projectStorage.repository(db, ownerHostId, standalonePolicy);
  const projectService = mod.createProjectService({
    repository: async () => projectRepo,
    ownerHostId,
    workspaceDirectory: workspaceRoot,
    ...standalonePolicy,
  });
  const savedProject = await projectService.saveProject({
    hostId: ownerHostId,
    name: "Runtime Project",
    roots: [projectDir],
  });

  const repo = new AutomationRepo(dbPath);
  await repo.ensureReady();

  // ---- 测试 1：UI 项目创建与会话内创建固化服务器 hostId 与 canonical workspaceIdentity ----
  let wakeCount = 0;
  let runtimeRef = null;
  const resolveCanonical = (workspacePath) =>
    sourceServerWorkspaceService.resolveWorkspace({ workspacePath });
  const service = new AutomationService(
    repo,
    async (projectId) => {
      const prepared = await projectService.prepareSession({ projectId });
      const { canonicalWorkspaceKey } = await resolveCanonical(prepared.workspacePath);
      return { ...prepared, hostId: ownerHostId, workspaceIdentity: canonicalWorkspaceKey };
    },
    {
      onWake: () => {
        wakeCount += 1;
        runtimeRef?.wake();
      },
      resolveExecutionContext: async (target) => {
        const { canonicalWorkspaceKey } = await resolveCanonical(target.workspacePath);
        const identity = target.workspaceIdentity?.trim();
        if (
          identity &&
          identity !== canonicalWorkspaceKey &&
          identity !== serverIdentity(target.workspacePath)
        ) {
          throw new Error("Automation workspace does not belong to this server");
        }
        return { hostId: ownerHostId, workspaceIdentity: canonicalWorkspaceKey };
      },
      defaultHostId: ownerHostId,
    },
  );

  const expectedProjectIdentity = serverIdentity(projectDir);
  const uiAutomation = await service.create({
    projectId: savedProject.id,
    title: "UI Project Cron",
    cronExpr: "*/5 * * * *",
    prompt: "Check repo",
    workspacePath: projectDir,
    recurring: true,
  });
  const sessionAutomation = await service.create({
    title: "Session Bound Cron",
    cronExpr: "0 9 * * *",
    prompt: "Summarize task",
    workspacePath: projectDir,
    targetTaskId: "sess-bound-1",
    recurring: true,
  });
  for (const created of [uiAutomation, sessionAutomation]) {
    assert.equal(created.hostId, ownerHostId);
    assert.equal(created.workspaceIdentity, expectedProjectIdentity);
    assert.equal(created.workspaceKey, expectedProjectIdentity);
  }

  await assert.rejects(
    service.create({
      title: "Foreign Rejected",
      cronExpr: "0 9 * * *",
      prompt: "Bad",
      workspacePath: projectDir,
      workspaceIdentity: "remote:server:foreign:/other",
      recurring: true,
    }),
    /does not belong to this server/,
  );
  await service.delete(uiAutomation.automationId);
  await service.delete(sessionAutomation.automationId);
  console.log("PASS UI 项目创建与会话内创建均固化服务器 hostId 与 canonical workspaceIdentity");

  const pastDue = Date.now() - 30_000;
  const seedCase = async (title, dir, identity, hostId) => {
    const created = await repo.create(
      {
        title,
        prompt: title,
        cronExpr: "*/5 * * * *",
        recurring: false,
        maxRuns: 1,
        workspacePath: dir,
        ...(identity ? { workspaceIdentity: identity } : {}),
        ...(hostId ? { hostId } : {}),
      },
      { nextRunAt: pastDue },
    );
    await repo.ensureRunClaimed({
      runId: `${created.automationId}:seed-run`,
      automationId: created.automationId,
      workspaceKey: identity && identity !== dir ? identity : dir,
      scheduledAt: pastDue - 60_000,
      trigger: "schedule",
    });
    return created;
  };
  await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: sharedAliasDir });
  const sshId = (dir) => `remote:ssh:ssh-host:22:alice:${dir}`;
  const srvOtherId = (dir) =>
    buildServerRemoteWorkspaceIdentity({ serverId: "other-server", workspacePath: dir });
  const alignedCases = [
    [await seedCase("Legacy", legacyDir), legacyDir],
    [await seedCase("Explicit", explicitLocalDir, explicitLocalDir, "local"), explicitLocalDir],
    [await seedCase("Coexist Alias", sharedAliasDir, sharedAliasDir, "local"), sharedAliasDir],
    [
      await seedCase("Coexist NoAlias", coexistNoAliasDir, coexistNoAliasDir, "local"),
      coexistNoAliasDir,
    ],
  ];
  const foreignCases = [
    [await seedCase("SSH", sshOnlyDir, sshId(sshOnlyDir)), sshId(sshOnlyDir), undefined],
    [
      await seedCase("SharedSSH", sharedAliasDir, sshId(sharedAliasDir)),
      sshId(sharedAliasDir),
      undefined,
    ],
    [
      await seedCase("SharedOther", sharedAliasDir, srvOtherId(sharedAliasDir)),
      srvOtherId(sharedAliasDir),
      undefined,
    ],
    [
      await seedCase("CoexistSSH", coexistNoAliasDir, sshId(coexistNoAliasDir)),
      sshId(coexistNoAliasDir),
      undefined,
    ],
    [
      await seedCase("Foreign", foreignDir, srvOtherId(foreignDir), "remote:server:foreign-server"),
      srvOtherId(foreignDir),
      "remote:server:foreign-server",
    ],
  ];

  const prompts = [];
  const unreadCalls = [];
  const terminalListeners = new Map();
  let promptGate = null;
  let seq = 0;

  const taskService = {
    createTask: async (params) => ({ taskId: `task-created-${++seq}`, ...params }),
    resumeTask: async () => {},
    setAutomationSessionConfig: async () => {},
    setConfigOption: async () => {},
    sendPrompt: async (params) => {
      prompts.push(params);
      if (promptGate) await promptGate();
      return {};
    },
    setTaskUnread: async (params) => {
      unreadCalls.push(params);
      return {};
    },
    onDynamicTaskTerminalOutcome: (taskId) => (listener) => {
      const set = terminalListeners.get(taskId) ?? new Set();
      set.add(listener);
      terminalListeners.set(taskId, set);
      return { dispose: () => set.delete(listener) };
    },
  };
  const emitTerminal = (event) => {
    for (const listener of Array.from(terminalListeners.get(event.taskId) ?? [])) listener(event);
  };
  const preferredModel = {
    providerId: "zai",
    modelId: "glm-5",
    options: { reasoningLevel: "medium" },
  };
  const modelSelectionService = {
    getView: async (input) =>
      input?.selection
        ? { effectiveSelection: input.selection }
        : { preferredSelection: preferredModel },
  };
  const armPromptGate = () => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    promptGate = () => {
      promptGate = null;
      entered.resolve();
      return gate.promise;
    };
    return { entered: entered.promise, resolve: gate.resolve, reject: gate.reject };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, label, timeoutMs = 4_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return;
      await sleep(15);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  };
  const createProjDue = (title, offsetMs, extra = {}) =>
    repo.create(
      {
        title,
        cronExpr: "*/5 * * * *",
        prompt: title,
        workspacePath: projectDir,
        workspaceIdentity: expectedProjectIdentity,
        hostId: ownerHostId,
        recurring: true,
        ...extra,
      },
      { nextRunAt: Date.now() + offsetMs },
    );

  const runtime = createAutomationRuntime({
    repo,
    cron: {
      computeNextRunAt: mod.computeAutomationNextRunAt,
      isOneShotAutomation: mod.isOneShotAutomation,
    },
    resolveTargetServices: () => ({ taskService, modelSelectionService }),
    logger: {
      info: () => {},
      warn: () => {},
      error: (msg, err) => console.error("[test-runtime]", msg, err),
    },
    pollIntervalMs: 60_000,
    heartbeatIntervalMs: 40,
    standaloneAuthority: {
      projectStorageHostId: ownerHostId,
      resolveWorkspace: async (workspacePath) => ({
        canonicalWorkspaceKey:
          (await repo.readWorkspaceAliasCanonicalKey(workspacePath)) ??
          serverIdentity(workspacePath),
      }),
    },
  });
  runtimeRef = runtime;

  await runtime.start();
  await waitUntil(async () => {
    const okRows = await Promise.all(alignedCases.map(([a]) => repo.get(a.automationId)));
    const failRows = await Promise.all(foreignCases.map(([a]) => repo.get(a.automationId)));
    return (
      okRows.every((r) => r?.runCount === 1) &&
      failRows.every((r) => r?.lifecycleStatus === "failed")
    );
  }, "startup alignment + due dispatch + foreign rejection");

  for (const [auto, dirPath] of alignedCases) {
    const expectedKey = serverIdentity(dirPath);
    const row = await repo.get(auto.automationId);
    assert.equal(row.workspaceKey, expectedKey);
    assert.equal(row.workspaceIdentity, expectedKey);
    assert.equal(row.hostId, ownerHostId);
    assert.equal(row.runCount, 1);
    assert.equal(row.lifecycleStatus, "completed");
    assert.equal(row.enabled, false);
    assert.equal(row.nextRunAt, undefined);
    assert.ok(
      (await repo.listRuns(auto.automationId)).every((r) => r.workspaceKey === expectedKey),
    );
    assert.ok(prompts.some((p) => p.automationId === auto.automationId));
  }

  for (const untouchedDir of [sshOnlyDir, coexistNoAliasDir]) {
    assert.equal(
      db.prepare("SELECT canonical_key FROM workspace_alias WHERE path = ?").get(untouchedDir),
      undefined,
      `异域/共存只读对齐不得触发写入 workspace_alias (${untouchedDir})`,
    );
  }
  for (const [auto, expectedKey, expectedHostId] of foreignCases) {
    const row = await repo.get(auto.automationId);
    assert.equal(row.workspaceKey, expectedKey);
    assert.equal(row.workspaceIdentity, expectedKey);
    assert.equal(row.hostId, expectedHostId, `异域记录 ${auto.automationId} hostId 不得回落`);
    assert.equal(row.lifecycleStatus, "failed");
    assert.equal(row.dispatchStatus, "failed_to_dispatch");
    assert.ok(!prompts.some((p) => p.automationId === auto.automationId));
    assert.equal((await repo.getRun(`${auto.automationId}:seed-run`))?.workspaceKey, expectedKey);
  }
  console.log("PASS 存量缺失/显式本地路径启动对齐，异域 remote:ssh/server 同路径零篡改且拒绝派发");

  // ---- 测试 3：周期任务推进 nextRunAt + 重复回执不重复累加计数 ----
  const recurringDue = await createProjDue("Recurring Due", -10_000);
  runtime.wake();
  await waitUntil(
    async () => (await repo.get(recurringDue.automationId))?.runCount === 1,
    "recurring due",
  );
  const afterRecurring = await repo.get(recurringDue.automationId);
  assert.ok(afterRecurring.nextRunAt > Date.now() - 1_000);
  const recurringRuns = await repo.listRuns(recurringDue.automationId);
  assert.equal(
    await repo.markScheduleRunDispatched({
      runId: recurringRuns[0].runId,
      automationId: recurringDue.automationId,
      sessionId: recurringRuns[0].sessionId ?? null,
      dispatchedAt: Date.now() + 1_000,
      nextRunAt: Date.now() + 999_999,
    }),
    false,
  );
  assert.equal((await repo.get(recurringDue.automationId)).runCount, 1);
  assert.equal((await repo.get(recurringDue.automationId)).nextRunAt, afterRecurring.nextRunAt);
  console.log("PASS 周期任务推进 nextRunAt 且按 runId 幂等结算不重复计数");

  // ---- 测试 4：runAutomationNow 立即派发、duplicate 拒绝、60s 心跳续租、匹配 runId 终态释放后 wake ----
  const manualAuto = await createProjDue("Manual Single Flight", 3_600_000, {
    cronExpr: "0 9 * * *",
  });
  const futureNextRun = manualAuto.nextRunAt;
  const scope = { workspacePath: projectDir, workspaceIdentity: expectedProjectIdentity };
  const readClaim = () =>
    db
      .prepare("SELECT running, claimed_at FROM automations WHERE automation_id = ?")
      .get(manualAuto.automationId);
  const runNow1 = await service.runNow(manualAuto.automationId, scope);
  assert.ok(runNow1);
  assert.equal(await service.runNow(manualAuto.automationId, scope), null);

  await runtime.dispatchManualRun(runNow1);
  assert.equal((await repo.get(manualAuto.automationId)).runCount, 1);
  assert.equal((await repo.get(manualAuto.automationId)).nextRunAt, futureNextRun);
  assert.equal(await repo.getScheduledRunCount(manualAuto.automationId), 0);

  const claimBefore = readClaim();
  assert.equal(claimBefore.running, 1);
  await sleep(95);
  assert.ok(readClaim().claimed_at > claimBefore.claimed_at, "心跳续租应推进 claimed_at");

  const manualRunRecord = await repo.getRun(runNow1.run.runId);
  emitTerminal({
    taskId: manualRunRecord.sessionId,
    inputId: "unrelated-input-id",
    outcome: "failed",
    error: "wrong",
  });
  await sleep(20);
  assert.equal((await repo.getRun(runNow1.run.runId)).outcome, "running");

  emitTerminal({
    taskId: manualRunRecord.sessionId,
    inputId: runNow1.run.runId,
    outcome: "succeeded",
  });
  await waitUntil(
    async () =>
      readClaim().running === 0 && (await repo.getRun(runNow1.run.runId))?.outcome === "succeeded",
    "matching terminal outcome settles run and releases claim",
  );
  assert.ok(unreadCalls.some((u) => u.taskId === manualRunRecord.sessionId && u.unread === true));

  const runNow2 = await service.runNow(manualAuto.automationId, scope);
  assert.ok(runNow2);
  await runtime.dispatchManualRun(runNow2);
  emitTerminal({
    taskId: (await repo.getRun(runNow2.run.runId)).sessionId,
    inputId: runNow2.run.runId,
    outcome: "succeeded",
  });
  await waitUntil(async () => readClaim().running === 0, "second manual run settled");
  console.log("PASS runAutomationNow 单飞锁、心跳续租、runId 终态匹配与锁释放");

  // ---- 测试 5：create / update / restart 触发 wake，且 tick 执行中并发 wake 不丢失 ----
  const wakeBaseline = wakeCount;
  const createdForWake = await service.create({
    title: "Wake Test",
    cronExpr: "0 9 * * *",
    prompt: "Initial",
    workspacePath: projectDir,
    recurring: true,
  });
  assert.ok(wakeCount > wakeBaseline);
  const w1 = wakeCount;
  await service.update(createdForWake.automationId, { title: "Wake Test Updated" }, scope);
  assert.ok(wakeCount > w1);
  await repo.markDispatchFailed(createdForWake.automationId, {
    failedAt: Date.now(),
    error: "err",
    kind: "permanent",
  });
  const w2 = wakeCount;
  await service.restart(createdForWake.automationId, scope);
  assert.ok(wakeCount > w2);

  const coalesceGate = armPromptGate();
  const batch1 = await createProjDue("Coalesce Batch 1", -1_000, { recurring: false, maxRuns: 1 });
  runtime.wake();
  await coalesceGate.entered;
  const batch2 = await createProjDue("Coalesce Batch 2", -500, { recurring: false, maxRuns: 1 });
  runtime.wake();
  runtime.wake();
  coalesceGate.resolve();
  await waitUntil(
    async () =>
      (await repo.get(batch1.automationId))?.runCount === 1 &&
      (await repo.get(batch2.automationId))?.runCount === 1,
    "concurrent wake during tick must rerun immediately",
  );
  console.log("PASS create/update/restart 触发 wake 且 tick 执行中并发 wake 合并补跑不丢失");

  // ---- 测试 6：runtime.dispose 与 executor.disposeAndWait 门控 sendPrompt ACK 关闭竞态 ----
  const runtimeGate = armPromptGate();
  const shutdownManual = await service.runNow(manualAuto.automationId, scope);
  const inFlightManualPromise = runtime.dispatchManualRun(shutdownManual);
  await runtimeGate.entered;
  let disposeSettled = false;
  const disposePromise = runtime.dispose().then(() => {
    disposeSettled = true;
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(disposeSettled, false);
  assert.equal(runtime.canAcceptManualRun(), false);
  await assert.rejects(runtime.dispatchManualRun(shutdownManual), /disposed/);
  runtimeGate.resolve();
  await inFlightManualPromise;
  await disposePromise;
  await repo.releaseManualClaim(manualAuto.automationId, expectedProjectIdentity);
  repo.close();

  const runExecutorDisposeRace = async (mode) => {
    const execRepo = new AutomationRepo(dbPath);
    await execRepo.ensureReady();
    const exec = createAutomationExecutor({
      repo: execRepo,
      resolveTargetServices: () => ({ taskService, modelSelectionService }),
      logger: { info: () => {}, warn: () => {} },
    });
    const gate = armPromptGate();
    const claimed = await execRepo.runNow(manualAuto.automationId, { now: Date.now() });
    assert.ok(claimed);
    const flight = exec.dispatchManualRun(claimed);
    await gate.entered;
    let waitDone = false;
    const waitPromise = exec.disposeAndWait().then(() => {
      waitDone = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(waitDone, false, `executor.disposeAndWait 必须等待在途 ${mode} 完成`);
    await assert.rejects(exec.dispatchManualRun(claimed), /disposed/);
    if (mode === "success") {
      gate.resolve();
      await flight;
    } else {
      gate.reject(new Error("delayed sendPrompt failure"));
      await assert.rejects(flight, /delayed sendPrompt failure/);
    }
    await waitPromise;
    execRepo.close();
    const verifyRepo = new AutomationRepo(dbPath);
    const run = await verifyRepo.getRun(claimed.run.runId);
    if (mode === "success") {
      assert.equal(run?.dispatchStatus, "dispatched");
      await verifyRepo.releaseManualClaim(manualAuto.automationId, expectedProjectIdentity);
    } else {
      assert.equal(run?.dispatchStatus, "failed_to_dispatch");
      assert.equal(run?.outcome, "failed");
    }
    verifyRepo.close();
  };
  await runExecutorDisposeRace("success");
  await runExecutorDisposeRace("failure");
  await new Promise((r) => setTimeout(r, 60));
  console.log(
    "PASS runtime.dispose 与 executor.disposeAndWait 等待在途 ACK/失败结算后关库且零悬空写库",
  );

  // ---- 测试 7：真实 node.ts createServerHostServices automationExecutionEnabled 默认 false vs true ----
  process.env.ZCODE_CREDENTIAL_SECRET = randomBytes(32).toString("hex");
  const cipher = await mod.createServerCredentialCipher({
    filePath: join(temporary, "credentials.json"),
    env: process.env,
  });
  const builtinCfg = join(temporary, "builtin-provider.json");
  await writeFile(
    builtinCfg,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: { providerConfigRules: {}, modelConfigRules: {} },
    }),
  );
  const autoTarget = (a) => ({
    automationId: a.automationId,
    workspacePath: a.workspacePath,
    workspaceIdentity: a.workspaceIdentity,
  });
  const createHost = (sourceServerId, automationExecutionEnabled = false) =>
    mod.createServerHostServices({
      sourceServerId,
      zcodeBuiltinProviderConfigFilePath: builtinCfg,
      credentialCipherProvider: cipher,
      automationExecutionEnabled,
    });

  hostServicesDisabled = await createHost("srv-disabled");
  const agentDisabled = hostServicesDisabled.services.get(mod.IZCodeAgentService);
  const createdViaDisabled = await agentDisabled.createAutomation({
    title: "Disabled Flag Check",
    cronExpr: "0 9 * * *",
    prompt: "No-op",
    workspacePath: legacyDir,
  });
  await assert.rejects(agentDisabled.runAutomationNow(autoTarget(createdViaDisabled)), {
    message: "Automation immediate dispatcher is unavailable.",
  });
  assert.equal((await agentDisabled.listAutomationRuns(autoTarget(createdViaDisabled))).length, 0);
  await mod.disposeServiceResourcesAndWait(hostServicesDisabled.services);
  hostServicesDisabled = undefined;

  // 在 node.ts 真实装配前于默认库播种同路径共存的本地历史定义与异域 SSH 定义，验证真实启动对齐零篡改
  const srvCoexistRepo = new AutomationRepo();
  await srvCoexistRepo.ensureReady();
  const srvCoexistSshId = `remote:ssh:ssh-host:22:alice:${explicitLocalDir}`;
  const seedSrv = (t, id, hostId) =>
    srvCoexistRepo.create(
      {
        title: t,
        cronExpr: "0 9 * * *",
        prompt: t,
        workspacePath: explicitLocalDir,
        workspaceIdentity: id,
        hostId,
        recurring: true,
      },
      { nextRunAt: Date.now() + 3_600_000 },
    );
  const srvLocalHist = await seedSrv("Srv Coexist Local", explicitLocalDir, "local");
  const srvForeignSsh = await seedSrv(
    "Srv Coexist SSH",
    srvCoexistSshId,
    "remote:ssh:ssh-host:22:alice",
  );
  await srvCoexistRepo.ensureRunClaimed({
    runId: `${srvForeignSsh.automationId}:seed`,
    automationId: srvForeignSsh.automationId,
    workspaceKey: srvCoexistSshId,
    scheduledAt: Date.now(),
    trigger: "schedule",
  });
  srvCoexistRepo.close();

  hostServicesEnabled = await createHost("srv-enabled", true);
  const srvEnabledIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: "srv-enabled",
    workspacePath: explicitLocalDir,
  });
  const srvVerifyRepo = new AutomationRepo();
  const alignedSrvLocal = await srvVerifyRepo.get(srvLocalHist.automationId);
  const untouchedSrvSsh = await srvVerifyRepo.get(srvForeignSsh.automationId);
  assert.equal(alignedSrvLocal?.workspaceIdentity, srvEnabledIdentity);
  assert.equal(alignedSrvLocal?.hostId, "remote:server:srv-enabled");
  assert.equal(untouchedSrvSsh?.workspaceIdentity, srvCoexistSshId);
  assert.equal(untouchedSrvSsh?.workspaceKey, srvCoexistSshId);
  assert.equal(untouchedSrvSsh?.hostId, "remote:ssh:ssh-host:22:alice");
  assert.equal(
    (await srvVerifyRepo.getRun(`${srvForeignSsh.automationId}:seed`))?.workspaceKey,
    srvCoexistSshId,
  );
  srvVerifyRepo.close();

  const projEnabled = await hostServicesEnabled.services
    .get(mod.IProjectService)
    .saveProject({ name: "HTTP Enabled Proj", roots: [projectDir] });
  const agentEnabled = hostServicesEnabled.services.get(mod.IZCodeAgentService);
  const createdOnEnabled = await agentEnabled.createAutomation({
    projectId: projEnabled.id,
    title: "Enabled Server Cron",
    cronExpr: "0 9 * * *",
    prompt: "Check",
    workspacePath: projectDir,
  });
  assert.equal(createdOnEnabled.hostId, "remote:server:srv-enabled");
  assert.ok(createdOnEnabled.workspaceIdentity?.startsWith("remote:server:srv-enabled:"));
  await mod.disposeServiceResourcesAndWait(hostServicesEnabled.services);
  hostServicesEnabled = undefined;
  await assert.rejects(agentEnabled.runAutomationNow(autoTarget(createdOnEnabled)), {
    message: "Automation immediate dispatcher is unavailable.",
  });
  console.log("PASS createServerHostServices：启停边界与同路径共存零篡改");

  // ---- 测试 8：冻结目录快照放行（项目 roots 修改/清空后，定时触发与 runAutomationNow 仍按原快照 A+B 创建会话；外部越界仍拒） ----
  const frozenHostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: "srv-frozen", workspacePath: "/" }),
  );
  const frozenRootA = join(workspaceRoot, "frozen-a");
  const frozenRootB = join(workspaceRoot, "frozen-b");
  const frozenRootC = join(workspaceRoot, "frozen-c");
  await Promise.all(
    [frozenRootA, frozenRootB, frozenRootC].map((d) => mkdir(d, { recursive: true })),
  );
  const frozenLogFile = join(temporary, "frozen-worker.ndjson");
  await writeFile(frozenLogFile, "");
  const frozenWorkerPath = join(temporary, "frozen-cli-worker.mjs");
  await writeFile(
    frozenWorkerPath,
    `
import { appendFileSync } from "node:fs";
const logFile = process.argv[2];
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
    if (msg.method === "session/create") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
      const now = Date.now();
      const snapshot = {
        protocol: { name: "ZCode Protocol", version: 1 },
        session: {
          sessionId: msg.params.sessionId,
          workspace: msg.params.workspace,
          sessionKind: "interactive",
          title: "Frozen Cron Session",
          createdAt: now,
          updatedAt: now,
          mode: msg.params.mode ?? "build",
          status: "idle",
        },
        settings: {
          model: {
            current: msg.params.model ?? { providerId: "zai-standard-api", modelId: "GLM-5.3", options: { reasoningLevel: "high" } },
            available: [],
          },
          thoughtLevel: {
            enabled: true,
            current: "high",
            available: [{ value: "high", label: "High" }],
          },
          mode: { current: msg.params.mode ?? "build" },
          permission: { mode: msg.params.mode ?? "build" },
        },
        projection: {
          sessionId: msg.params.sessionId,
          status: "idle",
          mode: msg.params.mode ?? "build",
          turnCount: 0,
          totalTokenCount: 0,
          contextUsed: 0,
          contextWindow: 128000,
          pendingPermissions: [],
          activeToolCalls: [],
          backgroundJobs: [],
        },
        runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
        messages: [],
      };
      process.stdout.write(JSON.stringify({ id: msg.id, result: snapshot }) + "\\n");
      continue;
    }
    if (msg.method === "v4/command") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { status: "accepted", commandId: msg.params.commandId, revisionAtDecision: 1 },
      }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  }
});
`,
  );

  process.env.ZCODE_DEFAULT_WORKSPACE_DIR = workspaceRoot;
  process.env.ZCODE_AGENT_SERVER_COMMAND = process.execPath;
  process.env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([frozenWorkerPath, frozenLogFile]);
  const frozenHost = await mod.createServerHostServices({
    sourceServerId: "srv-frozen",
    zcodeBuiltinProviderConfigFilePath: join(repoRoot, "config/provider/zcode-builtin.test.json"),
    credentialCipherProvider: cipher,
    automationExecutionEnabled: true,
  });
  frozenServices = frozenHost.services;
  const frozenProviderSettings = frozenServices.get(mod.IProviderSettingsService);
  const createdProvider = await frozenProviderSettings.createPersonalProvider({
    templateId: "zai-standard-api",
    providerName: "Frozen Test Provider",
    initialConfig: {
      access: { type: "api-key", apiKey: "sk-test-frozen" },
    },
  });
  const frozenModelSelectionView = await frozenServices.get(mod.IModelSelectionService).getView();
  const frozenModelSelection = frozenModelSelectionView.preferredSelection ?? {
    providerId: createdProvider.providerId,
    modelId: "GLM-5.3",
    options: { reasoningLevel: "high" },
  };

  const frozenProjectSvc = frozenServices.get(mod.IProjectService);
  const frozenAgentSvc = frozenServices.get(mod.IZCodeAgentService);
  const frozenProj = await frozenProjectSvc.saveProject({
    name: "Frozen Automation Proj",
    roots: [frozenRootA, frozenRootB],
    primaryRoot: frozenRootA,
  });
  const frozenManualAuto = await frozenAgentSvc.createAutomation({
    projectId: frozenProj.id,
    title: "Frozen Manual",
    cronExpr: "0 9 * * *",
    prompt: "Run manual on frozen A+B",
    modelSelection: frozenModelSelection,
    workspacePath: frozenRootA,
  });
  assert.equal(frozenManualAuto.workspacePath, frozenRootA);
  assert.deepEqual(frozenManualAuto.additionalDirectories, [frozenRootB]);

  const frozenSchedAuto = await frozenAgentSvc.createAutomation({
    projectId: frozenProj.id,
    title: "Frozen Schedule",
    cronExpr: "*/5 * * * *",
    prompt: "Run schedule on frozen A+B",
    modelSelection: frozenModelSelection,
    workspacePath: frozenRootA,
    recurring: false,
    maxRuns: 1,
  });

  // 修改项目 roots 为 C，甚至再清空为 0 root
  await frozenProjectSvc.saveProject({ id: frozenProj.id, roots: [frozenRootC] });
  await frozenAgentSvc.runAutomationNow(autoTarget(frozenManualAuto));

  await frozenProjectSvc.saveProject({ id: frozenProj.id, roots: [] });
  // 将 frozenSchedAuto 的 next_run_at 拨回过去并唤醒调度器
  const defaultTaskDb = new DatabaseSync(join(mod.getAppConfigDir(), "tasks-index.sqlite"));
  try {
    defaultTaskDb
      .prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?")
      .run(Date.now() - 10_000, frozenSchedAuto.automationId);
  } finally {
    defaultTaskDb.close();
  }
  await frozenAgentSvc.setAutomationEnabled({
    ...autoTarget(frozenSchedAuto),
    enabled: true,
  });

  await waitUntil(async () => {
    const verifyRepo = new AutomationRepo();
    try {
      const mRuns = await verifyRepo.listRuns(frozenManualAuto.automationId);
      const sRuns = await verifyRepo.listRuns(frozenSchedAuto.automationId);
      return (
        mRuns.some((r) => r.dispatchStatus === "dispatched" && r.sessionId) &&
        sRuns.some((r) => r.dispatchStatus === "dispatched" && r.sessionId)
      );
    } finally {
      verifyRepo.close();
    }
  }, "frozen snapshot manual and scheduled runs");

  // 确认两次创建的任务行都以冻结的 A+B 落库，且发送给 CLI 的 additionalDirectories 为 [B]
  const verifyRepo = new AutomationRepo();
  const mRun = (await verifyRepo.listRuns(frozenManualAuto.automationId))[0];
  const sRun = (await verifyRepo.listRuns(frozenSchedAuto.automationId))[0];
  verifyRepo.close();
  const verifyIdx = new mod.TaskIndexRepo(undefined, frozenHostId);
  const verifyProjRepo = await verifyIdx.getProjectRepository({
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspaceRoot,
    allowStandaloneMultiRoot: true,
  });
  for (const sid of [mRun.sessionId, sRun.sessionId]) {
    const dirs = verifyProjRepo.resolveSessionDirectories({
      taskId: sid,
      workspacePath: frozenRootA,
      workspaceIdentity: frozenManualAuto.workspaceIdentity,
    });
    assert.equal(dirs.workspacePath, frozenRootA);
    assert.deepEqual(dirs.additionalDirectories, [frozenRootB]);
  }
  // 普通外部 reserveCreatedTask 传越界目录 A+B 仍必须被拒绝
  assert.throws(
    () =>
      verifyProjRepo.reserveCreatedTask({
        task: {
          taskId: "external-bypass-attempt",
          workspacePath: frozenRootA,
          workspaceIdentity: frozenManualAuto.workspaceIdentity,
        },
        projectId: frozenProj.id,
        additionalDirectories: [frozenRootB],
      }),
    /project\.cwd-not-in-roots/,
  );
  verifyIdx.close();
  await mod.disposeServiceResourcesAndWait(frozenServices);
  frozenServices = undefined;
  console.log(
    "PASS 冻结目录快照放行：项目 roots 变更/清空后 runAutomationNow 与定时触发仍以 A+B 建会话，普通越界仍拒绝",
  );
} finally {
  if (frozenServices && mod)
    await mod.disposeServiceResourcesAndWait(frozenServices).catch(() => {});
  for (const h of [hostServicesDisabled, hostServicesEnabled])
    if (h && mod) await mod.disposeServiceResourcesAndWait(h.services).catch(() => {});
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => setTimeout(r, 60));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
