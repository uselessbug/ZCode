// 独立 Web 归档永久删除 CLI Carrier 路由与边界回归（隔离临时目录 + 桩 stdio CLI 进程，不触碰真实用户数据）。
//
// 覆盖（对应 docs/standalone-web-task-and-project-compat.md「补充边界：独立 Web 归档永久删除的 CLI Carrier 路由」）：
// 1. 冷态（目标工作区无活跃 CLI）且为当前 standalone Server canonical 身份：
//    previewSessionDeletion / executeSessionDeletion（经 zcodeTaskService）回落到当前 Host 控制面 carrier，
//    不拉起目标项目 CLI，完整透传 workspacePath / workspaceIdentity / revision / operationId。
// 2. 热态（目标工作区已有活跃 CLI）：直接复用原工作区 client，不走控制面 carrier。
// 3. 异域身份（其他 server、ssh）、错 path 与携带 remoteSessionId：严禁回落，透传 ERR_ZCODE_AGENT_RUNTIME_UNAVAILABLE。
//
// 运行：
//   corepack pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-archived-deletion-carrier.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.env.ZCODE_DELETION_CARRIER_STUB === "1") {
  await runStubCli();
} else if (process.env.ZCODE_DELETION_CARRIER_CHILD === "1") {
  await runSuite();
} else {
  const root = await mkdtemp(join(tmpdir(), "zcode-deletion-carrier-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename], {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_DELETION_CARRIER_CHILD: "1",
        ZCODE_DELETION_CARRIER_ROOT: root,
      },
      stdio: "inherit",
    });
    assert.equal(result.status, 0, `fixture child exited with ${result.status}`);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function runStubCli() {
  const { createInterface } = await import("node:readline");
  const logFile = process.env.ZCODE_DELETION_CARRIER_LOG;
  const cwd = process.cwd();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const method = message.method;
    const params = message.params ?? {};
    appendFileSync(logFile, `${JSON.stringify({ cwd, method, params })}\n`);
    if (method === "initialize") {
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
    if (method === "v4/storage/sessionData/deletionPreview") {
      send({
        id: message.id,
        result: {
          sessionId: params.sessionId,
          revision: `rev-${params.sessionId}`,
          sessionIds: [params.sessionId],
          forks: [],
          retainedArtifacts: [],
          deletedFiles: 1,
          incomplete: false,
          completed: false,
        },
      });
      return;
    }
    if (method === "v4/storage/sessionData/deletionExecute") {
      send({
        id: message.id,
        result: {
          sessionId: params.sessionId,
          status: "deleted",
          sessionIds: [params.sessionId],
          retainedArtifacts: 0,
        },
      });
      return;
    }
    if (method === "session/list" || method === "v4/session/list") {
      send({ id: message.id, result: { sessions: [] } });
      return;
    }
    send({ id: message.id, result: {} });
  });
}

