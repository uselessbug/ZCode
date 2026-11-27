/* eslint-disable max-lines -- 独立 Web 本地 Git 受管 worktree 全链路、删除闸门与记忆清理回归集中编排。 */
// 独立 Web 当前服务器本地 Git 受管 Worktree 全链路回归：
// 真实 git init + 真实 SQLite + createLocalServices / createManagedWorktreeService / createGitWorktreeRepo +
// ProjectRepository + HTTP alias 投影 + fake CLI worker；不启动浏览器、不访问网络。
//
// 运行：node packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-managed-worktree.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const temporary = await mkdtemp(join(tmpdir(), "zcode-standalone-worktree-"));

const ENV_KEYS = [
  "HOME",
  "ZCODE_DATA_DIR",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS",
  "ZCODE_CREDENTIAL_SECRET",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let servicesCollection;
let disabledCollection;
let db;

try {
  const shared = join(repoRoot, "packages/shared/src");
  const services = join(repoRoot, "packages/services/src");
  const cronerShim = join(temporary, "croner-shim.ts");
  const noopShim = join(temporary, "noop-shim.ts");
  await Promise.all([
    writeFile(
      cronerShim,
      `export class Cron { constructor(_expr: string) {} nextRun() { return null; } previousRuns() { return []; } }`,
    ),
    writeFile(
      noopShim,
      `export default {}; export const watch = () => ({ on: () => {}, close: async () => {} }); export const fetch = async () => { throw new Error("unexpected fetch"); }; export const Agent = class {}; export const ProxyAgent = class {}; export const WebSocket = class {}; export const parse = () => ({}); export const open = () => {}; export const ZipFile = class {}; export const Entry = {}; export const pki = {}; export const random = { getBytesSync: () => "" }; export const EntryClass = class {}; export const Client = class {};`,
    ),
  ]);

  const outfile = join(temporary, "worktree-bundle.cjs");
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
        `export { IProjectService, IZCodeAgentService, IZCodeTaskService, ITerminalService, IProviderSettingsService } from ${JSON.stringify(join(services, "index.ts"))};`,
        `export { IManagedWorktreeService } from ${JSON.stringify(join(services, "managed-worktree-tasks/index.ts"))};`,
        `export { createManagedWorktreeService, createWorktreeRemovalGate } from ${JSON.stringify(join(services, "managed-worktree-tasks/index.ts"))};`,
        `export { createGitWorktreeRepo } from ${JSON.stringify(join(services, "git/managed-worktree/index.ts"))};`,
        `export { createGitCommandProvider } from ${JSON.stringify(join(services, "git/providers/gitCommandProvider.ts"))};`,
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
    external: ["@napi-rs/keyring", "@napi-rs/keyring-*", "node-pty", "electron"],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(outfile).href) },
    logLevel: "silent",
    plugins: [
      {
        name: "source-only-worktree-fixture",
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

  const mod = require(outfile);
  const dataBaseDir = join(temporary, "data-base");
  const homeDir = join(temporary, "home");
  const standaloneWorkspaceRoot = join(temporary, "workspace");
  const repoDir = join(standaloneWorkspaceRoot, "demo-repo");
  const subDir = join(repoDir, "packages", "ui");
  await Promise.all([
    mkdir(dataBaseDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(subDir, { recursive: true }),
  ]);

  process.env.HOME = homeDir;
  process.env.ZCODE_DATA_DIR = dataBaseDir;
  process.env.ZCODE_DATA_BASE_DIR = dataBaseDir;
  process.env.ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS = "1";
  process.env.ZCODE_CREDENTIAL_SECRET = randomBytes(32).toString("hex");
  mod.setDataBaseDir(dataBaseDir);

  const git = (cwd, args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(repoDir, ["init"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test User"]);
  await writeFile(join(repoDir, "README.md"), "# Demo Repo\n");
  await writeFile(join(subDir, "index.ts"), "export const ui = 1;\n");
  await writeFile(join(repoDir, ".gitignore"), ".env\n");
  git(repoDir, ["add", "README.md", "packages/ui/index.ts", ".gitignore"]);
  git(repoDir, ["commit", "-m", "initial commit"]);

  const ownerHostId = mod.remoteHostIdFromWorkspaceIdentity(
    mod.buildServerRemoteWorkspaceIdentity({ serverId: "test", workspacePath: "/" }),
  );
  await mod.migrateApplicationStorage(undefined, ownerHostId);

  const aliasRepo = new mod.SourceServerWorkspaceAliasRepo();
  const sourceServerWorkspaceService = mod.createSourceServerWorkspaceService(aliasRepo, {
    defaultWorkspaceIdentity: (workspacePath) =>
      mod.buildServerRemoteWorkspaceIdentity({ serverId: "test", workspacePath }),
  });

  const workerLogFile = join(temporary, "cli-worker.ndjson");
  const releasePauseFile = join(temporary, "release-pause.flag");
  const releaseEnteredFile = join(temporary, "release-entered.flag");
  const purgeKeepFile = join(temporary, "purge-keep.flag");
  const cliStorageRoot = join(temporary, "cli-storage");
  await writeFile(workerLogFile, "");
  const workerPath = join(temporary, "fake-worktree-cli.mjs");
  await writeFile(
    workerPath,
    `
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
const logFile = process.argv[2];
const releasePauseFile = process.argv[3];
const releaseEnteredFile = process.argv[4];
const storageRoot = process.argv[5];
const purgeKeepFile = process.argv[6];
const createdSessions = new Map();
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
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { protocolName: "ZCode Protocol", protocolVersion: 1 } }) + "\\n");
      continue;
    }
    if (msg.method === "runtime/capabilities") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { worktreeCwd: true } }) + "\\n");
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
    if (msg.method === "v4/command") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
      const env = msg.params;
      if (env.type === "createSession") {
        createdSessions.set(env.payload.sessionId, env.payload.cwd || env.payload.workspaceId);
        process.stdout.write(JSON.stringify({
          id: msg.id,
          result: { status: "accepted", commandId: env.commandId, revisionAtDecision: 1, result: { type: "createSession", sessionId: env.payload.sessionId } },
        }) + "\\n");
        continue;
      }
      if (env.type === "forkAssistant") {
        createdSessions.set(env.payload.targetCwd.childSessionId, env.payload.targetCwd.cwd);
        process.stdout.write(JSON.stringify({
          id: msg.id,
          result: { status: "accepted", commandId: env.commandId, revisionAtDecision: 1, result: { type: "forkAssistant", sessionId: env.payload.targetCwd.childSessionId } },
        }) + "\\n");
        continue;
      }
      if (env.type === "sendText" && env.payload?.text === "trigger-browser-list") {
        // 模拟 CLI browser-control-broker：workspaceKey 为主项目，workspacePath 为 worktree cwd
        const sid = env.sessionId;
        const wtCwd = createdSessions.get(sid);
        process.stdout.write(JSON.stringify({
          id: \`browser-list-\${sid}\`,
          method: "interaction/browserList",
          params: {
            requestId: \`req-bl-\${sid}\`,
            sessionId: sid,
            workspaceKey: env.workspace?.workspaceKey || wtCwd,
            workspacePath: wtCwd,
            clientMode: "web-remote-replayable",
            sessionContext: "live",
          },
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          id: \`browser-exec-\${sid}\`,
          method: "interaction/browserExecute",
          params: {
            requestId: \`req-be-\${sid}\`,
            sessionId: sid,
            workspaceKey: env.workspace?.workspaceKey || wtCwd,
            workspacePath: wtCwd,
            clientMode: "web-remote-replayable",
            sessionContext: "live",
            command: { method: "list" },
          },
        }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ id: msg.id, result: { status: "accepted", commandId: env.commandId, revisionAtDecision: 1 } }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/deletionPreview") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
      const expectedDir = createdSessions.get(msg.params.sessionId);
      if (expectedDir && expectedDir !== msg.params.workspace.workspacePath) {
        process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32603, message: "session-data.identity-mismatch" } }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId,
          revision: "rev-1",
          sessionIds: [msg.params.sessionId],
          forks: [],
          retainedArtifacts: [],
          deletedFiles: 1,
          incomplete: false,
          completed: false,
        },
      }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/deletionExecute") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
      const expectedDir = createdSessions.get(msg.params.sessionId);
      if (expectedDir && expectedDir !== msg.params.workspace.workspacePath) {
        process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32603, message: "session-data.identity-mismatch" } }) + "\\n");
        continue;
      }
      createdSessions.delete(msg.params.sessionId);
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId,
          status: "deleted",
          sessionIds: [msg.params.sessionId],
          retainedArtifacts: 0,
        },
      }) + "\\n");
      continue;
    }
    if (msg.method === "v4/storage/sessionData/measure") {
      const sessions = msg.params.sessionIds.map((sessionId) => ({ sessionId, bytes: 0 }));
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
        if (purgeKeepFile && existsSync(purgeKeepFile)) {
          kept.push({ sessionId, reason: "running" });
        } else {
          createdSessions.delete(sessionId);
          deleted.push({ sessionId, bytes: 0 });
        }
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
    if (msg.method === "session/releaseUnderDirectory") {
      appendFileSync(logFile, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
      if (existsSync(releasePauseFile)) {
        writeFileSync(releaseEnteredFile, msg.params.directory);
        while (existsSync(releasePauseFile)) {
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      process.stdout.write(JSON.stringify({ id: msg.id, result: { released: [], busy: [] } }) + "\\n");
      continue;
    }
    if (msg.method === "v4/commands/query") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { results: [] } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");
  }
});
`,
  );

  // 读取 http.ts 的 createStandaloneProjectAlias 验证 HTTP host 别名投影行为
  const httpSource = await readFile(join(repoRoot, "packages/server/src/http.ts"), "utf8");
  const ast = ts.createSourceFile("http.ts", httpSource, ts.ScriptTarget.Latest, true);
  const aliasFns = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      (node.name?.text === "projectHost" || node.name?.text === "createStandaloneProjectAlias"),
  );
  assert.equal(aliasFns.length, 2);
  const { outputText } = ts.transpileModule(aliasFns.map((n) => n.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const createStandaloneProjectAlias = vm.runInNewContext(
    `${outputText}\ncreateStandaloneProjectAlias`,
  );

  const browserCalls = [];
  const browserCloseCalls = [];
  const spyBrowserControlExecutor = {
    list: async (input) => {
      browserCalls.push({
        op: "list",
        workspacePath: input.workspacePath,
        workspaceKey: input.workspaceKey,
        sessionId: input.sessionId,
      });
      return [];
    },
    execute: async (input) => {
      browserCalls.push({
        op: "execute",
        workspacePath: input.workspacePath,
        workspaceKey: input.workspaceKey,
        sessionId: input.sessionId,
      });
      return { ok: true, elapsedMs: 0 };
    },
    closeTaskSessions: async (params) => {
      browserCloseCalls.push(params);
    },
  };

  const cipher = await mod.createServerCredentialCipher({
    filePath: join(temporary, "credentials.json"),
    env: process.env,
  });
  servicesCollection = mod.createLocalServices({
    credentialCipherProvider: cipher,
    zcodeBuiltinProviderConfigFilePath: join(repoRoot, "config/provider/zcode-builtin.test.json"),
    serviceAuthorityMode: "standalone-server",
    projectStorageHostId: ownerHostId,
    sourceServerWorkspaceService,
    allowStandaloneCloudWorkspaces: true,
    standaloneWorkspaceRoot,
    allowStandaloneMultiRoot: true,
    browserControlExecutor: spyBrowserControlExecutor,
    zcodeAgentCommandResolver: () => ({
      command: process.execPath,
      args: [
        workerPath,
        workerLogFile,
        releasePauseFile,
        releaseEnteredFile,
        cliStorageRoot,
        purgeKeepFile,
      ],
    }),
  });

  const providerSettings = servicesCollection.get(mod.IProviderSettingsService);
  await providerSettings.createPersonalProvider({
    templateId: "zai-standard-api",
    providerName: "Worktree Test Provider",
    initialConfig: {
      access: { type: "api-key", apiKey: "sk-test-worktree" },
    },
  });

  const projectSvc = createStandaloneProjectAlias(
    servicesCollection.get(mod.IProjectService),
    ownerHostId,
  );
  const worktreeSvc = servicesCollection.get(mod.IManagedWorktreeService);
  const agentSvc = servicesCollection.get(mod.IZCodeAgentService);
  const taskSvc = servicesCollection.get(mod.IZCodeTaskService);

  const project = await projectSvc.saveProject({
    hostId: "local",
    name: "Standalone Git Worktree Project",
    roots: [repoDir, subDir],
    primaryRoot: repoDir,
  });
  assert.equal(project.hostId, "local");

  // (a) supportsWorktreeCwd 返回 true（携带 remote workspaceIdentity 时返回 false）
  assert.equal(
    await worktreeSvc.supportsWorktreeCwd({ workspacePath: repoDir }),
    true,
    "standalone 本地 Git 仓库应支持 worktree cwd",
  );
  assert.equal(
    await worktreeSvc.supportsWorktreeCwd({
      workspacePath: repoDir,
      workspaceIdentity: `remote:ssh:other:22:${repoDir}`,
    }),
    false,
    "携带远端 workspaceIdentity 时不支持 worktree cwd",
  );
  console.log("PASS (a) supportsWorktreeCwd 正常放行 standalone 本地仓库并拒绝远端身份");

  // (b) startNewTask 创建真实 linked git worktree（位于 <standaloneWorkspaceRoot>/.zcode/worktrees/...），
  //     预留任务、多 root 子目录映射进 worktree、下发 HOST_WORKTREE_COMMAND 并结算。
  const waitSettlement = (creationId) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`settlement timeout: ${creationId}`)),
        10_000,
      );
      const disp = worktreeSvc.onDidSettleCreation((event) => {
        if (event.creationId === creationId) {
          clearTimeout(timer);
          disp.dispose();
          resolve(event);
        }
      });
    });

  const cmdId1 = randomUUID();
  const startRes = await worktreeSvc.startNewTask({
    projectId: project.id,
    workspacePath: repoDir,
    ref: null,
    envelope: {
      wireVersion: 3,
      commandId: cmdId1,
      clientId: "web-client-1",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: repoDir,
        firstInput: { text: "hello worktree" },
      },
    },
  });
  assert.equal(startRes.ok, true, `startNewTask 应成功: ${JSON.stringify(startRes)}`);
  const settlement1 = await waitSettlement(startRes.creationId);
  assert.equal(settlement1.outcome, "session-started");
  assert.equal(
    settlement1.workspaceIdentity,
    undefined,
    "settlement 不得硬塞 remote workspaceIdentity",
  );

  const logEntries1 = (await readFile(workerLogFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const createCmd = logEntries1.find(
    (entry) => entry.method === "v4/command" && entry.params.commandId === cmdId1,
  );
  assert.ok(createCmd, "应下发 HOST_WORKTREE_COMMAND createSession");
  const wtCwd1 = createCmd.params.payload.cwd;
  assert.ok(
    wtCwd1.startsWith(join(standaloneWorkspaceRoot, ".zcode", "worktrees")),
    `worktree 必须创建在 <standaloneWorkspaceRoot>/.zcode/worktrees 下，实际: ${wtCwd1}`,
  );
  assert.equal(
    (await stat(join(wtCwd1, ".git"))).isFile(),
    true,
    "worktree .git 必须是 linked git 文件",
  );
  assert.deepEqual(
    createCmd.params.payload.additionalDirectories,
    [join(wtCwd1, "packages", "ui")],
    "多 root 子目录应映射进 worktree，不能指向主 checkout",
  );

  // 验证 SQLite tasks 行：workspace_identity 为 null、workspace_path 为主仓库、root_path 与 worktree_root 为 worktree 目录
  db = new DatabaseSync(join(mod.getAppConfigDir(), "tasks-index.sqlite"));
  const row1 = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(settlement1.sessionId);
  assert.equal(row1.host_id, ownerHostId);
  assert.equal(
    row1.workspace_identity,
    null,
    "standalone worktree 任务 workspace_identity 必须保持 null",
  );
  assert.equal(row1.workspace_path, repoDir);
  assert.equal(row1.root_path, wtCwd1);
  assert.equal(row1.worktree_root, wtCwd1);
  assert.deepEqual(JSON.parse(row1.execution_directories), [join(wtCwd1, "packages", "ui")]);

  // 经 HTTP alias 投影后的 resolveSessionDirectories 仍合法返回
  const resolvedDirs1 = await projectSvc.resolveSessionDirectories(
    { taskId: settlement1.sessionId, workspacePath: repoDir },
    "local",
  );
  assert.equal(resolvedDirs1.workspacePath, repoDir);
  assert.equal(resolvedDirs1.cwd, wtCwd1);
  assert.deepEqual(resolvedDirs1.additionalDirectories, [join(wtCwd1, "packages", "ui")]);
  console.log(
    "PASS (b) startNewTask 创建真实 worktree（.zcode/worktrees）、多 root 映射与任务落库",
  );

  // (c) forkToWorktree：在第一个 worktree 中写入未提交改动，分叉到独立新 worktree
  await writeFile(join(wtCwd1, "README.md"), "# Modified in WT1\n");
  await writeFile(join(wtCwd1, "UNTRACKED.txt"), "untracked file\n");
  const forkCmdId = randomUUID();
  const forkRes = await worktreeSvc.forkToWorktree({
    workspacePath: repoDir,
    envelope: {
      wireVersion: 3,
      commandId: forkCmdId,
      clientId: "web-client-1",
      sessionId: settlement1.sessionId,
      type: "forkAssistant",
      payload: {
        target: { rowId: 1, entityId: "msg-1" },
      },
    },
  });
  assert.equal(forkRes.ok, true, `forkToWorktree 应成功: ${JSON.stringify(forkRes)}`);
  const settlement2 = await waitSettlement(forkRes.creationId);
  assert.equal(settlement2.outcome, "session-started");

  const logEntries2 = (await readFile(workerLogFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const forkCmd = logEntries2.find(
    (entry) => entry.method === "v4/command" && entry.params.commandId === forkCmdId,
  );
  const wtCwd2 = forkCmd.params.payload.targetCwd.cwd;
  assert.notEqual(wtCwd2, wtCwd1, "fork 应创建独立新 worktree");
  assert.ok(wtCwd2.startsWith(join(standaloneWorkspaceRoot, ".zcode", "worktrees")));
  assert.equal(await readFile(join(wtCwd2, "README.md"), "utf8"), "# Modified in WT1\n");
  assert.equal(await readFile(join(wtCwd2, "UNTRACKED.txt"), "utf8"), "untracked file\n");
  console.log("PASS (c) forkToWorktree 在独立新 worktree 分叉并带入未提交改动");

  // (d) listWorktrees 状态、dirty 阻止、删除租约 worktreeRemovalGate 阻止、清理后 removeWorktree 成功
  const listed = await worktreeSvc.listWorktrees({ projectId: project.id });
  assert.equal(listed.groups.length, 1);
  assert.equal(listed.groups[0].worktrees.length, 2);
  const wt1Info = listed.groups[0].worktrees.find((w) => w.path === wtCwd1);
  const wt2Info = listed.groups[0].worktrees.find((w) => w.path === wtCwd2);
  assert.equal(wt1Info?.dirty, true);
  assert.equal(wt2Info?.dirty, true);
  assert.equal(wt1Info?.tasks[0]?.taskId, settlement1.sessionId);
  assert.equal(wt2Info?.tasks[0]?.taskId, settlement2.sessionId);

  // dirty 时 removeWorktree 拒绝 worktree-dirty
  const dirtyRemoval = await worktreeSvc.removeWorktree({ projectId: project.id, path: wtCwd1 });
  assert.equal(dirtyRemoval.ok, false);
  assert.equal(dirtyRemoval.error.code, "worktree-dirty");

  // 真实 node.ts worktreeRemovalGate 测试：removeWorktree 持有 wtCwd2 租约期间，
  // 不带 identity 与携带本服务器 canonical identity 向 settlement2 发消息均被拦截 worktree.removing；
  // 而主仓库普通任务与未删除的 wtCwd1 任务均不受影响！
  const mainTaskAck = await agentSvc.sendConversationCommandV4({
    workspacePath: repoDir,
    projectId: project.id,
    envelope: {
      wireVersion: 3,
      commandId: randomUUID(),
      clientId: "web-client-1",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: repoDir, firstInput: { text: "normal main task" } },
    },
  });
  assert.equal(mainTaskAck.status, "accepted");
  const mainTaskId = mainTaskAck.result.sessionId;
  const repoCanonicalIdentity = (
    await sourceServerWorkspaceService.resolveWorkspace({ workspacePath: repoDir })
  ).canonicalWorkspaceKey;

  // 清干净 wtCwd2 并挂起其 session/releaseUnderDirectory，使真实 removeWorktree 持租约阻塞
  await writeFile(join(wtCwd2, "README.md"), "# Demo Repo\n");
  await rm(join(wtCwd2, "UNTRACKED.txt"), { force: true });
  await writeFile(releasePauseFile, "1");
  const removeWt2Promise = worktreeSvc.removeWorktree({ projectId: project.id, path: wtCwd2 });
  const deadlineGate = Date.now() + 5_000;
  while (!existsSync(releaseEnteredFile) && Date.now() < deadlineGate) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(existsSync(releaseEnteredFile), true, "removeWorktree 必须进入真实删除租约阶段");

  await assert.rejects(
    agentSvc.sendConversationCommandV4({
      workspacePath: repoDir,
      envelope: {
        wireVersion: 3,
        commandId: randomUUID(),
        clientId: "web-client-1",
        sessionId: settlement2.sessionId,
        type: "sendText",
        payload: { text: "blocked no identity" },
      },
    }),
    { message: "worktree.removing" },
  );
  await assert.rejects(
    agentSvc.sendConversationCommandV4({
      workspacePath: repoDir,
      workspaceIdentity: repoCanonicalIdentity,
      envelope: {
        wireVersion: 3,
        commandId: randomUUID(),
        clientId: "web-client-1",
        sessionId: settlement2.sessionId,
        type: "sendText",
        payload: { text: "blocked with server canonical identity" },
      },
    }),
    { message: "worktree.removing" },
  );
  const okMainAck = await agentSvc.sendConversationCommandV4({
    workspacePath: repoDir,
    envelope: {
      wireVersion: 3,
      commandId: randomUUID(),
      clientId: "web-client-1",
      sessionId: mainTaskId,
      type: "sendText",
      payload: { text: "main unaffected" },
    },
  });
  assert.equal(okMainAck.status, "accepted", "主仓库普通任务在移除 wtCwd2 期间不受影响");
  const okWt1Ack = await agentSvc.sendConversationCommandV4({
    workspacePath: repoDir,
    envelope: {
      wireVersion: 3,
      commandId: randomUUID(),
      clientId: "web-client-1",
      sessionId: settlement1.sessionId,
      type: "sendText",
      payload: { text: "trigger-browser-list" },
    },
  });
  assert.equal(okWt1Ack.status, "accepted", "未在删除中的 wtCwd1 任务不受影响");
  // 等待反向 Browser Use 请求完成路由归一校验
  const browserDeadline = Date.now() + 3_000;
  while (
    !browserCalls.some((c) => c.op === "execute" && c.sessionId === settlement1.sessionId) &&
    Date.now() < browserDeadline
  ) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const wtBrowserList = browserCalls.find(
    (c) => c.op === "list" && c.sessionId === settlement1.sessionId,
  );
  const wtBrowserExec = browserCalls.find(
    (c) => c.op === "execute" && c.sessionId === settlement1.sessionId,
  );
  assert.equal(wtBrowserList?.workspacePath, repoDir, "worktree Browser Use list 应归一到主仓库");
  assert.equal(
    wtBrowserExec?.workspacePath,
    repoDir,
    "worktree Browser Use execute 应归一到主仓库",
  );

  // 放行并完成 wtCwd2 删除
  await rm(releasePauseFile, { force: true });
  const wt2Removal = await removeWt2Promise;
  assert.equal(wt2Removal.ok, true, `wtCwd2 放行后应成功删除: ${JSON.stringify(wt2Removal)}`);
  assert.equal(existsSync(wtCwd2), false);

  // 归档 worktree 任务永久删除测试（分别覆盖 wtCwd1 存在与 wtCwd2 已删除两种状态）
  await taskSvc.archiveTask({ taskId: settlement1.sessionId, workspacePath: repoDir });
  assert.ok(
    browserCloseCalls.some(
      (c) => c.workspacePath === repoDir && c.sessionIds.includes(settlement1.sessionId),
    ),
    "归档 worktree 任务应按主仓库 workspacePath 触发 closeTaskSessions",
  );
  await taskSvc.archiveTask({ taskId: settlement2.sessionId, workspacePath: repoDir });
  const prev1 = await taskSvc.previewArchivedTaskDeletion({
    taskId: settlement1.sessionId,
    workspacePath: repoDir,
  });
  assert.equal(prev1.blockedReason, undefined);
  const del1 = await taskSvc.permanentlyDeleteArchivedTask({
    taskId: settlement1.sessionId,
    workspacePath: repoDir,
    revision: prev1.revision,
    operationId: randomUUID(),
  });
  assert.equal(del1.status, "deleted", "wtCwd1 在磁盘时 worktree 归档任务应能永久删除");

  const prev2 = await taskSvc.previewArchivedTaskDeletion({
    taskId: settlement2.sessionId,
    workspacePath: repoDir,
  });
  assert.equal(prev2.blockedReason, undefined);
  const del2 = await taskSvc.permanentlyDeleteArchivedTask({
    taskId: settlement2.sessionId,
    workspacePath: repoDir,
    revision: prev2.revision,
    operationId: randomUUID(),
  });
  assert.equal(del2.status, "deleted", "wtCwd2 已从磁盘移除后 worktree 归档任务仍应能永久删除");
  const workerLogLines = (await readFile(workerLogFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const execWt1 = workerLogLines.find(
    (l) =>
      l.method === "v4/storage/sessionData/deletionExecute" &&
      l.params.sessionId === settlement1.sessionId,
  );
  const execWt2 = workerLogLines.find(
    (l) =>
      l.method === "v4/storage/sessionData/deletionExecute" &&
      l.params.sessionId === settlement2.sessionId,
  );
  assert.equal(execWt1?.params.workspace.workspacePath, wtCwd1);
  assert.equal(execWt2?.params.workspace.workspacePath, wtCwd2);

  // 还原 wtCwd1 的改动使其变干净并成功删除（此时保留了上面永久删除前已清空的任务引用，确保只剩干净删除）
  await writeFile(join(wtCwd1, "README.md"), "# Demo Repo\n");
  await rm(join(wtCwd1, "UNTRACKED.txt"), { force: true });
  const cleanRemoval = await worktreeSvc.removeWorktree({ projectId: project.id, path: wtCwd1 });
  assert.equal(cleanRemoval.ok, true, `干净 worktree 应成功删除: ${JSON.stringify(cleanRemoval)}`);
  assert.equal(existsSync(wtCwd1), false, "worktree 目录应从磁盘删除");
  assert.equal(existsSync(dirname(wtCwd1)), false, "空 bucket 目录应一并删除");
  assert.equal(
    await worktreeSvc.isWorktreeAvailable({ worktreeRoot: wtCwd1 }),
    false,
    "删除后 isWorktreeAvailable 应返回 false",
  );
  const logAfterRemove = await readFile(workerLogFile, "utf8");
  assert.match(logAfterRemove, /session\/releaseUnderDirectory/, "删除前应请求 CLI 卸载目录内会话");

  // 独立 Web 双记忆命名空间（本地路径哈希 <slug>-<hash> 与 canonical project-<hash>）估算与清理验证
  const memDir = (workspacePath, workspaceIdentity) => {
    const id = workspaceIdentity?.trim();
    const key = id || workspacePath;
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const slug = id ? "project" : workspacePath.split("/").pop() || "project";
    return join(cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
  };
  const localMemFile = join(memDir(repoDir, undefined), "MEMORY.md");
  const canonicalMemFile = join(memDir(repoDir, repoCanonicalIdentity), "MEMORY.md");
  await mkdir(dirname(localMemFile), { recursive: true });
  await mkdir(dirname(canonicalMemFile), { recursive: true });
  await writeFile(localMemFile, "local-path-memory-1"); // 19B
  await writeFile(canonicalMemFile, "canonical-memory-22"); // 19B
  const dualMeasure = await projectSvc.measureProjectData([project.id], "local");
  assert.equal(
    dualMeasure.projects[0].memoryBytes,
    38,
    "measureProjectData 必须同时累加本地路径哈希记忆与 canonical 记忆",
  );
  // 若项目被软删除但仍有新 worktree 任务存活，删数据不应清理主目录双命名空间记忆；先建一个存活 worktree 测保护再彻底清理
  const guardWt = await worktreeSvc.startNewTask({
    projectId: project.id,
    workspacePath: repoDir,
    ref: null,
    envelope: {
      wireVersion: 3,
      commandId: randomUUID(),
      clientId: "web-client-1",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: repoDir, firstInput: { text: "living worktree task" } },
    },
  });
  assert.equal(guardWt.ok, true);
  const guardSettlement = await waitSettlement(guardWt.creationId);
  // 先模拟仍有存活 worktree 会话（kept: running）：主目录双记忆命名空间都必须受保护不被删
  await projectSvc.deleteProject(project.id, "local");
  await writeFile(purgeKeepFile, "1");
  const guardedDelete = await projectSvc.deleteProjectData(project.id, "local");
  assert.equal(guardedDelete.runningSessions, 2);
  assert.equal(await readFile(localMemFile, "utf8"), "local-path-memory-1");
  assert.equal(await readFile(canonicalMemFile, "utf8"), "canonical-memory-22");
  await rm(purgeKeepFile, { force: true });

  // 会话空闲后再次彻底清理：两个记忆命名空间均应被彻底删除
  const dualDelete = await projectSvc.deleteProjectData(project.id, "local");
  assert.equal(dualDelete.failed, 0);
  await assert.rejects(stat(localMemFile), { code: "ENOENT" });
  await assert.rejects(stat(canonicalMemFile), { code: "ENOENT" });
  // 恢复已删空项目后清理残留的 guardSettlement worktree 目录
  const cleanupProj = await projectSvc.saveProject({
    hostId: "local",
    name: "Cleanup",
    roots: [repoDir],
  });
  const cleanupList = await worktreeSvc.listWorktrees({ projectId: cleanupProj.id });
  for (const wt of cleanupList.groups[0]?.worktrees ?? []) {
    await worktreeSvc.removeWorktree({ projectId: cleanupProj.id, path: wt.path, force: true });
  }
  void guardSettlement;
  console.log(
    "PASS (d) listWorktrees、dirty/真实租约阻断、Browser Use 归属、worktree 永久删除与双命名空间记忆清理",
  );

  // (e) 未开启 standalone 开关或携带远端 workspaceIdentity 严格报 worktree.local-only；
  //     并且校验 http.ts 在非 desktop-continuous 且未开 ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS 时拦截。
  disabledCollection = mod.createLocalServices({
    credentialCipherProvider: cipher,
    zcodeBuiltinProviderConfigFilePath: join(repoRoot, "config/provider/zcode-builtin.test.json"),
    serviceAuthorityMode: "standalone-server",
    projectStorageHostId: ownerHostId,
    sourceServerWorkspaceService,
    allowStandaloneCloudWorkspaces: false,
    standaloneWorkspaceRoot,
  });
  const disabledWorktreeSvc = disabledCollection.get(mod.IManagedWorktreeService);
  assert.equal(await disabledWorktreeSvc.supportsWorktreeCwd({ workspacePath: repoDir }), false);
  await assert.rejects(disabledWorktreeSvc.listWorktrees({ projectId: project.id }), {
    message: "worktree.local-only",
  });
  const remoteIdentityStart = await worktreeSvc.startNewTask({
    projectId: project.id,
    workspacePath: repoDir,
    workspaceIdentity: `remote:ssh:foreign:22:${repoDir}`,
    ref: null,
    envelope: {
      wireVersion: 3,
      commandId: randomUUID(),
      clientId: "web-client-1",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: repoDir, firstInput: { text: "bad" } },
    },
  });
  assert.equal(remoteIdentityStart.ok, false);
  assert.equal(remoteIdentityStart.error.code, "local-only");
  assert.match(
    httpSource,
    /ZCODE_STANDALONE_WEB_LOCAL_HOST_ALIAS !== "1"[\s\S]*IManagedWorktreeService\.channelName/,
    "http.ts 必须在未开启独立 Web 兼容的非桌面连接上禁用 IManagedWorktreeService",
  );
  console.log("PASS (e) 未开启开关与远端 workspaceIdentity 严格拒绝 worktree.local-only");

  // 关闭服务
  db.close();
  db = undefined;
  await mod.disposeServiceResourcesAndWait(servicesCollection);
  servicesCollection = undefined;
  await mod.disposeServiceResourcesAndWait(disabledCollection);
  disabledCollection = undefined;
  console.log("\nstandalone-managed-worktree 全部验收通过");
} finally {
  db?.close();
  if (servicesCollection) {
    const { disposeServiceResourcesAndWait } = await import(
      pathToFileURL(join(temporary, "worktree-bundle.cjs")).href
    ).catch(() => ({}));
    await disposeServiceResourcesAndWait?.(servicesCollection).catch(() => {});
  }
  if (disabledCollection) {
    const { disposeServiceResourcesAndWait } = await import(
      pathToFileURL(join(temporary, "worktree-bundle.cjs")).href
    ).catch(() => ({}));
    await disposeServiceResourcesAndWait?.(disabledCollection).catch(() => {});
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => setTimeout(r, 60));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
