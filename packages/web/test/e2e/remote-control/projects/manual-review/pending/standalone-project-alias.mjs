// 独立 Web Host 别名回归：真实包装边界 + 项目服务/SQLite。
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-project-alias.mjs
// 仅窄打包当前源码，不构建应用；未覆盖 HTTP/WebSocket 或浏览器 UI。
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

for (const method of methods.slice(0, 4)) {
  const input = { id: "project", nested: [{ hostId: "local" }] };
  const result = await aliased[method](input, "local");
  assert.equal(calls.at(-1).args[1], owner, `${method} 应转换位置 Host 参数`);
  assert.equal(calls.at(-1).args[0].nested[0].hostId, owner);
  assert.equal(input.nested[0].hostId, "local", "不修改调用方输入");
  assert.equal(result.hostId, "local");
  assert.equal(result.nested[0].hostId, foreign);
}
await aliased.restoreProject("project", "local");
await aliased.restoreProject("project", "local");
assert.equal(calls.at(-1).args[1], owner, "重复恢复仍路由至同一 owner");
await aliased.restoreProject("project", foreign);
assert.equal(calls.at(-1).args[1], foreign, "其他 Host 保持原路由参数");
await aliased.restoreProject("project");
assert.equal(calls.at(-1).args[1], undefined, "不凭空补写可选 Host");
for (const method of methods.slice(4)) {
  await aliased[method]("project", "local");
  assert.equal(calls.at(-1).args[1], "local", "数据清理方法不扩大别名转换范围");
}
assert.throws(() => factory(service, "local"), /Canonical remote owner required/);
assert.throws(() => factory(service, ""), /Canonical remote owner required/);
console.log("PASS 项目别名包装：恢复与既有方法、返回值、重复调用、其他 Host、数据清理边界");

// Bug 回归依据：stub 只能证明参数转换；这里让同一包装调用真实服务及持久化仓库，
// 验证 canonical owner、软删除恢复和拒绝路径，所有 DB/目录都来自本次 mkdtemp。
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
try {
  const shared = join(repoRoot, "packages/shared/src");
  const services = join(repoRoot, "packages/services/src");
  const sharedShim = join(temporary, "shared.ts");
  // 只缩小 barrel，全部 re-export 当前真实源码；不替换项目业务、SQL 或错误处理。
  await writeFile(
    sharedShim,
    [
      "channels.ts",
      "log-format.ts",
      "remote-workspace-identity.ts",
      "task-realtime-core.ts",
      "zcode-task-types.ts",
      "zcode-agent-policy.ts",
      "automation-types.ts",
      "bots.ts",
      "model-selection.ts",
      "zcode-task-types-core.ts",
      "database-startup.ts",
      "storage.ts",
      "zcode-agent-runtime.ts",
      "runtimeEnv.ts",
      "settings-errors.ts",
      "zcode-task-mode-schema.ts",
    ]
      .map((file) => `export * from ${JSON.stringify(join(shared, file))};`)
      .join("\n"),
  );
  const outfile = join(temporary, "project.cjs");
  await build({
    stdin: {
      contents: [
        `export { createProjectService } from ${JSON.stringify(join(services, "project/index.ts"))};`,
        `export { projectStorage } from ${JSON.stringify(join(services, "project-storage/index.ts"))};`,
        `export { runTasksDatabaseMigrations } from ${JSON.stringify(join(services, "session/tasksDatabase/migrations.ts"))};`,
      ].join("\n"),
      resolveDir: repoRoot,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(outfile).href) },
    logLevel: "silent",
    plugins: [
      {
        name: "source-only-project-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@zcode\/shared$/ }, () => ({ path: sharedShim }));
          builder.onResolve({ filter: /^@zcode\// }, ({ path }) => {
            const [, name, ...subpath] = path.split("/");
            const packageRoot = join(repoRoot, "packages", name);
            const manifest = require(join(packageRoot, "package.json"));
            const entry = manifest.exports?.[subpath.length ? `./${subpath.join("/")}` : "."];
            return { path: join(packageRoot, typeof entry === "string" ? entry : entry.import) };
          });
          builder.onResolve({ filter: /^#src\// }, ({ path, importer }) => {
            const base = importer.startsWith(shared) ? shared : services;
            return { path: join(base, path.slice(5).replace(/\.js$/, ".ts")) };
          });
          builder.onResolve({ filter: /^[^./#@][^:]*$/ }, ({ path }) => ({
            path: require.resolve(path),
          }));
        },
      },
    ],
  });
  const { createProjectService, projectStorage, runTasksDatabaseMigrations } = require(outfile);
  const dbPath = join(temporary, "projects.sqlite");
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON");
  await runTasksDatabaseMigrations(db, { dbPath });
  await projectStorage.migrate(db, {
    hostId: owner,
    backupDirectories: [join(temporary, "backup")],
  });
  const workspace = join(temporary, "workspace");
  const roots = [join(workspace, "a"), join(workspace, "b")];
  await Promise.all(roots.map((path) => mkdir(path, { recursive: true })));
  const policy = {
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot: workspace,
    allowStandaloneMultiRoot: true,
  };
  const repository = () => projectStorage.repository(db, owner, policy);
  const makeService = () =>
    createProjectService({
      repository: async () => repository(),
      ownerHostId: owner,
      workspaceDirectory: workspace,
      ...policy,
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
  for (const hostId of ["local", owner, foreign, undefined]) {
    await assert.rejects(web.measureProjectData([project.id], hostId), {
      message: "project.data-local-only",
    });
    await assert.rejects(web.deleteProjectData(project.id, hostId), {
      message: "project.data-local-only",
    });
  }
  await assert.rejects(web.restoreProject(project.id, foreign), {
    message: "project.host-offline",
  });
  await assert.rejects(web.restoreProject("missing-project", "local"), {
    message: "project.not-found",
  });
  await assert.rejects(real.restoreProject(project.id, "local"), {
    message: "project.host-offline",
  });
  // 关闭并重新打开 DB，排除仅在服务对象内恢复成功的假通过。
  db.close();
  db = new DatabaseSync(dbPath);
  real = makeService();
  web = factory(real, owner);
  assert.equal((await web.readProjects({ hostId: "local" }))[0].id, project.id);
  assert.equal(repository().readTree().projects[0].hostId, owner);
  assert.deepEqual(repository().readTree().tasks, before.tasks);
  console.log(
    "PASS 真实项目服务/SQLite：软删除恢复、重复恢复、缺失主目录、任务保留、重开持久化、其他 Host 与数据清理拒绝",
  );
} finally {
  db?.close();
  await rm(temporary, { recursive: true, force: true });
}
