/* eslint-disable max-lines -- 独立 HTTP 定时任务执行链与冻结目录快照回归集中在单脚本。 */
// 独立 HTTP 定时任务执行链回归：真实 SQLite + AutomationRepo + AutomationService +
// SourceServerWorkspaceAliasRepo + automation-runtime + node.ts createServerHostServices。
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-automation-runtime.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

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
let hostServicesDisabled;
let hostServicesEnabled;
let hostServicesPureRemote;
let frozenServices;
let pluginIdleServices;

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
    if (
      path === "electron" ||
      path === "@napi-rs/keyring" ||
      path.startsWith("@napi-rs/keyring-") ||
      path === "node-pty"
    ) {
      return { path, external: true };
    }
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
        `export { assertStandaloneAutomationOwnership } from ${JSON.stringify(join(services, "automation-runtime/index.ts"))};`,
        `export { createProjectService } from ${JSON.stringify(join(services, "project/index.ts"))};`,
        `export { IZCodeAgentService, IZCodeTaskService, IProjectService, IModelSelectionService, IProviderSettingsService, ICredentialService } from ${JSON.stringify(join(services, "index.ts"))};`,
        `export { projectStorage } from ${JSON.stringify(join(services, "project-storage/index.ts"))};`,
        `export { TaskIndexRepo } from ${JSON.stringify(join(services, "session/taskIndexRepo.ts"))};`,
        `export { runTasksDatabaseMigrations } from ${JSON.stringify(join(services, "session/tasksDatabase/migrations.ts"))};`,
        `export { createServerCredentialCipher } from ${JSON.stringify(join(shared, "credential-security/module.ts"))};`,
        `export { buildServerRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from ${JSON.stringify(join(shared, "index.ts"))};`,
        `export { ensureTaskNavigationWorkspace } from ${JSON.stringify(join(repoRoot, "packages/ui/src/app-shell/taskNavigationWorkspace.ts"))};`,
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["@napi-rs/keyring", "@napi-rs/keyring-*", "node-pty", "electron"],
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
  const resumeCalls = [];
  const unreadCalls = [];
  const terminalListeners = new Map();
  let promptGate = null;
  let seq = 0;

  const taskService = {
    createTask: async (params) => ({ taskId: `task-created-${++seq}`, ...params }),
    resumeTask: async (params) => {
      resumeCalls.push(params);
    },
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

  // ---- 测试 2b：standalone localWorkspaceAliasEnabled=true 启动对齐（含存量 remote:server:<self>:<path> 迁回 path-only 与同路径异域 SSH 零篡改）与派发防线 ----
  const localAliasDir = join(workspaceRoot, "local-alias-dir");
  const localAliasSshDir = join(workspaceRoot, "local-alias-ssh-dir");
  await Promise.all([
    mkdir(localAliasDir, { recursive: true }),
    mkdir(localAliasSshDir, { recursive: true }),
  ]);
  const localAliasDbPath = join(temporary, "runtime-local-alias.sqlite");
  const localAliasDb = new DatabaseSync(localAliasDbPath);
  localAliasDb.exec("PRAGMA foreign_keys=ON");
  await mod.runTasksDatabaseMigrations(localAliasDb, { dbPath: localAliasDbPath });
  const localAliasRepo = new AutomationRepo(localAliasDbPath);
  await localAliasRepo.ensureReady();
  const seedAliasCase = async (title, dir, identity, hostId) => {
    const created = await localAliasRepo.create(
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
      { nextRunAt: Date.now() - 30_000 },
    );
    await localAliasRepo.ensureRunClaimed({
      runId: `${created.automationId}:seed-run`,
      automationId: created.automationId,
      workspaceKey: identity && identity !== dir ? identity : dir,
      scheduledAt: Date.now() - 90_000,
      trigger: "schedule",
    });
    return created;
  };
  const aliasLegacy = await seedAliasCase("Alias Legacy", localAliasDir);
  const aliasExplicit = await seedAliasCase(
    "Alias Explicit",
    localAliasDir,
    localAliasDir,
    "local",
  );
  const aliasPrevCanonical = await seedAliasCase(
    "Alias Prev Canonical",
    localAliasDir,
    serverIdentity(localAliasDir),
    ownerHostId,
  );
  // P1-1: 在 tasks 表播种 canonical 会话（覆盖 target_task_id 绑定与历史 automation_runs.session_id 两种情况）
  // 以及一条 path-only tasks 会话（workspace_identity = NULL），验证只保留关联 canonical 会话的定义。
  const seedTaskRow = (targetDb, params) => {
    const now = Date.now();
    targetDb
      .prepare(
        `INSERT INTO tasks (
          workspace_key, workspace_path, workspace_identity, task_id,
          title, mode, created_at, updated_at, meta_json
        ) VALUES (?, ?, ?, ?, ?, 'build', ?, ?, '{}')`,
      )
      .run(
        params.workspaceIdentity ?? params.workspacePath,
        params.workspacePath,
        params.workspaceIdentity ?? null,
        params.taskId,
        params.taskId,
        now,
        now,
      );
  };
  const localAliasCanonId = serverIdentity(localAliasDir);
  const canonTargetTaskId = "sess-canon-target-1";
  const canonHistoryTaskId = "sess-canon-history-1";
  const pathOnlyTargetTaskId = "sess-path-only-target-1";
  seedTaskRow(localAliasDb, {
    workspacePath: localAliasDir,
    workspaceIdentity: localAliasCanonId,
    taskId: canonTargetTaskId,
  });
  seedTaskRow(localAliasDb, {
    workspacePath: localAliasDir,
    workspaceIdentity: localAliasCanonId,
    taskId: canonHistoryTaskId,
  });
  seedTaskRow(localAliasDb, {
    workspacePath: localAliasDir,
    workspaceIdentity: null,
    taskId: pathOnlyTargetTaskId,
  });
  const aliasCanonTarget = await localAliasRepo.create(
    {
      title: "Alias Canon Target",
      prompt: "Canon target prompt",
      cronExpr: "*/5 * * * *",
      recurring: false,
      maxRuns: 1,
      workspacePath: localAliasDir,
      workspaceIdentity: localAliasCanonId,
      hostId: ownerHostId,
      targetTaskId: canonTargetTaskId,
    },
    { nextRunAt: Date.now() - 30_000 },
  );
  await localAliasRepo.ensureRunClaimed({
    runId: `${aliasCanonTarget.automationId}:seed-run`,
    automationId: aliasCanonTarget.automationId,
    workspaceKey: localAliasCanonId,
    scheduledAt: Date.now() - 90_000,
    trigger: "schedule",
  });
  const aliasCanonHistory = await localAliasRepo.create(
    {
      title: "Alias Canon History",
      prompt: "Canon history prompt",
      cronExpr: "*/5 * * * *",
      recurring: true,
      workspacePath: localAliasDir,
      workspaceIdentity: localAliasCanonId,
      hostId: ownerHostId,
    },
    { nextRunAt: Date.now() - 30_000 },
  );
  await localAliasRepo.ensureRunClaimed({
    runId: `${aliasCanonHistory.automationId}:history-run`,
    automationId: aliasCanonHistory.automationId,
    workspaceKey: localAliasCanonId,
    scheduledAt: Date.now() - 90_000,
    trigger: "schedule",
  });
  await localAliasRepo.markRunDispatch({
    runId: `${aliasCanonHistory.automationId}:history-run`,
    dispatchStatus: "dispatched",
    sessionId: canonHistoryTaskId,
  });
  const aliasPathOnlyTarget = await localAliasRepo.create(
    {
      title: "Alias PathOnly Target",
      prompt: "PathOnly target prompt",
      cronExpr: "*/5 * * * *",
      recurring: false,
      maxRuns: 1,
      workspacePath: localAliasDir,
      workspaceIdentity: localAliasCanonId,
      hostId: ownerHostId,
      targetTaskId: pathOnlyTargetTaskId,
    },
    { nextRunAt: Date.now() - 30_000 },
  );
  const aliasForeignSshId = sshId(localAliasDir);
  const aliasForeignSsh = await seedAliasCase(
    "Alias Foreign SSH",
    localAliasDir,
    aliasForeignSshId,
    "remote:ssh:ssh-host:22:alice",
  );
  const aliasForeignOtherId = srvOtherId(localAliasSshDir);
  const aliasForeignOther = await seedAliasCase(
    "Alias Foreign Other",
    localAliasSshDir,
    aliasForeignOtherId,
    "remote:server:other-server",
  );
  const localAliasRuntime = createAutomationRuntime({
    repo: localAliasRepo,
    cron: {
      computeNextRunAt: mod.computeAutomationNextRunAt,
      isOneShotAutomation: mod.isOneShotAutomation,
    },
    resolveTargetServices: () => ({ taskService, modelSelectionService }),
    logger: {
      info: () => {},
      warn: () => {},
      error: (msg, err) => console.error("[test-local-alias-runtime]", msg, err),
    },
    pollIntervalMs: 60_000,
    standaloneAuthority: {
      projectStorageHostId: ownerHostId,
      localWorkspaceAliasEnabled: true,
      resolveWorkspace: async (workspacePath) => ({
        canonicalWorkspaceKey: serverIdentity(workspacePath),
      }),
    },
  });
  await localAliasRuntime.start();
  await waitUntil(async () => {
    const ok = await Promise.all(
      [
        aliasLegacy,
        aliasExplicit,
        aliasPrevCanonical,
        aliasCanonTarget,
        aliasCanonHistory,
        aliasPathOnlyTarget,
      ].map((a) => localAliasRepo.get(a.automationId)),
    );
    const bad = await Promise.all(
      [aliasForeignSsh, aliasForeignOther].map((a) => localAliasRepo.get(a.automationId)),
    );
    return ok.every((r) => r?.runCount === 1) && bad.every((r) => r?.lifecycleStatus === "failed");
  }, "localWorkspaceAliasEnabled startup alignment + dispatch");
  for (const a of [aliasLegacy, aliasExplicit, aliasPrevCanonical, aliasPathOnlyTarget]) {
    const row = await localAliasRepo.get(a.automationId);
    assert.equal(row?.workspaceKey, localAliasDir);
    assert.equal(row?.workspaceIdentity, undefined);
    assert.equal(row?.hostId, ownerHostId);
    assert.equal(row?.runCount, 1);
    assert.ok(
      (await localAliasRepo.listRuns(a.automationId)).every(
        (r) => r.workspaceKey === localAliasDir,
      ),
    );
  }
  for (const a of [aliasCanonTarget, aliasCanonHistory]) {
    const row = await localAliasRepo.get(a.automationId);
    assert.equal(
      row?.workspaceKey,
      localAliasCanonId,
      `关联 canonical 会话的任务 ${a.title} 必须保留 canonical workspaceKey`,
    );
    assert.equal(
      row?.workspaceIdentity,
      localAliasCanonId,
      `关联 canonical 会话的任务 ${a.title} 必须保留 canonical workspaceIdentity`,
    );
    assert.equal(row?.hostId, ownerHostId);
    assert.equal(row?.runCount, 1);
    assert.ok(
      (await localAliasRepo.listRuns(a.automationId)).every(
        (r) => r.workspaceKey === localAliasCanonId,
      ),
      `关联 canonical 会话的任务 ${a.title} 的 runs 必须保留 canonical workspaceKey`,
    );
  }
  const canonResume = resumeCalls.find(
    (c) => c.automationId === aliasCanonTarget.automationId && c.taskId === canonTargetTaskId,
  );
  assert.equal(
    canonResume?.workspaceIdentity,
    localAliasCanonId,
    "绑定 canonical 会话的任务续跑必须携带原 canonical workspaceIdentity",
  );
  const pathOnlyResume = resumeCalls.find(
    (c) => c.automationId === aliasPathOnlyTarget.automationId && c.taskId === pathOnlyTargetTaskId,
  );
  assert.equal(
    pathOnlyResume?.workspaceIdentity,
    undefined,
    "绑定 path-only 会话的任务续跑必须保持 path-only",
  );
  assert.equal(
    (await localAliasRepo.get(aliasForeignSsh.automationId))?.workspaceIdentity,
    aliasForeignSshId,
  );
  assert.equal(
    (await localAliasRepo.get(aliasForeignSsh.automationId))?.workspaceKey,
    aliasForeignSshId,
  );
  assert.equal(
    (await localAliasRepo.getRun(`${aliasForeignSsh.automationId}:seed-run`))?.workspaceKey,
    aliasForeignSshId,
  );
  assert.equal(
    (await localAliasRepo.get(aliasForeignOther.automationId))?.workspaceIdentity,
    aliasForeignOtherId,
  );
  // 回归：对因历史 canonical session_id 保留本机 canonical 身份的循环任务，删光全部历史运行记录后，
  // 后续 runNow 与下一轮到期 tick 必须继续正常派发成功，不能被永久置为 failed。
  for (const runRow of await localAliasRepo.listRuns(aliasCanonHistory.automationId)) {
    await localAliasRepo.deleteRun(runRow.runId, runRow.workspaceKey);
  }
  assert.equal((await localAliasRepo.listRuns(aliasCanonHistory.automationId)).length, 0);
  assert.equal(
    await localAliasRepo.hasCanonicalReferencedSession(aliasCanonHistory.automationId),
    false,
  );
  const canonHistoryManual = await localAliasRepo.runNow(aliasCanonHistory.automationId, {
    now: Date.now(),
  });
  assert.ok(canonHistoryManual);
  await localAliasRuntime.dispatchManualRun(canonHistoryManual);
  const afterDeletedHistManual = await localAliasRepo.get(aliasCanonHistory.automationId);
  assert.equal(afterDeletedHistManual?.runCount, 2);
  assert.equal(afterDeletedHistManual?.lifecycleStatus, "active");
  const manualHistRun = await localAliasRepo.getRun(canonHistoryManual.run.runId);
  assert.equal(manualHistRun?.dispatchStatus, "dispatched");
  emitTerminal({
    taskId: manualHistRun.sessionId,
    inputId: canonHistoryManual.run.runId,
    outcome: "succeeded",
  });
  await waitUntil(
    async () =>
      localAliasDb
        .prepare("SELECT running FROM automations WHERE automation_id = ?")
        .get(aliasCanonHistory.automationId)?.running === 0 &&
      (await localAliasRepo.getRun(canonHistoryManual.run.runId))?.outcome === "succeeded",
    "manual dispatch settled after deleting historical runs",
  );
  for (const runRow of await localAliasRepo.listRuns(aliasCanonHistory.automationId)) {
    await localAliasRepo.deleteRun(runRow.runId, runRow.workspaceKey);
  }
  assert.equal((await localAliasRepo.listRuns(aliasCanonHistory.automationId)).length, 0);
  assert.equal(
    await localAliasRepo.hasCanonicalReferencedSession(aliasCanonHistory.automationId),
    false,
  );
  localAliasDb
    .prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?")
    .run(Date.now() - 10_000, aliasCanonHistory.automationId);
  localAliasRuntime.wake();
  await waitUntil(
    async () => (await localAliasRepo.get(aliasCanonHistory.automationId))?.runCount === 3,
    "scheduled tick dispatches after deleting all historical runs",
  );
  const afterDeletedHistTick = await localAliasRepo.get(aliasCanonHistory.automationId);
  assert.equal(afterDeletedHistTick?.lifecycleStatus, "active");
  assert.equal(afterDeletedHistTick?.workspaceKey, localAliasCanonId);
  assert.equal(afterDeletedHistTick?.workspaceIdentity, localAliasCanonId);

  // 校验 assertStandaloneAutomationOwnership（localWorkspaceAliasEnabled: true）：
  // 合法本服务器 canonical 身份放行；裸路径残留、异域 server/ssh 或 "local" hostId 永久拒绝。
  await mod.assertStandaloneAutomationOwnership({
    request: {
      automationId: "owned-canonical-check",
      hostId: ownerHostId,
      workspacePath: localAliasDir,
      workspaceIdentity: serverIdentity(localAliasDir),
    },
    projectStorageHostId: ownerHostId,
    localWorkspaceAliasEnabled: true,
    resolveWorkspace: async (wp) => ({ canonicalWorkspaceKey: serverIdentity(wp) }),
  });
  for (const badReq of [
    {
      automationId: "bare-path-identity-check",
      hostId: ownerHostId,
      workspacePath: localAliasDir,
      workspaceIdentity: localAliasDir,
    },
    {
      automationId: "foreign-ssh-identity-check",
      hostId: ownerHostId,
      workspacePath: localAliasDir,
      workspaceIdentity: aliasForeignSshId,
    },
    {
      automationId: "foreign-server-identity-check",
      hostId: ownerHostId,
      workspacePath: localAliasDir,
      workspaceIdentity: srvOtherId(localAliasDir),
    },
    {
      automationId: "local-host-check",
      hostId: "local",
      workspacePath: localAliasDir,
    },
  ]) {
    await assert.rejects(
      mod.assertStandaloneAutomationOwnership({
        request: badReq,
        projectStorageHostId: ownerHostId,
        localWorkspaceAliasEnabled: true,
        resolveWorkspace: async (wp) => ({ canonicalWorkspaceKey: serverIdentity(wp) }),
      }),
      mod.AutomationPermanentDispatchError,
    );
  }
  await localAliasRuntime.dispose();
  localAliasRepo.close();
  localAliasDb.close();
  console.log(
    "PASS standalone localWorkspaceAliasEnabled=true：无会话迁回 path-only、保留既有 canonical 会话且删光历史 run 后仍可继续派发、异域零篡改",
  );

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

  // 在 node.ts 真实装配前于默认库播种同路径共存的本地历史定义、先前 canonical 同服务器定义与异域 SSH 定义，验证真实启动对齐零篡改
  const srvCoexistRepo = new AutomationRepo();
  await srvCoexistRepo.ensureReady();
  const srvCoexistSshId = `remote:ssh:ssh-host:22:alice:${explicitLocalDir}`;
  const srvEnabledIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: "srv-enabled",
    workspacePath: explicitLocalDir,
  });
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
  const srvPrevCanonical = await seedSrv(
    "Srv Coexist Prev Canonical",
    srvEnabledIdentity,
    "remote:server:srv-enabled",
  );
  await srvCoexistRepo.ensureRunClaimed({
    runId: `${srvPrevCanonical.automationId}:seed`,
    automationId: srvPrevCanonical.automationId,
    workspaceKey: srvEnabledIdentity,
    scheduledAt: Date.now(),
    trigger: "schedule",
  });
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
  const srvVerifyRepo = new AutomationRepo();
  const alignedSrvLocal = await srvVerifyRepo.get(srvLocalHist.automationId);
  const alignedSrvPrevCanonical = await srvVerifyRepo.get(srvPrevCanonical.automationId);
  const untouchedSrvSsh = await srvVerifyRepo.get(srvForeignSsh.automationId);
  assert.equal(alignedSrvLocal?.workspaceIdentity, undefined);
  assert.equal(alignedSrvLocal?.workspaceKey, explicitLocalDir);
  assert.equal(alignedSrvLocal?.hostId, "remote:server:srv-enabled");
  assert.equal(alignedSrvPrevCanonical?.workspaceIdentity, undefined);
  assert.equal(alignedSrvPrevCanonical?.workspaceKey, explicitLocalDir);
  assert.equal(alignedSrvPrevCanonical?.hostId, "remote:server:srv-enabled");
  assert.equal(
    (await srvVerifyRepo.getRun(`${srvPrevCanonical.automationId}:seed`))?.workspaceKey,
    explicitLocalDir,
  );
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
  assert.equal(createdOnEnabled.workspaceIdentity, undefined);
  assert.equal(createdOnEnabled.workspaceKey, projectDir);

  const nonProjDir = join(workspaceRoot, "non-proj-local-alias");
  await mkdir(nonProjDir, { recursive: true });
  const nonProjServerIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: "srv-enabled",
    workspacePath: nonProjDir,
  });
  // P1-2: 当路径已在 workspace_alias 登记本服务器 canonical_key，且同路径并存异域 remote:ssh:* 定义与 run 时，
  // 异域 createAutomation 请求在拒绝前绝不能触发 resolveWorkspace 合并或改写异域记录。
  const p12AliasRepo = new mod.SourceServerWorkspaceAliasRepo({
    backupRoot: join(temporary, "p12-alias-backups"),
  });
  await p12AliasRepo.resolveCanonicalWorkspaceKey({
    workspacePath: nonProjDir,
    legacyRouteHint: nonProjServerIdentity,
  });
  const p12ForeignSshId = `remote:ssh:ssh-host:22:alice:${nonProjDir}`;
  const p12SeedRepo = new AutomationRepo();
  await p12SeedRepo.ensureReady();
  const p12ForeignSshAuto = await p12SeedRepo.create(
    {
      title: "P1-2 Coexist Foreign SSH",
      cronExpr: "0 9 * * *",
      prompt: "Keep foreign untouched",
      workspacePath: nonProjDir,
      workspaceIdentity: p12ForeignSshId,
      hostId: "remote:ssh:ssh-host:22:alice",
      recurring: true,
    },
    { nextRunAt: Date.now() + 3_600_000 },
  );
  await p12SeedRepo.ensureRunClaimed({
    runId: `${p12ForeignSshAuto.automationId}:p12-seed`,
    automationId: p12ForeignSshAuto.automationId,
    workspaceKey: p12ForeignSshId,
    scheduledAt: Date.now(),
    trigger: "schedule",
  });
  const p12BeforeAuto = await p12SeedRepo.get(p12ForeignSshAuto.automationId);
  const p12BeforeRun = await p12SeedRepo.getRun(`${p12ForeignSshAuto.automationId}:p12-seed`);
  p12SeedRepo.close();

  const createdNonProjWithSelfId = await agentEnabled.createAutomation({
    title: "NonProj SelfId Normalized",
    cronExpr: "0 9 * * *",
    prompt: "Check non-proj",
    workspacePath: nonProjDir,
    workspaceIdentity: nonProjServerIdentity,
  });
  assert.equal(createdNonProjWithSelfId.hostId, "remote:server:srv-enabled");
  assert.equal(createdNonProjWithSelfId.workspaceIdentity, undefined);
  assert.equal(createdNonProjWithSelfId.workspaceKey, nonProjDir);
  for (const rejectedIdentity of [
    `remote:server:other-host:${nonProjDir}`,
    `remote:ssh:other-box:22:bob:${nonProjDir}`,
    "/other/non-remote/path",
  ]) {
    await assert.rejects(
      agentEnabled.createAutomation({
        title: "NonProj Foreign Rejected",
        cronExpr: "0 9 * * *",
        prompt: "Bad",
        workspacePath: nonProjDir,
        workspaceIdentity: rejectedIdentity,
      }),
      /does not belong to this server/,
    );
  }
  const p12VerifyRepo = new AutomationRepo();
  assert.deepEqual(
    await p12VerifyRepo.get(p12ForeignSshAuto.automationId),
    p12BeforeAuto,
    "P1-2: 拒绝异域请求后，同路径异域 remote:ssh:* automations 行必须 100% 未被改写",
  );
  assert.deepEqual(
    await p12VerifyRepo.getRun(`${p12ForeignSshAuto.automationId}:p12-seed`),
    p12BeforeRun,
    "P1-2: 拒绝异域请求后，同路径异域 remote:ssh:* automation_runs 行必须 100% 未被改写",
  );
  p12VerifyRepo.close();
  await mod.disposeServiceResourcesAndWait(hostServicesEnabled.services);
  hostServicesEnabled = undefined;
  await assert.rejects(agentEnabled.runAutomationNow(autoTarget(createdOnEnabled)), {
    message: "Automation immediate dispatcher is unavailable.",
  });

  // ---- 测试 7b：纯远端模式（未开启 ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS）保持 canonicalWorkspaceKey 固化与对齐 ----
  delete process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS;
  const pureRemoteDir = join(workspaceRoot, "pure-remote-proj");
  await mkdir(pureRemoteDir, { recursive: true });
  const pureRemoteSeedRepo = new AutomationRepo();
  await pureRemoteSeedRepo.ensureReady();
  const pureRemoteHist = await pureRemoteSeedRepo.create(
    {
      title: "Pure Remote Local Hist",
      cronExpr: "0 9 * * *",
      prompt: "Hist",
      workspacePath: pureRemoteDir,
      workspaceIdentity: pureRemoteDir,
      hostId: "local",
      recurring: true,
    },
    { nextRunAt: Date.now() + 3_600_000 },
  );
  pureRemoteSeedRepo.close();

  hostServicesPureRemote = await createHost("srv-pure-remote", true);
  const pureRemoteExpectedIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: "srv-pure-remote",
    workspacePath: pureRemoteDir,
  });
  const pureRemoteVerifyRepo = new AutomationRepo();
  const alignedPureRemote = await pureRemoteVerifyRepo.get(pureRemoteHist.automationId);
  assert.equal(alignedPureRemote?.workspaceIdentity, pureRemoteExpectedIdentity);
  assert.equal(alignedPureRemote?.workspaceKey, pureRemoteExpectedIdentity);
  assert.equal(alignedPureRemote?.hostId, "remote:server:srv-pure-remote");
  pureRemoteVerifyRepo.close();

  const projPureRemote = await hostServicesPureRemote.services
    .get(mod.IProjectService)
    .saveProject({ name: "Pure Remote Proj", roots: [pureRemoteDir] });
  const agentPureRemote = hostServicesPureRemote.services.get(mod.IZCodeAgentService);
  const createdOnPureRemote = await agentPureRemote.createAutomation({
    projectId: projPureRemote.id,
    title: "Pure Remote Cron",
    cronExpr: "0 9 * * *",
    prompt: "Check pure remote",
    workspacePath: pureRemoteDir,
  });
  assert.equal(createdOnPureRemote.hostId, "remote:server:srv-pure-remote");
  assert.equal(createdOnPureRemote.workspaceIdentity, pureRemoteExpectedIdentity);
  assert.equal(createdOnPureRemote.workspaceKey, pureRemoteExpectedIdentity);

  // P1-2 (纯远端模式): workspace_alias 已存在且同路径并存异域 remote:ssh:* 记录时，
  // 拒绝异域 createAutomation 请求绝不能触发 resolveWorkspace 合并或改写异域记录。
  const pureRemoteForeignSshId = `remote:ssh:ssh-host:22:alice:${pureRemoteDir}`;
  const pureRemoteCoexistRepo = new AutomationRepo();
  await pureRemoteCoexistRepo.ensureReady();
  const pureRemoteForeignAuto = await pureRemoteCoexistRepo.create(
    {
      title: "Pure Remote Foreign SSH",
      cronExpr: "0 9 * * *",
      prompt: "Keep pure remote foreign untouched",
      workspacePath: pureRemoteDir,
      workspaceIdentity: pureRemoteForeignSshId,
      hostId: "remote:ssh:ssh-host:22:alice",
      recurring: true,
    },
    { nextRunAt: Date.now() + 3_600_000 },
  );
  await pureRemoteCoexistRepo.ensureRunClaimed({
    runId: `${pureRemoteForeignAuto.automationId}:seed`,
    automationId: pureRemoteForeignAuto.automationId,
    workspaceKey: pureRemoteForeignSshId,
    scheduledAt: Date.now(),
    trigger: "schedule",
  });
  const pureRemoteForeignBeforeAuto = await pureRemoteCoexistRepo.get(
    pureRemoteForeignAuto.automationId,
  );
  const pureRemoteForeignBeforeRun = await pureRemoteCoexistRepo.getRun(
    `${pureRemoteForeignAuto.automationId}:seed`,
  );
  pureRemoteCoexistRepo.close();
  await assert.rejects(
    agentPureRemote.createAutomation({
      title: "Pure Remote Foreign Rejected",
      cronExpr: "0 9 * * *",
      prompt: "Bad pure remote",
      workspacePath: pureRemoteDir,
      workspaceIdentity: `remote:server:other:${pureRemoteDir}`,
    }),
    /does not belong to this server/,
  );
  const pureRemoteCoexistVerify = new AutomationRepo();
  assert.deepEqual(
    await pureRemoteCoexistVerify.get(pureRemoteForeignAuto.automationId),
    pureRemoteForeignBeforeAuto,
  );
  assert.deepEqual(
    await pureRemoteCoexistVerify.getRun(`${pureRemoteForeignAuto.automationId}:seed`),
    pureRemoteForeignBeforeRun,
  );
  pureRemoteCoexistVerify.close();
  await mod.disposeServiceResourcesAndWait(hostServicesPureRemote.services);
  hostServicesPureRemote = undefined;
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";
  console.log(
    "PASS createServerHostServices：本地工作台 path-only 归属、纯远端 canonical 归属、启停边界与同路径共存零篡改",
  );

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
    if (!msg.method) {
      if (typeof msg.id === "string" && msg.id.startsWith("cli-cron-create-")) {
        appendFileSync(logFile, JSON.stringify({ method: "automation/create:reply", sessionId: msg.id.slice("cli-cron-create-".length), pid: process.pid, result: msg.result, error: msg.error }) + "\\n");
      }
      continue;
    }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { protocolName: "ZCode Protocol", protocolVersion: 1 } }) + "\\n");
      continue;
    }
    if (msg.method === "runtime/capabilities") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessionWorkspaceRouting: true } }) + "\\n");
      continue;
    }
    if (msg.method === "plugins/list") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, pid: process.pid, cwd: process.cwd(), params: msg.params }) + "\\n");
      process.stdout.write(JSON.stringify({ id: msg.id, result: { plugins: [], diagnostics: [] } }) + "\\n");
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
      globalThis.__subSeq = (globalThis.__subSeq ?? 0) + 1;
      const subId = "sub-" + globalThis.__subSeq;
      const topic = msg.params?.topic ?? "";
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { ack: { subscriptionId: subId, mode: "snapshot", logEpoch: "epoch-1" } },
      }) + "\\n");
      if (topic.startsWith("sessions-index/")) {
        const workspaceId = topic.slice("sessions-index/".length);
        globalThis.__sessionsIndexSubs ??= new Map();
        globalThis.__sessionsIndexSubs.set(workspaceId, { topic, subscriptionId: subId, seq: 1 });
        const sessions = [];
        for (const s of (globalThis.__sessionsById ?? new Map()).values()) {
          if (s.workspaceId === workspaceId) sessions.push(s);
        }
        process.stdout.write(JSON.stringify({
          method: "v4/conversation/frame",
          params: {
            wireVersion: 3,
            kind: "complete",
            deliveryKind: "initial",
            logicalFrameId: "lf-" + subId + "-1",
            logicalFrameOrdinal: 1,
            topic,
            subscriptionId: subId,
            frame: {
              topic,
              subscriptionId: subId,
              fromSeq: 0,
              toSeq: 1,
              sentAt: Date.now(),
              payload: {
                kind: "snapshot",
                snapshot: {
                  protocolVersion: 1,
                  workspaceId,
                  logEpoch: "epoch-1",
                  sessions,
                },
              },
            },
          },
        }) + "\\n");
      }
      continue;
    }
    if (msg.method === "v4/sessionsIndex/reconcile") {
      const requested = Array.isArray(msg.params?.sessionIds) ? msg.params.sessionIds : [];
      const sessions = requested.map((sessionId) => {
        const s = globalThis.__sessionsById?.get(sessionId);
        return s
          ? {
              sessionId,
              exists: true,
              deleted: false,
              title: s.title,
              titleSource: "default",
              createdAt: s.createdAt,
              updatedAt: s.lastActivityAt,
            }
          : { sessionId, exists: false, deleted: false };
      });
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessions } }) + "\\n");
      continue;
    }
    if (msg.method === "session/list") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessions: [] } }) + "\\n");
      continue;
    }
    if (msg.method === "session/create" || msg.method === "session/resume") {
      if (msg.method === "session/create") {
        globalThis.__createdWorkspaceBySessionId ??= new Map();
        globalThis.__createdWorkspaceBySessionId.set(msg.params.sessionId, msg.params.workspace ?? null);
        const nowTs = Date.now();
        const wsId = msg.params.workspace?.workspaceKey ?? msg.params.workspace?.workspacePath ?? process.cwd();
        globalThis.__sessionsById ??= new Map();
        globalThis.__sessionsById.set(msg.params.sessionId, {
          sessionId: msg.params.sessionId,
          workspaceId: wsId,
          title: "Frozen Cron Session",
          titleSource: "default",
          phase: "completedSuccess",
          sessionEnded: false,
          hasBackgroundWork: false,
          lastActivityAt: nowTs,
          createdAt: nowTs,
        });
      } else {
        const expectedIdentity =
          globalThis.__createdWorkspaceBySessionId?.get(msg.params.sessionId)?.workspaceIdentity ?? null;
        const actualIdentity = msg.params.workspace?.workspaceIdentity ?? null;
        if (
          globalThis.__createdWorkspaceBySessionId?.has(msg.params.sessionId) &&
          expectedIdentity !== actualIdentity
        ) {
          process.stdout.write(JSON.stringify({
            id: msg.id,
            error: { code: -32603, message: "project.session-lineage-invalid" },
          }) + "\\n");
          continue;
        }
      }
      appendFileSync(logFile, JSON.stringify({ method: msg.method, pid: process.pid, cwd: process.cwd(), params: msg.params }) + "\\n");
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
    if (msg.method === "session/send") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, pid: process.pid, params: msg.params }) + "\\n");
      if (msg.params?.content === "__CRON_CREATE__") {
        const cronReqId = "cli-cron-create-" + msg.params.sessionId;
        const savedWs = globalThis.__createdWorkspaceBySessionId?.get(msg.params.sessionId);
        const wp = savedWs?.workspacePath ?? msg.params.workspace?.workspacePath ?? process.cwd();
        const wi = savedWs?.workspaceIdentity ?? msg.params.workspace?.workspaceIdentity;
        process.stdout.write(JSON.stringify({
          id: cronReqId,
          method: "automation/create",
          params: {
            workspace: {
              workspacePath: wp,
              workspaceKey: savedWs?.workspaceKey ?? wi ?? wp,
              ...(wi ? { workspaceIdentity: wi } : {}),
            },
            title: "CLI CronCreate " + (wi ? "Canonical" : "PathOnly"),
            cronExpr: "0 9 * * *",
            prompt: "Run from CLI CronCreate",
            targetTaskId: msg.params.sessionId,
            recurring: true,
          },
        }) + "\\n");
      }
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { sessionId: msg.params.sessionId, accepted: true, stateRevision: 1 },
      }) + "\\n");
      const sessSummary = globalThis.__sessionsById?.get(msg.params.sessionId);
      const sub = sessSummary ? globalThis.__sessionsIndexSubs?.get(sessSummary.workspaceId) : null;
      if (sessSummary && sub) {
        sessSummary.lastActivityAt = Date.now();
        const nextSeq = ++sub.seq;
        process.stdout.write(JSON.stringify({
          method: "v4/conversation/frame",
          params: {
            wireVersion: 3,
            kind: "complete",
            deliveryKind: "online",
            logicalFrameId: "lf-" + sub.subscriptionId + "-" + nextSeq,
            logicalFrameOrdinal: nextSeq,
            topic: sub.topic,
            subscriptionId: sub.subscriptionId,
            frame: {
              topic: sub.topic,
              subscriptionId: sub.subscriptionId,
              fromSeq: nextSeq - 1,
              toSeq: nextSeq,
              sentAt: Date.now(),
              payload: {
                kind: "deltas",
                deltas: [{ op: "session.upserted", session: sessSummary }],
              },
            },
          },
        }) + "\\n");
      }
      continue;
    }
    if (msg.method === "v4/command") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, pid: process.pid, params: msg.params }) + "\\n");
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
  assert.equal(frozenManualAuto.workspaceIdentity, undefined);
  assert.equal(frozenManualAuto.workspaceKey, frozenRootA);
  assert.equal(frozenManualAuto.hostId, frozenHostId);
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
  assert.equal(frozenSchedAuto.workspaceIdentity, undefined);
  assert.equal(frozenSchedAuto.workspaceKey, frozenRootA);

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
  const verifyTaskDb = new DatabaseSync(join(mod.getAppConfigDir(), "tasks-index.sqlite"));
  try {
    for (const sid of [mRun.sessionId, sRun.sessionId]) {
      const taskRow = verifyTaskDb
        .prepare("SELECT workspace_key, workspace_identity, host_id FROM tasks WHERE task_id = ?")
        .get(sid);
      assert.equal(taskRow?.workspace_key, frozenRootA);
      assert.equal(taskRow?.workspace_identity, null);
      assert.equal(taskRow?.host_id, frozenHostId);
    }
  } finally {
    verifyTaskDb.close();
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

  // 独立 Web 三路导航真实契约断言：结合 http.ts createStandaloneProjectAlias 与 ui ensureTaskNavigationWorkspace
  // 验证项目 roots 已清空为 [] 后，侧栏任务项、运行历史“前往会话”与立即运行 Toast“查看”均可正常打开本地标签页。
  const httpSource = await readFile(join(repoRoot, "packages/server/src/http.ts"), "utf8");
  const httpAst = ts.createSourceFile("http.ts", httpSource, ts.ScriptTarget.Latest, true);
  const httpAliasNodes = httpAst.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      (node.name?.text === "projectHost" || node.name?.text === "createStandaloneProjectAlias"),
  );
  assert.equal(httpAliasNodes.length, 2, "必须抽取真实 http.ts createStandaloneProjectAlias");
  const { outputText: httpAliasJs } = ts.transpileModule(
    httpAliasNodes.map((node) => node.getText(httpAst)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  );
  const createStandaloneProjectAlias = vm.runInNewContext(
    `${httpAliasJs}\ncreateStandaloneProjectAlias`,
  );
  const aliasedFrozenProjSvc = createStandaloneProjectAlias(frozenProjectSvc, frozenHostId);
  await waitUntil(async () => {
    const t = await aliasedFrozenProjSvc.readTree({ hostId: "local" });
    return (
      t.tasks.some((item) => item.taskId === mRun.sessionId) &&
      t.tasks.some((item) => item.taskId === sRun.sessionId)
    );
  }, "readTree syncs frozen automation tasks");
  const aliasedTree = await aliasedFrozenProjSvc.readTree({ hostId: "local" });
  for (const sid of [mRun.sessionId, sRun.sessionId]) {
    const treeTask = aliasedTree.tasks.find((t) => t.taskId === sid);
    assert.ok(treeTask, `readTree 必须返回冻结目录任务 ${sid}`);
    assert.equal(treeTask.workspacePath, frozenRootA);
    assert.equal(treeTask.workspaceIdentity, undefined);
    assert.equal(treeTask.hostId, "local");
  }
  const assertNavAccepted = (target, label) => {
    const addedTabs = [];
    const navOpen = mod.ensureTaskNavigationWorkspace({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      activateTabByPath: (wp, opts) => wp === frozenRootA && !opts?.workspaceIdentity,
      addLocalWorkspaceTab: (wp) => addedTabs.push(wp),
    });
    assert.deepEqual(navOpen, { accepted: true, openedLocalTab: false }, `${label}（已打开）`);
    assert.equal(addedTabs.length, 0);

    const navClosed = mod.ensureTaskNavigationWorkspace({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      activateTabByPath: () => false,
      addLocalWorkspaceTab: (wp) => addedTabs.push(wp),
    });
    assert.deepEqual(
      navClosed,
      { accepted: true, openedLocalTab: true },
      `${label}（未打开/0目录）`,
    );
    assert.deepEqual(addedTabs, [frozenRootA]);
  };
  assertNavAccepted(
    aliasedTree.tasks.find((t) => t.taskId === sRun.sessionId),
    "侧栏定时触发任务",
  );
  assertNavAccepted(
    aliasedTree.tasks.find((t) => t.taskId === mRun.sessionId),
    "侧栏 runNow 任务",
  );
  assertNavAccepted(frozenSchedAuto, "运行历史前往会话（定时触发）");
  assertNavAccepted(frozenManualAuto, "运行历史前往会话 / Toast 查看（runNow）");
  const sshNavAdded = [];
  const foreignNav = mod.ensureTaskNavigationWorkspace({
    workspacePath: frozenRootA,
    workspaceIdentity: `remote:ssh:ssh-host:22:alice:${frozenRootA}`,
    activateTabByPath: () => false,
    addLocalWorkspaceTab: (wp) => sshNavAdded.push(wp),
  });
  assert.deepEqual(foreignNav, { accepted: false, reason: "remote_attachment_missing" });
  assert.equal(sshNavAdded.length, 0);
  console.log(
    "PASS 冻结目录快照放行 + 独立 Web 三路导航契约（侧栏/运行历史/Toast 全路径 accepted:true，异域 SSH 仍 fail-closed）",
  );

  // ---- 测试 9：会话内 CronCreate path-only 落盘 + useSharedTaskRuntime 非项目/draft-* 共享进程池 vs 项目独占进程 ----
  const readFrozenWorkerLogs = async () =>
    (await readFile(frozenLogFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  // 恢复 frozenProj 的 rootA 以便在 frozenRootA 上新建普通会话并触发 CLI CronCreate
  await frozenProjectSvc.saveProject({ id: frozenProj.id, roots: [frozenRootA] });
  const frozenTaskSvc = frozenServices.get(mod.IZCodeTaskService);
  const cronSession = await frozenTaskSvc.createTask({
    projectId: frozenProj.id,
    workspacePath: frozenRootA,
    modelSelection: frozenModelSelection,
  });
  await frozenAgentSvc.sendPrompt({
    workspacePath: frozenRootA,
    sessionId: cronSession.taskId,
    content: "__CRON_CREATE__",
    inputId: "input-cron-create-1",
  });
  await waitUntil(async () => {
    const logs = await readFrozenWorkerLogs();
    return logs.some(
      (entry) =>
        entry.method === "automation/create:reply" && entry.sessionId === cronSession.taskId,
    );
  }, "CLI CronCreate path-only reverse RPC reply");
  const cronReplyLog = (await readFrozenWorkerLogs()).find(
    (entry) => entry.method === "automation/create:reply" && entry.sessionId === cronSession.taskId,
  );
  assert.equal(cronReplyLog?.error, undefined);
  const cliCreatedId = cronReplyLog?.result?.automation?.automationId;
  assert.ok(cliCreatedId, "CLI CronCreate must return automationId");
  const cliVerifyRepo = new AutomationRepo();
  const cliCreatedRow = await cliVerifyRepo.get(cliCreatedId);
  assert.equal(cliCreatedRow?.hostId, frozenHostId);
  assert.equal(cliCreatedRow?.workspaceIdentity, undefined);
  assert.equal(cliCreatedRow?.workspaceKey, frozenRootA);
  assert.equal(cliCreatedRow?.targetTaskId, cronSession.taskId);

  // P1-1 (real host CronCreate): 在经 canonical 坐标创建的会话内触发 CronCreate，
  // 必须保留 canonical 坐标、回填 tasks.cron_automation_id，且后续 runAutomationNow 续跑不触发 lineage 错误。
  const frozenCanonIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: "srv-frozen",
    workspacePath: frozenRootA,
  });
  const cronCanonSession = await frozenTaskSvc.createTask({
    projectId: frozenProj.id,
    workspacePath: frozenRootA,
    workspaceIdentity: frozenCanonIdentity,
    modelSelection: frozenModelSelection,
  });
  await frozenAgentSvc.sendPrompt({
    workspacePath: frozenRootA,
    workspaceIdentity: frozenCanonIdentity,
    sessionId: cronCanonSession.taskId,
    content: "__CRON_CREATE__",
    inputId: "input-cron-create-canon-1",
  });
  await waitUntil(async () => {
    const logs = await readFrozenWorkerLogs();
    return logs.some(
      (entry) =>
        entry.method === "automation/create:reply" && entry.sessionId === cronCanonSession.taskId,
    );
  }, "CLI CronCreate canonical reverse RPC reply");
  const cronCanonReplyLog = (await readFrozenWorkerLogs()).find(
    (entry) =>
      entry.method === "automation/create:reply" && entry.sessionId === cronCanonSession.taskId,
  );
  assert.equal(cronCanonReplyLog?.error, undefined);
  const cliCanonCreatedId = cronCanonReplyLog?.result?.automation?.automationId;
  assert.ok(cliCanonCreatedId, "Canonical CLI CronCreate must return automationId");
  const cliCanonCreatedRow = await cliVerifyRepo.get(cliCanonCreatedId);
  cliVerifyRepo.close();
  assert.equal(cliCanonCreatedRow?.hostId, frozenHostId);
  assert.equal(cliCanonCreatedRow?.workspaceIdentity, frozenCanonIdentity);
  assert.equal(cliCanonCreatedRow?.workspaceKey, frozenCanonIdentity);
  assert.equal(cliCanonCreatedRow?.targetTaskId, cronCanonSession.taskId);
  const canonTaskDb = new DatabaseSync(join(mod.getAppConfigDir(), "tasks-index.sqlite"));
  try {
    const canonTaskRow = canonTaskDb
      .prepare("SELECT cron_automation_id FROM tasks WHERE workspace_key = ? AND task_id = ?")
      .get(frozenCanonIdentity, cronCanonSession.taskId);
    assert.equal(
      canonTaskRow?.cron_automation_id,
      cliCanonCreatedId,
      "zcodeAgentService CronCreate 必须用一致的 canonical 坐标更新 tasks.cron_automation_id",
    );
    const pathOnlyTaskRow = canonTaskDb
      .prepare("SELECT cron_automation_id FROM tasks WHERE workspace_key = ? AND task_id = ?")
      .get(frozenRootA, cronSession.taskId);
    assert.equal(pathOnlyTaskRow?.cron_automation_id, cliCreatedId);
  } finally {
    canonTaskDb.close();
  }
  await frozenAgentSvc.runAutomationNow(autoTarget(cliCanonCreatedRow));
  await frozenAgentSvc.runAutomationNow(autoTarget(cliCreatedRow));
  await waitUntil(async () => {
    const logs = await readFrozenWorkerLogs();
    return (
      logs.some(
        (entry) =>
          entry.method === "session/resume" && entry.params?.sessionId === cronCanonSession.taskId,
      ) &&
      logs.some(
        (entry) =>
          entry.method === "session/resume" && entry.params?.sessionId === cronSession.taskId,
      )
    );
  }, "both canonical and path-only bound automations resume with matching coordinates");
  const resumeLogs = (await readFrozenWorkerLogs()).filter((e) => e.method === "session/resume");
  assert.equal(
    resumeLogs.find((e) => e.params?.sessionId === cronCanonSession.taskId)?.params?.workspace
      ?.workspaceIdentity,
    frozenCanonIdentity,
  );
  assert.equal(
    resumeLogs.find((e) => e.params?.sessionId === cronSession.taskId)?.params?.workspace
      ?.workspaceIdentity,
    undefined,
  );

  // 两个不同的 draft-* 非项目目录共享同一个 SHARED_TASK_RUNTIME_KEY 物理进程 PID；
  // 而 0 目录项目首次 prepareSession 落库后的 .zcode/workspace/<projectId> 与普通项目各自独占独立 PID
  const draft1 = await frozenProjectSvc.prepareSession({});
  const draft2 = await frozenProjectSvc.prepareSession({});
  assert.notEqual(draft1.workspacePath, draft2.workspacePath);
  const draft1Task = await frozenTaskSvc.createTask({
    projectId: null,
    workspacePath: draft1.workspacePath,
    modelSelection: frozenModelSelection,
  });
  const draft2Task = await frozenTaskSvc.createTask({
    projectId: null,
    workspacePath: draft2.workspacePath,
    modelSelection: frozenModelSelection,
  });
  const zeroProj = await frozenProjectSvc.saveProject({
    name: "Zero Root Shared Check",
    roots: [],
  });
  const zeroPrepared = await frozenProjectSvc.prepareSession({ projectId: zeroProj.id });
  const zeroTask = await frozenTaskSvc.createTask({
    projectId: zeroProj.id,
    workspacePath: zeroPrepared.workspacePath,
    modelSelection: frozenModelSelection,
  });
  const sessionCreateLogs = (await readFrozenWorkerLogs()).filter(
    (entry) => entry.method === "session/create",
  );
  const pidForSession = (sid) =>
    sessionCreateLogs.find((entry) => entry.params?.sessionId === sid)?.pid;
  const pidProj = pidForSession(cronSession.taskId);
  const pidDraft1 = pidForSession(draft1Task.taskId);
  const pidDraft2 = pidForSession(draft2Task.taskId);
  const pidZero = pidForSession(zeroTask.taskId);
  assert.ok(pidProj && pidDraft1 && pidDraft2 && pidZero, "all session/create calls must log pid");
  assert.equal(pidDraft1, pidDraft2, "two draft-* workspaces must share one physical CLI PID");
  assert.notEqual(pidProj, pidDraft1, "project workspace must use dedicated CLI PID");
  assert.notEqual(pidZero, pidDraft1, "0-root project workspace must use dedicated CLI PID");
  assert.notEqual(pidZero, pidProj, "distinct projects must use distinct CLI PIDs");

  // 释放 draft1 preparation 不得杀死 draft2 正在使用的共享进程
  await frozenAgentSvc.disposeWorkspace({
    workspacePath: draft1.workspacePath,
    releasePreparation: true,
  });
  const draft2Task2 = await frozenTaskSvc.createTask({
    projectId: null,
    workspacePath: draft2.workspacePath,
    modelSelection: frozenModelSelection,
  });
  const afterDisposeLogs = (await readFrozenWorkerLogs()).filter(
    (entry) => entry.method === "session/create" && entry.params?.sessionId === draft2Task2.taskId,
  );
  assert.equal(
    afterDisposeLogs[0]?.pid,
    pidDraft1,
    "disposeWorkspace({ releasePreparation: true }) must keep shared process alive for draft2",
  );

  await mod.disposeServiceResourcesAndWait(frozenServices);
  frozenServices = undefined;
  console.log(
    "PASS CLI CronCreate path-only 落盘，且 useSharedTaskRuntime 下 draft-* 共享同 PID、0 目录/普通项目独占 PID",
  );

  // ---- 测试 10：pluginProcessManager 在 standalone-server 下的 lane / processLifecycleReporter / idleTimeoutMs 自动回收与按需拉起 ----
  const pluginEvents = [];
  const isPidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  pluginIdleServices = mod.createLocalServices({
    credentialCipherProvider: cipher,
    zcodeBuiltinProviderConfigFilePath: join(repoRoot, "config/provider/zcode-builtin.test.json"),
    serviceAuthorityMode: "standalone-server",
    projectStorageHostId: frozenHostId,
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspaceRoot,
    allowStandaloneMultiRoot: true,
    pluginManagementIdleTimeoutMs: 180,
    processLifecycleReporter: {
      onSpawn: (event) => pluginEvents.push({ type: "spawn", ...event }),
      onReady: (event) => pluginEvents.push({ type: "ready", ...event }),
      onError: (event) => pluginEvents.push({ type: "error", ...event }),
      onExit: (event) => pluginEvents.push({ type: "exit", ...event }),
    },
  });
  const pluginIdleAgent = pluginIdleServices.get(mod.IZCodeAgentService);
  const firstPluginList = await pluginIdleAgent.listPlugins({ workspacePath: frozenRootA });
  assert.deepEqual(firstPluginList, { plugins: [], diagnostics: [] });
  await waitUntil(
    () => pluginEvents.some((e) => e.type === "spawn" && e.lane === "plugin-management"),
    "plugin-management spawn event",
  );
  const firstPluginSpawn = pluginEvents.find(
    (e) => e.type === "spawn" && e.lane === "plugin-management",
  );
  const pluginPid1 = firstPluginSpawn.pid;
  assert.ok(typeof pluginPid1 === "number" && pluginPid1 > 0);

  await waitUntil(
    () =>
      pluginEvents.some(
        (e) => e.type === "exit" && e.lane === "plugin-management" && e.pid === pluginPid1,
      ) && !isPidAlive(pluginPid1),
    "plugin-management idle-timeout reclaim",
  );
  const firstPluginExit = pluginEvents.find(
    (e) => e.type === "exit" && e.lane === "plugin-management" && e.pid === pluginPid1,
  );
  assert.equal(firstPluginExit.terminationKind, "expected");
  assert.equal(firstPluginExit.terminationReason, "idle-timeout");

  const secondPluginList = await pluginIdleAgent.listPlugins({ workspacePath: frozenRootA });
  assert.deepEqual(secondPluginList, { plugins: [], diagnostics: [] });
  await waitUntil(
    () =>
      pluginEvents.some(
        (e) => e.type === "spawn" && e.lane === "plugin-management" && e.pid !== pluginPid1,
      ),
    "plugin-management respawn after idle reclaim",
  );
  const secondPluginSpawn = pluginEvents.find(
    (e) => e.type === "spawn" && e.lane === "plugin-management" && e.pid !== pluginPid1,
  );
  assert.notEqual(secondPluginSpawn.pid, pluginPid1);
  await mod.disposeServiceResourcesAndWait(pluginIdleServices);
  pluginIdleServices = undefined;
  console.log(
    "PASS pluginProcessManager 空闲回收：standalone-server 触发 idle-timeout 回收旧 PID 后，再次调用干净拉起新 PID",
  );
} finally {
  if (pluginIdleServices && mod)
    await mod.disposeServiceResourcesAndWait(pluginIdleServices).catch(() => {});
  if (frozenServices && mod)
    await mod.disposeServiceResourcesAndWait(frozenServices).catch(() => {});
  for (const h of [hostServicesDisabled, hostServicesEnabled, hostServicesPureRemote])
    if (h && mod) await mod.disposeServiceResourcesAndWait(h.services).catch(() => {});
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => setTimeout(r, 60));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
