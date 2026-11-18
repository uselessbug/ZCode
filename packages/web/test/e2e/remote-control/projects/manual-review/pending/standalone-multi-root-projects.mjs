// 独立 Web 多 root 项目与任务移动的可重复验收（对应 docs/standalone-web-multi-root-projects.md）。
// 真实 ProjectRepository / SQLite / createProjectService；不启动浏览器、不发送模型请求、不访问网络。
//
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-multi-root-projects.mjs
//
// 本脚本只覆盖服务端合同（root 数量、root 变更、moveTask 缺 root 流程、跨 Host、0 目录项目与懒创建）。
// UI 层（项目编辑弹层增删 root、侧栏拖动确认框）见规格验收场景 8，需实机复核。
//
// 场景 8（无项目草稿目录被移走后的自动换绑恢复）同时打包真实 composerDraftStore.ts 的
// rotateMissingPendingTaskDraft，与真实 createProjectService.prepareSession 串起来验证：
// 服务端报 project.draft-workspace-missing，前端换绑新 draftId 重建目录并保留正文草稿。
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const root = await mkdtemp(join(tmpdir(), "zcode-standalone-multi-root-"));
const shared = join(repoRoot, "packages/shared/src");
const services = join(repoRoot, "packages/services/src");
const uiSrc = join(repoRoot, "packages/ui/src");
const outfile = join(root, "multi-root-bundle.cjs");
await build({
  stdin: {
    contents: [
      `export { TaskIndexRepo } from ${JSON.stringify(join(services, "session/taskIndexRepo.ts"))};`,
      `export { createProjectService } from ${JSON.stringify(join(services, "project/index.ts"))};`,
      `export * as composerDraftStore from ${JSON.stringify(join(uiSrc, "v4/composer/composerDraftStore.ts"))};`,
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
      name: "source-only-multi-root-fixture",
      setup(builder) {
        // UI 源码使用 `@/` 别名与 `.js` 后缀指向 .ts/.tsx。
        builder.onResolve({ filter: /^@\// }, ({ path }) => {
          const base = join(uiSrc, path.slice(2));
          const stem = base.replace(/\.js$/, "");
          const found = [`${stem}.ts`, `${stem}.tsx`, base].find((file) => existsSync(file));
          if (!found) throw new Error(`Cannot resolve UI alias: ${path}`);
          return { path: found };
        });
        builder.onResolve({ filter: /^@zcode\// }, ({ path }) => {
          const [, name, ...subpath] = path.split("/");
          const packageRoot = join(repoRoot, "packages", name);
          const manifest = require(join(packageRoot, "package.json"));
          const key = subpath.length ? `./${subpath.join("/")}` : ".";
          const entry = manifest.exports?.[key];
          const target = typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
          if (!target) throw new Error(`Cannot resolve @zcode export: ${path}`);
          return { path: join(packageRoot, target) };
        });
        builder.onResolve({ filter: /^#session-control\// }, ({ path }) => ({
          path: join(
            repoRoot,
            "packages/session-control/src",
            `${path.slice("#session-control/".length)}.ts`,
          ),
        }));
        builder.onResolve({ filter: /^#src\// }, ({ path, importer }) => ({
          path: join(
            importer.startsWith(shared) ? shared : services,
            path.slice(5).replace(/\.js$/, ".ts"),
          ),
        }));
        builder.onResolve({ filter: /^[^./#@][^:]*$/ }, ({ path, importer }) => {
          if (path === "electron") return { path, external: true };
          const req = importer ? createRequire(importer) : require;
          return { path: req.resolve(path) };
        });
      },
    },
  ],
});
const { TaskIndexRepo, createProjectService, composerDraftStore } = require(outfile);

const hostId = "remote:server:e2e-standalone-multi-root";
const otherHostId = "remote:server:e2e-standalone-other";
const workspaceRoot = join(root, "workspace");
const dirA = join(workspaceRoot, "a");
const dirB = join(workspaceRoot, "b");
const dirC = join(workspaceRoot, "c");
await Promise.all([dirA, dirB, dirC].map((path) => mkdir(path, { recursive: true })));

async function expectError(code, run) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message, code, `期望错误码 ${code}，实际 ${message}`);
    return;
  }
  assert.fail(`期望错误码 ${code}，但调用成功`);
}

