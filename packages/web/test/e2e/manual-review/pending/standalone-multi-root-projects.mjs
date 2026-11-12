// 独立 Web 多 root 项目与任务移动的可重复验收（对应 docs/standalone-web-multi-root-projects.md）。
// 真实 ProjectRepository / SQLite / createProjectService；不启动浏览器、不发送模型请求、不访问网络。
//
// 运行：pnpm exec tsx packages/web/test/e2e/manual-review/pending/standalone-multi-root-projects.mjs
//
// 本脚本只覆盖服务端合同（root 数量、root 变更、moveTask 缺 root 流程、跨 Host）。
// UI 层（项目编辑弹层增删 root、侧栏拖动确认框）见规格验收场景 8，需实机复核。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskIndexRepo } from "../../../../../services/src/session/taskIndexRepo.ts";
import { createProjectService } from "../../../../../services/src/project/index.ts";

const root = await mkdtemp(join(tmpdir(), "zcode-standalone-multi-root-"));
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
    workspaceDirectory: workspaceRoot,
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

// 7. 独立 Web 不会产生 0 root 项目：0 目录新建自动分配；既有项目清空 roots 沿用原 root。
{
  const { service } = await createService(join(root, "zero-root.sqlite"), standaloneOptions);
  const allocated = await service.saveProject({ name: "E2E_AUTO_ROOT" });
  assert.equal(allocated.roots.length, 1, "0 目录新建应自动分配唯一 root");
  assert.ok(
    allocated.roots[0].rootPath.startsWith(join(workspaceRoot, "projects")),
    "自动分配的 root 应位于工作区根下 projects 目录",
  );
  const manual = await service.saveProject({ name: "E2E_MANUAL", roots: [dirA, dirB] });
  const kept = await service.saveProject({ id: manual.id, roots: [] });
  assert.deepEqual(
    kept.roots.map((entry) => entry.rootPath).sort(),
    [dirA, dirB].sort(),
    "清空 roots 时应沿用既有 root，不产生 0 root 项目",
  );
  passes.push("7 独立 Web 不会产生 0 root 项目");
}

for (const line of passes) console.log(`PASS ${line}`);
console.log(`\n${passes.length} 组验收全部通过（临时目录 ${root}）`);