async function runSuite() {
  const root = process.env.ZCODE_DELETION_CARRIER_ROOT;
  assert.ok(root);

  const { setDataBaseDir } = await import("../../../../../../../services/src/paths.ts");
  const { createLocalServices, disposeServiceResourcesAndWait, migrateApplicationStorage } =
    await import("../../../../../../../services/src/node.ts");
  const { IZCodeTaskService } =
    await import("../../../../../../../services/src/session/zcodeTaskService.ts");
  const { IZCodeAgentService, ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } =
    await import("../../../../../../../services/src/zcode-agent/zcodeAgent.ts");
  const { createSourceServerWorkspaceService } =
    await import("../../../../../../../services/src/source-server-workspace/sourceServerWorkspaceService.ts");
  const { SourceServerWorkspaceAliasRepo } =
    await import("../../../../../../../services/src/session/sourceServerWorkspaceAliasRepo.ts");
  const { TaskIndexRepo } =
    await import("../../../../../../../services/src/session/taskIndexRepo.ts");
  const { buildServerRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } =
    await import("../../../../../../../shared/src/index.ts");

  const logFile = join(root, "stub-calls.ndjson");
  const wsCold = join(root, "ws-cold");
  const wsHot = join(root, "ws-hot");
  const wsForeign = join(root, "ws-foreign");
  await Promise.all([wsCold, wsHot, wsForeign].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(logFile, "", "utf8");

  const serverId = "standalone-test-server";
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId, workspacePath: "/" }),
  );
  assert.ok(hostId);

  setDataBaseDir(root);
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";
  process.env.ZCODE_SERVER_ID = serverId;
  await migrateApplicationStorage(undefined, hostId);

  const repoRoot = resolve(import.meta.dirname, "../../../../../../../..");
  const builtinConfigPath = join(repoRoot, "config/provider/zcode-builtin.test.json");
  const sourceServerWorkspaceService = createSourceServerWorkspaceService(
    new SourceServerWorkspaceAliasRepo(),
    {
      defaultWorkspaceIdentity: (workspacePath) =>
        buildServerRemoteWorkspaceIdentity({ serverId, workspacePath }),
    },
  );
  const cipher = {
    encrypt: async (value) => value,
    decrypt: async (value) => value,
  };

  let services;
  try {
    services = createLocalServices({
      credentialCipherProvider: cipher,
      runtimeProcessEnvPatch: {},
      zcodeBuiltinProviderConfigFilePath: builtinConfigPath,
      serviceAuthorityMode: "standalone-server",
      projectStorageHostId: hostId,
      sourceServerWorkspaceService,
      allowStandaloneCloudWorkspaces: true,
      standaloneWorkspaceRoot: root,
      allowStandaloneMultiRoot: true,
      zcodeAgentCommandResolver: (ctx) => ({
        command: process.execPath,
        args: ["--experimental-strip-types", import.meta.filename],
        cwd: ctx.workspacePath,
        env: {
          ...process.env,
          ZCODE_DELETION_CARRIER_STUB: "1",
          ZCODE_DELETION_CARRIER_LOG: logFile,
        },
      }),
    });

    const taskService = services.get(IZCodeTaskService);
    const agentService = services.get(IZCodeAgentService);
    const taskIndexRepo = new TaskIndexRepo(undefined, hostId);
    const readCalls = async () =>
      (await readFile(logFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    const coldIdentity = (
      await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: wsCold })
    ).canonicalWorkspaceKey;
    const hotIdentity = (
      await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: wsHot })
    ).canonicalWorkspaceKey;

    const seedArchivedTask = async (workspacePath, workspaceIdentity, taskId) => {
      await taskIndexRepo.applyCliFacts({
        meta: {
          taskId,
          traceId: `trace-${taskId}`,
          workspacePath,
          workspaceIdentity,
          title: taskId,
          createdAt: 1000,
          updatedAt: 2000,
          mode: "default",
        },
      });
      await taskIndexRepo.updateTaskState({
        workspacePath,
        workspaceIdentity,
        taskId,
        patch: { archived: true },
      });
    };

    // 1. 冷态（wsCold 无活跃 CLI）：canonical 身份回落当前 Host 控制面 carrier，不拉起 wsCold CLI
    await seedArchivedTask(wsCold, coldIdentity, "task-cold-1");
    const previewCold = await taskService.previewArchivedTaskDeletion({
      workspacePath: wsCold,
      workspaceIdentity: coldIdentity,
      taskId: "task-cold-1",
    });
    assert.equal(previewCold.revision, "rev-task-cold-1");

    const deletedCold = await taskService.permanentlyDeleteArchivedTask({
      workspacePath: wsCold,
      workspaceIdentity: coldIdentity,
      taskId: "task-cold-1",
      revision: previewCold.revision,
      operationId: "op-cold-1",
    });
    assert.equal(deletedCold.status, "deleted");
    assert.deepEqual(
      await taskService.listPermanentlyDeletedTaskIds({
        workspacePath: wsCold,
        workspaceIdentity: coldIdentity,
      }),
      ["task-cold-1"],
    );

    const coldCalls = (await readCalls()).filter(
      (call) => call.method !== "initialize" && call.params?.sessionId === "task-cold-1",
    );
    assert.equal(coldCalls.length, 2);
    for (const call of coldCalls) {
      assert.notEqual(call.cwd, wsCold, "冷态删除绝不能拉起目标项目 CLI");
      assert.match(call.cwd, /plugin-workspace$/);
      assert.deepEqual(call.params.workspace, {
        workspacePath: wsCold,
        workspaceIdentity: coldIdentity,
      });
    }
    assert.equal(coldCalls[1].params.revision, "rev-task-cold-1");
    assert.equal(coldCalls[1].params.operationId, "op-cold-1");
    console.log("PASS 1 冷态 standalone canonical 归档预检与永久删除走控制面 carrier");

    // 2. 热态（wsHot 已有活跃 CLI）：直接复用原 workspace client，不走控制面
    await agentService.listSessions({
      workspacePath: wsHot,
      workspaceIdentity: hotIdentity,
    });
    await seedArchivedTask(wsHot, hotIdentity, "task-hot-1");
    const previewHot = await taskService.previewArchivedTaskDeletion({
      workspacePath: wsHot,
      workspaceIdentity: hotIdentity,
      taskId: "task-hot-1",
    });
    const deletedHot = await taskService.permanentlyDeleteArchivedTask({
      workspacePath: wsHot,
      workspaceIdentity: hotIdentity,
      taskId: "task-hot-1",
      revision: previewHot.revision,
      operationId: "op-hot-1",
    });
    assert.equal(deletedHot.status, "deleted");
    const hotCalls = (await readCalls()).filter(
      (call) => call.method !== "initialize" && call.params?.sessionId === "task-hot-1",
    );
    assert.equal(hotCalls.length, 2);
    for (const call of hotCalls) {
      assert.equal(call.cwd, wsHot, "热态必须复用原 workspace CLI");
    }
    console.log("PASS 2 热态归档预检与永久删除复用原工作区 CLI");

    // 3. 异域身份、错 path、带 remoteSessionId：严禁 fallback，透传 ERR_ZCODE_AGENT_RUNTIME_UNAVAILABLE
    const beforeRejectCalls = (await readCalls()).length;
    for (const item of [
      {
        label: "异域 server 同 path",
        workspace: { workspacePath: wsCold, workspaceIdentity: `remote:server:other:${wsCold}` },
      },
      {
        label: "异域 ssh",
        workspace: {
          workspacePath: wsForeign,
          workspaceIdentity: `remote:ssh:box:22:alice:${wsForeign}`,
        },
      },
      {
        label: "未识别/非法远端身份",
        workspace: {
          workspacePath: wsForeign,
          workspaceIdentity: `remote:unknown:${wsForeign}`,
        },
      },
      {
        label: "本 server 错 path",
        workspace: { workspacePath: wsForeign, workspaceIdentity: coldIdentity },
      },
      {
        label: "携带 remoteSessionId",
        workspace: {
          workspacePath: wsCold,
          workspaceIdentity: coldIdentity,
          remoteSessionId: "remote-sess-1",
        },
      },
    ]) {
      await assert.rejects(
        () =>
          agentService.previewSessionDeletion({
            sessionId: "task-forbidden",
            workspace: item.workspace,
          }),
        (err) => err?.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
        `${item.label} preview 必须拒绝 fallback`,
      );
      await assert.rejects(
        () =>
          agentService.executeSessionDeletion({
            sessionId: "task-forbidden",
            workspace: item.workspace,
            revision: "rev",
            operationId: "op",
          }),
        (err) => err?.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
        `${item.label} execute 必须拒绝 fallback`,
      );
    }
    assert.equal((await readCalls()).length, beforeRejectCalls, "被拒绝场景不得发起任何 CLI 请求");
    console.log("PASS 3 异域身份/错 path/remoteSessionId 禁止 fallback 并透传 UNAVAILABLE");

    taskIndexRepo.close();
  } finally {
    if (services) {
      await disposeServiceResourcesAndWait(services);
    }
  }
}