/** 同一 DB 文件上按 hostId 构造项目仓储，用于跨 Host 场景。 */
async function repositoryFor(dbPath, hostId_, options) {
  const index = new TaskIndexRepo(undefined, hostId_, dbPath);
  return { index, repository: await index.getProjectRepository(options) };
}

async function createService(dbPath, options) {
  const index = new TaskIndexRepo(undefined, hostId, dbPath);
  const repository = await index.getProjectRepository(options);
  const service = createProjectService({
    repository: async () => repository,
    workspaceDirectory: join(
      options.standaloneWorkspaceRoot ?? workspaceRoot,
      ".zcode",
      "workspace",
    ),
    ownerHostId: hostId,
    allowStandaloneCloudWorkspaces: options.allowStandaloneCloudWorkspaces,
    standaloneWorkspaceRoot: options.standaloneWorkspaceRoot,
    ...(options.allowStandaloneMultiRoot ? { allowStandaloneMultiRoot: true } : {}),
  });
  return { index, repository, service };
}

const standaloneOptions = {
  allowStandaloneCloudWorkspaces: true,
  standaloneWorkspaceRoot: workspaceRoot,
  allowStandaloneMultiRoot: true,
};
const normalRemoteOptions = {
  allowStandaloneCloudWorkspaces: true,
  standaloneWorkspaceRoot: workspaceRoot,
};

const identityOf = (path) => `${hostId}:${path}`;
const passes = [];

// 1. 独立 Web 多 root：2 个目录可保存，可移除到 1 个。
{
  const { service } = await createService(join(root, "standalone.sqlite"), standaloneOptions);
  const project = await service.saveProject({
    name: "E2E_STANDALONE_MULTI",
    roots: [dirA, dirB],
  });
  assert.equal(project.roots.length, 2, "独立 Web 项目应保存 2 个 root");
  const reduced = await service.saveProject({ id: project.id, roots: [dirB] });
  assert.deepEqual(
    reduced.roots.map((entry) => entry.rootPath),
    [dirB],
    "独立 Web 项目应允许移除一个 root",
  );
  passes.push("1 独立 Web 多 root 保存与移除");
}

// 2. 普通远端（未开多 root）：>1 目录拒绝，改既有 root 拒绝。
{
  const { service } = await createService(join(root, "normal.sqlite"), normalRemoteOptions);
  await expectError("project.remote-single-root-required", () =>
    service.saveProject({ name: "E2E_NORMAL_MULTI", roots: [dirA, dirB] }),
  );
  const single = await service.saveProject({ name: "E2E_NORMAL_SINGLE", roots: [dirA] });
  await expectError("project.remote-root-immutable", () =>
    service.saveProject({ id: single.id, roots: [dirB] }),
  );
  passes.push("2 普通远端仍单 root / root 不可变");
}

// 3/4. 独立 Web moveTask：缺 root 先 root-confirmation-required，确认后增补 root，cwd 与文件不变。
{
  const { repository, service } = await createService(join(root, "move.sqlite"), standaloneOptions);
  const target = await service.saveProject({ name: "E2E_MOVE_TARGET", roots: [dirA] });
  const taskRef = {
    taskId: "TASK_MOVE",
    workspacePath: dirC,
    workspaceIdentity: identityOf(dirC),
  };
  // 归属先为空（独立 Web 允许非项目会话），再拖入项目。
  repository.reserveCreatedTask({ task: taskRef, projectId: null });
  assert.deepEqual(repository.readProjectTaskRefs(target.id), [], "移动前任务不应属于目标项目");

  await expectError("project.root-confirmation-required", () =>
    service.moveTask({ task: taskRef, projectId: target.id, hostId: hostId }),
  );
  await service.moveTask({
    task: taskRef,
    projectId: target.id,
    hostId: hostId,
    addMissingRoot: true,
  });

  const movedProject = (await service.readProjects()).find((entry) => entry.id === target.id);
  assert.deepEqual(
    movedProject.roots.map((entry) => entry.rootPath).sort(),
    [dirA, dirC].sort(),
    "addMissingRoot 应把任务 cwd 增补为项目 root",
  );
  const movedRefs = repository.readProjectTaskRefs(target.id);
  assert.deepEqual(
    movedRefs.map((entry) => entry.taskId),
    ["TASK_MOVE"],
    "移动应改写任务项目归属",
  );
  assert.equal(movedRefs[0].workspacePath, dirC, "移动不应改写任务 cwd");
  assert.equal((await stat(dirC)).isDirectory(), true, "移动不应物理搬动或删除目录");
  passes.push("3/4 独立 Web 移动缺 root 先确认再增补");

  // 读取路径：移除该 root 后，历史任务仍可解析目录（不报 cwd-not-in-roots）。
  await service.saveProject({ id: target.id, roots: [dirA] });
  const directories = await service.resolveSessionDirectories(taskRef, hostId);
  assert.equal(directories.workspacePath, dirC, "移除 root 后历史任务仍应可解析 cwd");
  passes.push("4b 移除 root 后历史任务读取仍可用");
}

