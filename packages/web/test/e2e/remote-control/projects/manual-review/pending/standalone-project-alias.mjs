// 独立 Web Host 别名回归：真实包装边界 + 项目服务/SQLite + 独立云端数据估算与清理。
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-project-alias.mjs
// 仅窄打包当前源码，不构建应用；使用 mkdtemp 隔离 SQLite、CLI 存储与 fake stdio worker。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../../../../../../../server/src/http.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("http.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["projectHost", "createStandaloneProjectAlias"]);
const functions = ast.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text),
);
assert.equal(functions.length, 2, "必须执行真实 HTTP 别名包装与递归转换函数");
const { outputText } = ts.transpileModule(functions.map((node) => node.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const factory = vm.runInNewContext(`${outputText}\ncreateStandaloneProjectAlias`);
const owner = "remote:server:alias-regression";
const foreign = "remote:server:other";
const calls = [];
const methods = [
  "restoreProject",
  "deleteProject",
  "reorderProjects",
  "resolveSessionDirectories",
  "measureProjectData",
  "deleteProjectData",
];
const service = Object.fromEntries(
  methods.map((method) => [
    method,
    async function (...args) {
      assert.equal(this, service, "包装必须保留服务方法的 this");
      calls.push({ method, args });
      return { hostId: owner, nested: [{ hostId: foreign }] };
    },
  ]),
);
const aliased = factory(service, owner);

for (const method of methods) {
  const input = { id: "project", nested: [{ hostId: "local" }] };
  const result = await aliased[method](input, "local");
  assert.equal(calls.at(-1).args[1], owner, `${method} 应转换位置 Host 参数`);
  assert.equal(calls.at(-1).args[0].nested[0].hostId, owner);
  assert.equal(input.nested[0].hostId, "local", "不修改调用方输入");
  assert.equal(result.hostId, "local");
  assert.equal(result.nested[0].hostId, foreign);
  await aliased[method](input, foreign);
  assert.equal(calls.at(-1).args[1], foreign, `${method} 异域 Host 保持原路由参数`);
  await aliased[method](input);
  assert.equal(calls.at(-1).args[1], undefined, `${method} 不凭空补写可选 Host`);
}
await aliased.restoreProject("project", "local");
await aliased.restoreProject("project", "local");
assert.equal(calls.at(-1).args[1], owner, "重复恢复仍路由至同一 owner");
assert.throws(() => factory(service, "local"), /Canonical remote owner required/);
assert.throws(() => factory(service, ""), /Canonical remote owner required/);
console.log("PASS 项目别名包装：恢复、数据估算/清理、返回值、重复调用与异域 Host 边界");

const repoRoot = fileURLToPath(new URL("../../../../../../../../", import.meta.url));
const require = createRequire(import.meta.url);
let esbuildPath;
try {
  esbuildPath = require.resolve("esbuild");
} catch {
  esbuildPath = join(
    dirname(dirname(realpathSync(join(repoRoot, "node_modules/.bin/esbuild")))),
    "lib/main.js",
  );
}
const { build } = await import(pathToFileURL(esbuildPath).href);
const temporary = await mkdtemp(join(tmpdir(), "zcode-project-alias-"));
let db;
let agentService;
try {
  const shared = join(repoRoot, "packages/shared/src");
  const services = join(repoRoot, "packages/services/src");
  const cronerShim = join(temporary, "croner-shim.ts");
  await writeFile(
    cronerShim,
    `
export class Cron {
  private readonly expr: string;
  constructor(expr: string) {
    const parts = expr.trim().split(/\\s+/);
    if (parts.length !== 5) throw new Error("Invalid cron expression");
    for (const part of parts) {
      if (!/^[\\d*,/-]+$/.test(part)) throw new Error("Invalid cron field");
    }
    this.expr = expr.trim();
  }
  nextRun(from?: Date): Date | null {
    const base = from ? from.getTime() : Date.now();
    const parts = this.expr.split(/\\s+/);
    if (parts[0].startsWith("*/")) {
      const n = Number(parts[0].slice(2));
      if (Number.isInteger(n) && n > 0) {
        const step = n * 60_000;
        return new Date(Math.floor(base / step + 1) * step);
      }
    }
    return new Date(base + 60_000);
  }
  previousRuns(): Date[] {
    return [];
  }
}
`,
  );
  const outfile = join(temporary, "project.cjs");
  await build({
    stdin: {
      contents: [
        `export { createProjectService, createProjectDataPort } from ${JSON.stringify(join(services, "project/index.ts"))};`,
        `export { projectStorage, createProjectDataRepository } from ${JSON.stringify(join(services, "project-storage/index.ts"))};`,
        `export { runTasksDatabaseMigrations } from ${JSON.stringify(join(services, "session/tasksDatabase/migrations.ts"))};`,
        `export { createZCodeAgentService } from ${JSON.stringify(join(services, "zcode-agent/zcodeAgentService.ts"))};`,
        `export { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from ${JSON.stringify(join(services, "zcode-agent/zcodeAgent.ts"))};`,
        `export { createSourceServerWorkspaceService } from ${JSON.stringify(join(services, "source-server-workspace/sourceServerWorkspaceService.ts"))};`,
        `export { SourceServerWorkspaceAliasRepo } from ${JSON.stringify(join(services, "session/sourceServerWorkspaceAliasRepo.ts"))};`,
        `export { setDataBaseDir } from ${JSON.stringify(join(services, "paths.ts"))};`,
        `export { getWorkspaceCheckpointDirectory } from ${JSON.stringify(join(services, "git/repo/gitCheckpointStore.ts"))};`,
        `export { buildServerRemoteWorkspaceIdentity } from ${JSON.stringify(join(shared, "remote-workspace-identity.ts"))};`,
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["@napi-rs/keyring", "node-pty", "electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(outfile).href) },
    logLevel: "silent",
    plugins: [
      {
        name: "source-only-project-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^croner$/ }, () => {
            try {
              return { path: require.resolve("croner") };
            } catch {
              return { path: cronerShim };
            }
          });
          builder.onResolve({ filter: /^@zcode\// }, ({ path }) => {
            const [, name, ...subpath] = path.split("/");
            const packageRoot = join(repoRoot, "packages", name);
            const manifest = require(join(packageRoot, "package.json"));
            const key = subpath.length ? `./${subpath.join("/")}` : ".";
            const entry = manifest.exports?.[key];
            const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
            if (!target) {
              throw new Error(`Cannot resolve @zcode export: ${path}`);
            }
            return { path: join(packageRoot, target) };
          });
          builder.onResolve({ filter: /^#session-control\// }, ({ path }) => ({
            path: join(
              repoRoot,
              "packages/session-control/src",
              `${path.slice("#session-control/".length)}.ts`,
            ),
          }));
          builder.onResolve({ filter: /^#src\// }, ({ path, importer }) => {
            const base = importer.startsWith(shared) ? shared : services;
            return { path: join(base, path.slice(5).replace(/\.js$/, ".ts")) };
          });
          builder.onResolve({ filter: /^[^./#@][^:]*$/ }, ({ path, importer }) => {
            if (path === "@napi-rs/keyring" || path === "node-pty" || path === "electron") {
              return { path, external: true };
            }
            const req = importer ? createRequire(importer) : require;
            return { path: req.resolve(path) };
          });
        },
      },
    ],
  });
  const {
    createProjectService,
    createProjectDataPort,
    createProjectDataRepository,
    createZCodeAgentService,
    createSourceServerWorkspaceService,
    SourceServerWorkspaceAliasRepo,
    projectStorage,
    runTasksDatabaseMigrations,
    setDataBaseDir,
    getWorkspaceCheckpointDirectory,
    buildServerRemoteWorkspaceIdentity,
    ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
  } = require(outfile);

  const dataBaseDir = join(temporary, "data-base");
  setDataBaseDir(dataBaseDir);
  const cliStorageRoot = join(temporary, "cli-storage");
  const dbPath = join(dataBaseDir, "v2", "tasks-index.sqlite");
  await mkdir(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  await runTasksDatabaseMigrations(db, { dbPath });
  await projectStorage.migrate(db, {
    hostId: owner,
    backupDirectories: [join(temporary, "backup")],
  });

  const serverId = "alias-regression";
  const aliasRepo = new SourceServerWorkspaceAliasRepo({
    taskDbPath: dbPath,
    sessionDbPath: join(cliStorageRoot, "db", "db.sqlite"),
    backupRoot: join(temporary, "migration-backups"),
  });
  const sourceServerWorkspaceService = createSourceServerWorkspaceService(aliasRepo, {
    defaultWorkspaceIdentity: (workspacePath) =>
      buildServerRemoteWorkspaceIdentity({ serverId, workspacePath }),
  });

  // 启动隔离的 fake CLI stdio worker，验证热运行 busy 会话保护、冷回落管理面、
  // canonical 记忆目录哈希与非 runtime-unavailable 异常透传。
  const busySessionId = "sess-busy-hot";
  const coldSessionId = "sess-cold-1";
  const workspace = join(temporary, "workspace");
  const zeroSessionRoot = join(workspace, "zero-session-project");
  const coldRoot = join(workspace, "cold-project");
  const hotRoot = join(workspace, "hot-project");
  const errorRoot = join(workspace, "error-project");
  await Promise.all(
    [zeroSessionRoot, coldRoot, hotRoot, errorRoot].map((dir) => mkdir(dir, { recursive: true })),
  );
  const hotIdentity = (
    await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: hotRoot })
  ).canonicalWorkspaceKey;
  const coldIdentity = (
    await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: coldRoot })
  ).canonicalWorkspaceKey;
  const zeroIdentity = (
    await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: zeroSessionRoot })
  ).canonicalWorkspaceKey;
  const errorIdentity = (
    await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: errorRoot })
  ).canonicalWorkspaceKey;

  const memoryDirFor = (workspacePath, workspaceIdentity) => {
    const identity = workspaceIdentity?.trim();
    const keySource = identity || workspacePath;
    const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
    const slug = identity ? "project" : workspacePath.split("/").pop() || "project";
    return join(cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
  };

  // 为 0 会话项目和冷项目分别写入 canonical 记忆文件、本地路径哈希记忆文件、会话文件与检查点。
  const zeroCanonicalMem = join(memoryDirFor(zeroSessionRoot, zeroIdentity), "MEMORY.md");
  const zeroPathHashMem = join(memoryDirFor(zeroSessionRoot, undefined), "MEMORY.md");
  await mkdir(dirname(zeroCanonicalMem), { recursive: true });
  await mkdir(dirname(zeroPathHashMem), { recursive: true });
  await writeFile(zeroCanonicalMem, "zero-canonical-memory-123"); // 25 bytes
  await writeFile(zeroPathHashMem, "zero-local-path-mem"); // 19 bytes

  const coldCanonicalMem = join(memoryDirFor(coldRoot, coldIdentity), "MEMORY.md");
  const coldSessionFile = join(cliStorageRoot, "sessions", coldSessionId, "state.json");
  const coldCheckpointFile = join(getWorkspaceCheckpointDirectory(coldRoot), "cp-1.json");
  await mkdir(dirname(coldCanonicalMem), { recursive: true });
  await mkdir(dirname(coldSessionFile), { recursive: true });
  await mkdir(dirname(coldCheckpointFile), { recursive: true });
  await writeFile(coldCanonicalMem, "cold-canonical-memory"); // 21 bytes
  await writeFile(coldSessionFile, "cold-session-bytes"); // 18 bytes
  await writeFile(coldCheckpointFile, "cold-checkpoint"); // 15 bytes

  const hotSessionFile = join(cliStorageRoot, "sessions", busySessionId, "state.json");
  await mkdir(dirname(hotSessionFile), { recursive: true });
  await writeFile(hotSessionFile, "busy-session-bytes");

  const workerPath = join(temporary, "fake-cli-worker.mjs");
  await writeFile(
    workerPath,
    `
import { createHash } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const storageRoot = process.argv[2];
const workerWorkspaceKey = process.argv[3];
const busyWorkspaceKey = process.argv[4];
const busySessionId = process.argv[5];
const errorWorkspaceKey = process.argv[6];

function memoryRoot(dir) {
  const id = dir.workspaceIdentity?.trim();
  const key = id || dir.workspacePath;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const slug = id ? "project" : (dir.workspacePath.split("/").pop() || "project");
  return join(storageRoot, "memories", "projects", \`\${slug}-\${hash}\`, "memory");
}

async function dirBytes(target) {
  let st;
  try { st = await lstat(target); } catch { return 0; }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of await readdir(target)) total += await dirBytes(join(target, name));
  return total;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  while (buf.includes("\\n")) {
    const idx = buf.indexOf("\\n");
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "runtime/capabilities") {
      if (workerWorkspaceKey === errorWorkspaceKey) {
        process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32603, message: "simulated non-unavailable protocol error" } }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/measure") {
      const sessions = await Promise.all(
        msg.params.sessionIds.map(async (sessionId) => ({
          sessionId,
          bytes: await dirBytes(join(storageRoot, "sessions", sessionId)),
        })),
      );
      const memory = await Promise.all(
        msg.params.directories.map(async (dir) => ({
          workspacePath: dir.workspacePath,
          bytes: await dirBytes(memoryRoot(dir)),
        })),
      );
      process.stdout.write(JSON.stringify({ id: msg.id, result: { sessions, memory } }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/purge") {
      const deleted = [];
      const kept = [];
      for (const sessionId of msg.params.sessionIds) {
        if (workerWorkspaceKey === busyWorkspaceKey && sessionId === busySessionId) {
          kept.push({ sessionId, reason: "running" });
          continue;
        }
        const sDir = join(storageRoot, "sessions", sessionId);
        const bytes = await dirBytes(sDir);
        await rm(sDir, { recursive: true, force: true });
        deleted.push({ sessionId, bytes });
      }
      const memory = [];
      for (const dir of msg.params.directories) {
        const mDir = memoryRoot(dir);
        const bytes = await dirBytes(mDir);
        await rm(mDir, { recursive: true, force: true });
        memory.push({ workspacePath: dir.workspacePath, bytes });
      }
      process.stdout.write(JSON.stringify({ id: msg.id, result: { deleted, kept, failed: [], memory } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  }
});
`,
  );

  agentService = createZCodeAgentService({
    commandResolver: (context) => ({
      command: process.execPath,
      args: [
        workerPath,
        cliStorageRoot,
        context.workspaceKey,
        hotIdentity,
        busySessionId,
        errorIdentity,
      ],
    }),
    isDeletionWorkspaceOwnedByCurrentHost: async (target) => {
      if (target.remoteSessionId) return false;
      const identity = target.workspaceIdentity?.trim();
      if (!identity || !target.workspacePath) return false;
      try {
        const resolved = await sourceServerWorkspaceService.resolveWorkspace({
          workspacePath: target.workspacePath,
        });
        return resolved.canonicalWorkspaceKey === identity;
      } catch {
        return false;
      }
    },
  });

  const roots = [join(workspace, "a"), join(workspace, "b")];
  await Promise.all(roots.map((path) => mkdir(path, { recursive: true })));
  const policy = {
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspace,
    allowStandaloneMultiRoot: true,
  };
  const repository = () => projectStorage.repository(db, owner, policy);
  const dataPort = createProjectDataPort({
    agent: {
      measure: (params) => agentService.measureSessionData(params),
      purge: (params) => agentService.purgeSessionData(params),
    },
    checkpointDirectory: (workspacePath) => getWorkspaceCheckpointDirectory(workspacePath),
  });
  const resolveDirectoryWorkspaceIdentity = async (workspacePath) =>
    (await sourceServerWorkspaceService.resolveWorkspace({ workspacePath })).canonicalWorkspaceKey;

  const makeService = (extra = {}) =>
    createProjectService({
      repository: async () => repository(),
      ownerHostId: owner,
      workspaceDirectory: workspace,
      ...policy,
      allowStandaloneProjectData: true,
      resolveDirectoryWorkspaceIdentity,
      data: {
        repository: () => createProjectDataRepository(db, owner),
        port: dataPort,
      },
      ...extra,
    });
  let real = makeService();
  let web = factory(real, owner);
  const project = await web.saveProject({
    hostId: "local",
    name: "Alias regression",
    roots,
    primaryRoot: roots[1],
    pinned: true,
  });
  assert.equal(project.hostId, "local");
  assert.equal(repository().readTree({ includeTasks: false }).projects[0].hostId, owner);
  const task = {
    taskId: "alias-task",
    workspacePath: roots[1],
    workspaceIdentity: `${owner}:${roots[1]}`,
  };
  repository().reserveCreatedTask({ task, projectId: project.id });
  const before = repository().readTree();
  await web.deleteProject(project.id, "local");
  assert.equal((await web.readProjects({ hostId: "local" })).length, 0);
  assert.equal(
    (await web.readProjects({ hostId: "local", includeDeleted: true }))[0].deleted,
    true,
  );
  // 负向对照只移除本次白名单补项，确认真实服务在修复前确实错路由且未恢复 DB。
  const beforeFix = outputText.replace(/(['"])restoreProject\1,\s*/, "");
  assert.notEqual(beforeFix, outputText, "负向对照必须移除 restoreProject 白名单补项");
  const brokenFactory = vm.runInNewContext(`${beforeFix}\ncreateStandaloneProjectAlias`);
  await assert.rejects(brokenFactory(real, owner).restoreProject(project.id, "local"), {
    message: "project.host-offline",
  });
  assert.equal(
    repository().readTree({ includeDeleted: true, includeTasks: false }).projects[0].deleted,
    true,
  );
  // 恢复不应调用 saveProject 的目录 stat；缺失主目录仍可撤销删除。
  await rm(roots[1], { recursive: true });
  const restored = await web.restoreProject(project.id, "local");
  assert.equal(restored.deleted, false);
  assert.equal(restored.hostId, "local");
  for (const key of ["id", "roots", "position", "pinned", "createdAt"])
    assert.deepEqual(restored[key], project[key]);
  const unchanged = await web.restoreProject(project.id, "local");
  assert.deepEqual(unchanged, restored, "重复恢复不再写入状态");
  assert.deepEqual(repository().readTree().tasks, before.tasks, "软删除和恢复保留任务与 cwd");
  assert.equal((await web.readProjects({ hostId: "local" }))[0].primaryRootStatus, "missing");

  // 1) 未开启 allowStandaloneProjectData、普通远端 owner 与 foreign hostId 一律抛 project.data-local-only
  const disabledService = makeService({ allowStandaloneProjectData: false });
  const disabledWeb = factory(disabledService, owner);
  for (const hostId of ["local", owner, foreign, undefined]) {
    await assert.rejects(disabledWeb.measureProjectData([project.id], hostId), {
      message: "project.data-local-only",
    });
    await assert.rejects(disabledWeb.deleteProjectData(project.id, hostId), {
      message: "project.data-local-only",
    });
  }
  await assert.rejects(web.measureProjectData([project.id], foreign), {
    message: "project.data-local-only",
  });
  await assert.rejects(web.deleteProjectData(project.id, foreign), {
    message: "project.data-local-only",
  });
  // 未经过 HTTP alias 直接传 "local" 给远端 owner 也拒绝
  await assert.rejects(real.measureProjectData([project.id], "local"), {
    message: "project.data-local-only",
  });
  // 直接调用 agentService 传入异域 workspaceIdentity 拒绝
  await assert.rejects(
    agentService.measureSessionData({
      sessionIds: [],
      directories: [{ workspacePath: coldRoot, workspaceIdentity: "remote:server:other:/x" }],
    }),
    { message: "project.data-local-only" },
  );
  await assert.rejects(
    agentService.purgeSessionData({
      workspace: { workspacePath: coldRoot, workspaceIdentity: "remote:ssh:other:22:/x" },
      sessionIds: [],
      directories: [],
    }),
    { message: "project.data-local-only" },
  );

  // 2) 0 会话项目 root 与带 canonical identity 的冷工作区项目：精确命中 canonical 记忆目录
  const zeroProject = await web.saveProject({
    hostId: "local",
    name: "Zero session canonical",
    roots: [zeroSessionRoot],
  });
  const coldProject = await web.saveProject({
    hostId: "local",
    name: "Cold canonical",
    roots: [coldRoot],
  });
  repository().reserveCreatedTask({
    task: { taskId: coldSessionId, workspacePath: coldRoot, workspaceIdentity: coldIdentity },
    projectId: coldProject.id,
  });

  const measured = await web.measureProjectData([zeroProject.id, coldProject.id], "local");
  assert.deepEqual(structuredClone(measured.projects), [
    {
      id: zeroProject.id,
      sessions: 0,
      sessionBytes: 0,
      memoryBytes:
        Buffer.byteLength("zero-canonical-memory-123") + Buffer.byteLength("zero-local-path-mem"),
      checkpointBytes: 0,
    },
    {
      id: coldProject.id,
      sessions: 1,
      sessionBytes: Buffer.byteLength("cold-session-bytes"),
      memoryBytes: Buffer.byteLength("cold-canonical-memory"),
      checkpointBytes: Buffer.byteLength("cold-checkpoint"),
    },
  ]);

  // 软删除并彻底清理 0 会话项目与冷项目（双记忆命名空间均需释放）
  await web.deleteProject(zeroProject.id, "local");
  const zeroPurged = await web.deleteProjectData(zeroProject.id, "local");
  assert.equal(
    zeroPurged.freedBytes,
    Buffer.byteLength("zero-canonical-memory-123") + Buffer.byteLength("zero-local-path-mem"),
  );
  assert.equal(zeroPurged.failed, 0);
  await assert.rejects(stat(zeroCanonicalMem), { code: "ENOENT" });
  await assert.rejects(stat(zeroPathHashMem), { code: "ENOENT" });

  await web.deleteProject(coldProject.id, "local");
  const coldPurged = await web.deleteProjectData(coldProject.id, "local");
  assert.equal(
    coldPurged.freedBytes,
    Buffer.byteLength("cold-session-bytes") +
      Buffer.byteLength("cold-canonical-memory") +
      Buffer.byteLength("cold-checkpoint"),
  );
  assert.equal(coldPurged.deletedSessions, 1);
  assert.equal(coldPurged.failed, 0);
  await assert.rejects(stat(coldCanonicalMem), { code: "ENOENT" });
  await assert.rejects(stat(coldSessionFile), { code: "ENOENT" });
  await assert.rejects(stat(coldCheckpointFile), { code: "ENOENT" });

  // 3) 热运行 busy 会话命中对应 canonical workspace CLI 返回 kept: running，项目保持软删除可恢复，
  //    且共享主目录的两个记忆命名空间（本地路径哈希 + canonical 哈希）均受保护不误删。
  const hotCanonicalMem = join(memoryDirFor(hotRoot, hotIdentity), "MEMORY.md");
  const hotLocalPathMem = join(memoryDirFor(hotRoot, undefined), "MEMORY.md");
  await mkdir(dirname(hotCanonicalMem), { recursive: true });
  await mkdir(dirname(hotLocalPathMem), { recursive: true });
  await writeFile(hotCanonicalMem, "hot-canonical-keep");
  await writeFile(hotLocalPathMem, "hot-local-keep");
  const hotProject = await web.saveProject({
    hostId: "local",
    name: "Hot busy project",
    roots: [hotRoot],
  });
  repository().reserveCreatedTask({
    task: { taskId: busySessionId, workspacePath: hotRoot, workspaceIdentity: hotIdentity },
    projectId: hotProject.id,
  });
  // 拉起 hotRoot 的 canonical CLI（使其成为热运行进程）
  await agentService.prepareStorage({ workspacePath: hotRoot, workspaceIdentity: hotIdentity });
  await web.deleteProject(hotProject.id, "local");
  const hotPurged = await web.deleteProjectData(hotProject.id, "local");
  assert.equal(hotPurged.runningSessions, 1);
  assert.equal(hotPurged.deletedSessions, 0);
  assert.equal(await readFile(hotSessionFile, "utf8"), "busy-session-bytes");
  assert.equal(await readFile(hotCanonicalMem, "utf8"), "hot-canonical-keep");
  assert.equal(await readFile(hotLocalPathMem, "utf8"), "hot-local-keep");
  const stillSoftDeleted = (await web.readProjects({ hostId: "local", includeDeleted: true })).find(
    (p) => p.id === hotProject.id,
  );
  assert.equal(stillSoftDeleted?.deleted, true, "保留运行中会话时项目必须维持软删除可恢复");
  const recoveredHot = await web.restoreProject(hotProject.id, "local");
  assert.equal(recoveredHot.deleted, false);

  // 3b) worktree 任务场景与多目录独立身份解析：
  //     - 受管 worktree 任务的 cwd 位于临时 worktree_root 下，其项目记忆归属主 workspacePath，
  //       即使 worktree 目录已被删除也不把临时 worktree 路径当作独立记忆 root 去估算或误删；
  //     - 普通多目录项目（非 worktree 任务）的每个可删目录仍独立解析 canonical workspaceIdentity。
  const wtWorkspaceRoot = join(workspace, "wt-main");
  const wtCwdDir = join(workspace, "wt-worktree-1-deleted");
  await mkdir(wtWorkspaceRoot, { recursive: true });
  const wtMainIdentity = await resolveDirectoryWorkspaceIdentity(wtWorkspaceRoot);
  const wtCwdIdentity = await resolveDirectoryWorkspaceIdentity(wtCwdDir);
  assert.notEqual(wtMainIdentity, wtCwdIdentity);
  const wtMainMem = join(memoryDirFor(wtWorkspaceRoot, wtMainIdentity), "MEMORY.md");
  const wtMainLocalPathMem = join(memoryDirFor(wtWorkspaceRoot, undefined), "MEMORY.md");
  const wtCwdMem = join(memoryDirFor(wtCwdDir, wtCwdIdentity), "MEMORY.md");
  const wtCwdPathHashMem = join(memoryDirFor(wtCwdDir, undefined), "MEMORY.md");
  await Promise.all(
    [wtMainMem, wtMainLocalPathMem, wtCwdMem, wtCwdPathHashMem].map(async (f) => {
      await mkdir(dirname(f), { recursive: true });
    }),
  );
  await writeFile(wtMainMem, "wt-main-123"); // 11 bytes
  await writeFile(wtMainLocalPathMem, "wt-local-mem!"); // 13 bytes
  await writeFile(wtCwdMem, "wt-cwd-unrelated");
  await writeFile(wtCwdPathHashMem, "path-hash-untouched");
  const wtProject = await web.saveProject({
    hostId: "local",
    name: "Worktree dir identity check",
    roots: [wtWorkspaceRoot],
  });
  // 用 SQL 直接写入一个带 worktree root_path 的任务，模拟 worktree cwd 与归属 workspacePath 不同（且 worktree 已删）
  db.prepare(
    `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,worktree_root)
     VALUES(?,?,?,?,0,0,?,?,?,1,?)`,
  ).run(
    wtMainIdentity,
    wtWorkspaceRoot,
    wtMainIdentity,
    "sess-wt-1",
    owner,
    wtCwdDir,
    wtProject.id,
    wtCwdDir,
  );
  const wtMeasured = await web.measureProjectData([wtProject.id], "local");
  assert.equal(
    wtMeasured.projects[0].memoryBytes,
    Buffer.byteLength("wt-main-123") + Buffer.byteLength("wt-local-mem!"),
    "worktree 任务项目记忆只按主 workspacePath 统计（同时覆盖本地路径哈希与 canonical 双命名空间）",
  );
  await web.deleteProject(wtProject.id, "local");
  await web.deleteProjectData(wtProject.id, "local");
  await assert.rejects(stat(wtMainMem), { code: "ENOENT" });
  await assert.rejects(stat(wtMainLocalPathMem), { code: "ENOENT" });
  assert.equal(
    await readFile(wtCwdMem, "utf8"),
    "wt-cwd-unrelated",
    "worktree 临时目录对应的 unrelated canonical 记忆不得被误删",
  );
  assert.equal(await readFile(wtCwdPathHashMem, "utf8"), "path-hash-untouched");

  // 多目录项目（非 worktree）：每个可删 root 各自独立解析 canonical workspaceIdentity
  const multiDir1 = join(workspace, "multi-dir-1");
  const multiDir2 = join(workspace, "multi-dir-2");
  await Promise.all([mkdir(multiDir1, { recursive: true }), mkdir(multiDir2, { recursive: true })]);
  const multiId1 = await resolveDirectoryWorkspaceIdentity(multiDir1);
  const multiId2 = await resolveDirectoryWorkspaceIdentity(multiDir2);
  const multiMem1 = join(memoryDirFor(multiDir1, multiId1), "MEMORY.md");
  const multiMem2 = join(memoryDirFor(multiDir2, multiId2), "MEMORY.md");
  await Promise.all([
    mkdir(dirname(multiMem1), { recursive: true }),
    mkdir(dirname(multiMem2), { recursive: true }),
  ]);
  await writeFile(multiMem1, "multi-1-mem"); // 11 bytes
  await writeFile(multiMem2, "multi-2-mem!"); // 12 bytes
  const multiProject = await web.saveProject({
    hostId: "local",
    name: "Multi root dir identity check",
    roots: [multiDir1, multiDir2],
  });
  const multiMeasured = await web.measureProjectData([multiProject.id], "local");
  assert.equal(multiMeasured.projects[0].memoryBytes, 23);
  await web.deleteProject(multiProject.id, "local");
  await web.deleteProjectData(multiProject.id, "local");
  await assert.rejects(stat(multiMem1), { code: "ENOENT" });
  await assert.rejects(stat(multiMem2), { code: "ENOENT" });

  // 4) 非 ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE 异常原样透传不吞并、不回落管理面进程
  await agentService.prepareStorage({ workspacePath: errorRoot, workspaceIdentity: errorIdentity });
  await assert.rejects(
    agentService.purgeSessionData({
      workspace: { workspacePath: errorRoot, workspaceIdentity: errorIdentity },
      sessionIds: [busySessionId],
      directories: [],
    }),
    (err) =>
      err?.code !== ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE &&
      String(err?.message ?? "").includes("simulated non-unavailable protocol error"),
  );

  // 关闭并重新打开 DB，排除仅在服务对象内恢复成功的假通过。
  await agentService.disposeAllAndWait();
  agentService = undefined;
  db.close();
  db = new DatabaseSync(dbPath);
  real = makeService();
  web = factory(real, owner);
  assert.equal(
    (await web.readProjects({ hostId: "local" })).some((item) => item.id === project.id),
    true,
  );
  assert.equal(repository().readTree().projects[0].hostId, owner);
  assert.deepEqual(
    repository()
      .readTree()
      .tasks.filter((t) => t.taskId === "alias-task"),
    before.tasks,
  );
  console.log(
    "PASS 真实项目服务/SQLite：standalone 数据估算/清理、canonical 记忆哈希、热 busy 保护、冷回落、异常透传与权限门禁",
  );
} finally {
  await agentService?.disposeAllAndWait().catch(() => {});
  db?.close();
  await rm(temporary, { recursive: true, force: true });
}