// 5. 普通远端 moveTask：cwd 不在唯一 root 时 cwd-not-in-roots，addMissingRoot 也不能增补。
{
  const { repository, service } = await createService(
    join(root, "normal-move.sqlite"),
    normalRemoteOptions,
  );
  const source = await service.saveProject({ name: "E2E_NORMAL_SOURCE", roots: [dirA] });
  const other = await service.saveProject({ name: "E2E_NORMAL_OTHER", roots: [dirB] });
  const taskRef = {
    taskId: "TASK_NORMAL_MOVE",
    workspacePath: dirA,
    workspaceIdentity: identityOf(dirA),
  };
  repository.reserveCreatedTask({ task: taskRef, projectId: source.id });
  await expectError("project.cwd-not-in-roots", () =>
    service.moveTask({ task: taskRef, projectId: other.id, hostId: hostId }),
  );
  await expectError("project.cwd-not-in-roots", () =>
    service.moveTask({ task: taskRef, projectId: other.id, hostId: hostId, addMissingRoot: true }),
  );
  passes.push("5 普通远端移动仍拒绝增补 root");
}

// 6. 跨 Host 移动仍拒绝。
{
  const dbPath = join(root, "cross-host.sqlite");
  const { repository, service } = await createService(dbPath, standaloneOptions);
  const own = await service.saveProject({ name: "E2E_CROSS_OWN", roots: [dirA] });
  const taskRef = {
    taskId: "TASK_CROSS",
    workspacePath: dirA,
    workspaceIdentity: identityOf(dirA),
  };
  repository.reserveCreatedTask({ task: taskRef, projectId: own.id });
  const otherHost = await repositoryFor(dbPath, otherHostId, standaloneOptions);
  const foreign = await otherHost.repository.saveProject({
    roots: [dirB],
    name: "E2E_CROSS_OTHER",
  });
  await expectError("project.cross-host-move", () =>
    service.moveTask({ task: taskRef, projectId: foreign.id, hostId: hostId }),
  );
  passes.push("6 跨 Host 移动仍拒绝");
}

// 7. 独立 Web 0 目录项目对齐官方桌面生命周期：
//    - 0 目录新建保留 roots: []，未填名称时使用干净默认名 "New project"，磁盘不提前创建目录；
//    - 首次 prepareSession({ projectId }) 懒创建并登记 <workspaceRoot>/.zcode/workspace/<projectId>；
//    - 编辑传 roots: [] 允许清空为 0 目录；传 roots: undefined 保持沿用旧 roots；
//    - 无项目草稿目录 <workspaceRoot>/.zcode/conversations/draft-<id> 保持原样。
{
  const { service } = await createService(join(root, "zero-root.sqlite"), standaloneOptions);
  const unnamedZero = await service.saveProject({});
  assert.equal(unnamedZero.roots.length, 0, "0 目录新建应保留空 roots");
  assert.equal(unnamedZero.name, "New project", "未填名称时应使用干净默认名而非 slug-uuid");
  assert.equal(
    existsSync(join(workspaceRoot, "projects")),
    false,
    "0 目录新建不应再提前创建 /workspace/projects 目录",
  );
  const lazyWorkspaceDir = join(workspaceRoot, ".zcode", "workspace", unnamedZero.id);
  assert.equal(existsSync(lazyWorkspaceDir), false, "prepareSession 前不应提前创建工作目录");

  const preparedZero = await service.prepareSession({ projectId: unnamedZero.id });
  assert.equal(
    preparedZero.workspacePath,
    lazyWorkspaceDir,
    "首次 prepareSession 应懒创建 .zcode/workspace/<projectId>",
  );
  assert.equal((await stat(lazyWorkspaceDir)).isDirectory(), true);
  const refreshedZero = (await service.readProjects()).find((entry) => entry.id === unnamedZero.id);
  assert.deepEqual(
    refreshedZero?.roots.map((entry) => entry.rootPath),
    [lazyWorkspaceDir],
    "首次 prepareSession 后应登记唯一主目录",
  );

  const manual = await service.saveProject({ name: "E2E_MANUAL", roots: [dirA, dirB] });
  const cleared = await service.saveProject({ id: manual.id, roots: [] });
  assert.deepEqual(cleared.roots, [], "编辑传入 roots: [] 应成功清空为 0 目录");

  const keepTarget = await service.saveProject({ name: "E2E_KEEP_UNDEFINED", roots: [dirA, dirB] });
  const renamedOnly = await service.saveProject({ id: keepTarget.id, name: "E2E_RENAMED_ONLY" });
  assert.deepEqual(
    renamedOnly.roots.map((entry) => entry.rootPath).sort(),
    [dirA, dirB].sort(),
    "编辑传 roots: undefined 应保持沿用既有 roots",
  );

  const draftId = "11111111-1111-4111-8111-111111111111";
  const draftSession = await service.prepareSession({ draftId });
  assert.equal(
    draftSession.workspacePath,
    join(workspaceRoot, ".zcode", "conversations", `draft-${draftId}`),
    "无项目草稿目录 .zcode/conversations/draft-<id> 应保持不变",
  );
  passes.push("7 独立 Web 0 目录项目生命周期与 .zcode/workspace/<id> 懒创建");
}

// 8. 无项目草稿目录被移走：prepareSession(reuseDraft) 报 project.draft-workspace-missing，
//    前端 rotateMissingPendingTaskDraft 换绑新 draftId 后重建新目录，正文草稿按 scope 保存不丢失。
{
  const { service } = await createService(join(root, "draft-missing.sqlite"), standaloneOptions);
  // composerDraftStore 通过 window.localStorage 持久化；这里提供内存实现，结束后还原。
  const memory = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, String(value)),
      removeItem: (key) => void memory.delete(key),
    },
  };
  try {
    const store = composerDraftStore;
    const scope = store.resolveComposerScope(null, undefined, "web-e2e");
    const conversations = join(workspaceRoot, ".zcode", "conversations");
    const directoryOf = (draftId) => join(conversations, `draft-${draftId}`);

    // 首次：无项目 prepareSession({ draftId }) 创建 draft-<id> 目录并绑定。
    const original = store.ensurePendingTaskDraft(scope);
    const first = await service.prepareSession({ draftId: original.draftId });
    assert.equal(first.workspacePath, directoryOf(original.draftId));
    assert.equal((await stat(first.workspacePath)).isDirectory(), true);
    store.bindPendingTaskDraft(scope, original.draftId, first.workspacePath);
    assert.equal(store.readPendingTaskDraft(scope)?.workspacePath, first.workspacePath);

    // 用户已输入但尚未发送的正文草稿，按 ComposerScope 独立保存，与 draftId 无关。
    const persisted = store.persistV4ComposerDraft(
      first.workspacePath,
      undefined,
      store.V4_DRAFT_SCOPE_ROOT,
      { text: "尚未发送的草稿正文", mode: "agent" },
      scope,
    );
    assert.ok(persisted !== false, "正文草稿应写入成功");

    // 复用仍存在的目录成功。
    const reused = await service.prepareSession({ draftId: original.draftId, reuseDraft: true });
    assert.equal(reused.workspacePath, first.workspacePath);

    // 人为删掉磁盘上的 draft-<id> 目录：只报告缺失，不静默重建空目录。
    await rm(first.workspacePath, { recursive: true, force: true });
    await expectError("project.draft-workspace-missing", () =>
      service.prepareSession({ draftId: original.draftId, reuseDraft: true }),
    );
    assert.equal(existsSync(first.workspacePath), false, "报错时不得悄悄重建旧目录");

    // 前端恢复：换绑新 draftId，再用 reuseDraft:false 创建新目录。
    const rotated = store.rotateMissingPendingTaskDraft(scope, original.draftId);
    assert.ok(rotated, "无在途命令时应换绑成功");
    assert.notEqual(rotated.draftId, original.draftId);
    assert.equal(rotated.workspacePath, undefined, "新草稿尚未绑定目录");
    assert.equal(rotated.commandId, undefined);
    assert.equal(store.readPendingTaskDraft(scope)?.draftId, rotated.draftId, "新 draftId 已落盘");
    const rebuilt = await service.prepareSession({ draftId: rotated.draftId, reuseDraft: false });
    assert.equal(rebuilt.workspacePath, directoryOf(rotated.draftId));
    assert.notEqual(rebuilt.workspacePath, first.workspacePath);
    assert.equal((await stat(rebuilt.workspacePath)).isDirectory(), true, "应重建新目录");
    store.bindPendingTaskDraft(scope, rotated.draftId, rebuilt.workspacePath);
    assert.equal(store.readPendingTaskDraft(scope)?.workspacePath, rebuilt.workspacePath);

    // 正文草稿完整保留：新旧目录下按同一 scope 读取到同一份文字。
    for (const path of [first.workspacePath, rebuilt.workspacePath]) {
      assert.equal(
        store.readV4ComposerDraft(path, undefined, store.V4_DRAFT_SCOPE_ROOT, scope)?.text,
        "尚未发送的草稿正文",
      );
    }

    // 新目录可继续复用；旧 draftId 已过期且当前无在途命令时再次换绑返回最新草稿，不重复换绑；
    // 若调用方按最新草稿的 workspacePath（reuseDraft: true）幂等重试且该目录也缺失，不得静默重建。
    const reusedAgain = await service.prepareSession({
      draftId: rotated.draftId,
      reuseDraft: true,
    });
    assert.equal(reusedAgain.workspacePath, rebuilt.workspacePath);
    const stale = store.rotateMissingPendingTaskDraft(scope, original.draftId);
    assert.equal(stale?.draftId, rotated.draftId, "过期的 expectedDraftId 返回当前草稿");
    assert.equal(
      stale?.workspacePath,
      rebuilt.workspacePath,
      "返回当前草稿须保留已绑定的 workspacePath",
    );
    assert.equal(store.readPendingTaskDraft(scope)?.draftId, rotated.draftId);

    await rm(rebuilt.workspacePath, { recursive: true, force: true });
    await expectError("project.draft-workspace-missing", () =>
      service.prepareSession({
        draftId: stale.draftId,
        reuseDraft: Boolean(stale.workspacePath),
      }),
    );
    assert.equal(
      existsSync(rebuilt.workspacePath),
      false,
      "幂等重试必须使用 current.workspacePath 对应的 reuseDraft 状态，不能用 false 重建已删目录",
    );
    await mkdir(rebuilt.workspacePath, { recursive: true });

    // 有在途首发命令（commandId）时绝不换绑；即使传入已被其他入口换绑过的旧 draftId 也必须返回 null。
    store.markPendingTaskDraftCommand(scope, rotated.draftId, "command-1", null);
    assert.equal(store.rotateMissingPendingTaskDraft(scope, rotated.draftId), null);
    assert.equal(
      store.rotateMissingPendingTaskDraft(scope, original.draftId),
      null,
      "当前草稿存在在途 commandId 时，即使 expectedDraftId 已过期也必须返回 null",
    );
    const inFlight = store.readPendingTaskDraft(scope);
    assert.equal(inFlight?.draftId, rotated.draftId);
    assert.equal(inFlight?.commandId, "command-1");
    assert.equal(inFlight?.workspacePath, rebuilt.workspacePath);

    // 没有任何草稿时返回 null（不凭空创建）。
    store.completePendingTaskDraft(scope, rotated.draftId);
    assert.equal(store.rotateMissingPendingTaskDraft(scope, rotated.draftId), null);
    assert.equal(store.readPendingTaskDraft(scope), null);
    passes.push("8 无项目草稿目录被移走：自动换绑新 draftId 重建目录并保留正文草稿");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

for (const line of passes) console.log(`PASS ${line}`);
console.log(`\n${passes.length} 组验收全部通过（临时目录 ${root}）`);
await rm(root, { recursive: true, force: true });
