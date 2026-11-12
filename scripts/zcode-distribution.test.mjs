import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  officialPluginStagingTargets,
  patchNodePtyPrebuilds,
  stageBundledSkillAssets,
  stageOfficialPluginAssets,
  stagePluginNativeRuntimeDependencies,
} from "./zcode-distribution/assets.mjs";
import { installScriptSource } from "./zcode-distribution/installer.mjs";

const exec = promisify(execFile);
const runnerSource = new URL("./zcode-distribution/runner.mjs", import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const cliRoot = resolve(repoRoot, "apps/zcode-cli");
const cliPackagesRoot = resolve(cliRoot, "packages");

async function stageRoot(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-builtin-assets-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = join(directory, "zcode");
  await mkdir(packageRoot, { recursive: true });
  return packageRoot;
}

async function assertSameFile(stagedFile, sourceFile) {
  assert.deepEqual(await readFile(stagedFile), await readFile(sourceFile), stagedFile);
}

// 递归找出不应出现的目录名，验证内置资产不是靠整份 node_modules 拷贝来的。
async function findDirectories(rootPath, name) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(current, entry.name);
      if (entry.name === name) {
        found.push(child);
        continue;
      }
      await visit(child);
    }
  }
  await visit(rootPath);
  return found;
}

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-distribution-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "zcode");
  for (const name of ["bin", "agent", "web", "server"]) {
    await mkdir(join(root, name), { recursive: true });
  }
  await cp(runnerSource, join(root, "bin/zcode.mjs"));
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.2.3" }));
  await writeFile(
    join(root, "agent/zcode.cjs"),
    `
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), entry: process.argv[1], cwd: process.cwd() }));
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);
`,
  );
  await writeFile(
    join(root, "server/entry-http.js"),
    `
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.FIXTURE_WEB_RESULT, JSON.stringify({
  cwd: process.cwd(), port: process.env.PORT, host: process.env.ZCODE_SERVER_HOST,
  workspace: process.env.ZCODE_SERVER_WORKSPACE, staticRoot: process.env.ZCODE_WEB_STATIC_ROOT,
  command: process.env.ZCODE_AGENT_SERVER_COMMAND, args: JSON.parse(process.env.ZCODE_AGENT_SERVER_ARGS_JSON),
  token: process.env.ZCODE_SERVER_AUTH_TOKEN,
}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  return { directory, root, runner: join(root, "bin/zcode.mjs") };
}

test("default launch and CLI arguments reuse the Agent entry without starting Web", async (t) => {
  const { runner, root, directory } = await fixture(t);
  for (const args of [[], ["tui"], ["--prompt", "--web"], ["app-server", "--stdio"]]) {
    const result = await exec(process.execPath, [runner, ...args], { cwd: directory });
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: args,
      entry: join(root, "agent/zcode.cjs"),
      cwd: directory,
    });
  }
  await assert.rejects(
    exec(process.execPath, [runner], { env: { ...process.env, FIXTURE_EXIT_CODE: "17" } }),
    (error) => error.code === 17,
  );
});

test("help exposes Web mode and preserves CLI help; version uses the distribution", async (t) => {
  const { runner } = await fixture(t);
  assert.equal((await exec(process.execPath, [runner, "--version"])).stdout.trim(), "1.2.3");
  const help = (await exec(process.execPath, [runner, "--help"])).stdout;
  assert.match(help, /zcode --web/);
  assert.match(help, /"argv":\["--help"\]/);
  const webHelp = (await exec(process.execPath, [runner, "--web", "--help"])).stdout;
  assert.match(webHelp, /--workspace/);
  assert.doesNotMatch(webHelp, /"argv"/);
  await assert.rejects(exec(process.execPath, [runner, "--web", "--unknown"]), /Unknown option/);
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--port", "NaN"]),
    /--port must be an integer/,
  );
});

test("Web startup errors preserve a failing exit code", async (t) => {
  const { runner, directory, root } = await fixture(t);
  await assert.rejects(
    exec(process.execPath, [
      runner,
      "--web",
      "--workspace",
      join(directory, "missing"),
      "--no-open",
    ]),
    /Unable to start Web server/,
  );
  await rm(join(root, "server/entry-http.js"));
  await assert.rejects(
    exec(process.execPath, [runner, "--web", "--no-open"]),
    /Missing runtime file/,
  );
});

test("Web mode passes its runtime configuration and terminates its child on shutdown", async (t) => {
  const { directory, runner, root } = await fixture(t);
  const resultPath = join(directory, "web-result.json");
  const child = spawn(
    process.execPath,
    [
      runner,
      "--web",
      "--workspace",
      directory,
      "--host",
      "127.0.0.1",
      "--port",
      "3041",
      "--no-open",
      "--no-token",
    ],
    {
      env: {
        ...process.env,
        FIXTURE_WEB_RESULT: resultPath,
        ZCODE_SERVER_AUTH_TOKEN: "stale-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await readFile(resultPath, "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (result) break;
    await setTimeout(20);
  }
  assert.deepEqual(result, {
    cwd: directory,
    port: "3041",
    host: "127.0.0.1",
    workspace: directory,
    staticRoot: join(root, "web"),
    command: process.execPath,
    args: [join(root, "agent/zcode.cjs"), "app-server", "--stdio"],
    token: "",
  });
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});

test("installer creates zcode and the installed command defaults to CLI", async (t) => {
  const { directory, root } = await fixture(t);
  const downloads = join(directory, "downloads");
  const releaseDir = join(downloads, "releases/1.2.3");
  await mkdir(releaseDir, { recursive: true });
  await exec("tar", ["-czf", join(releaseDir, "zcode-1.2.3.tar.gz"), "-C", directory, "zcode"]);
  await writeFile(
    join(downloads, "latest.json"),
    JSON.stringify({ version: "1.2.3", tarball: "zcode-1.2.3.tar.gz" }),
  );
  const installer = join(directory, "install.sh");
  await writeFile(installer, installScriptSource(`file://${downloads}/`));
  const installRoot = join(directory, "installed");
  const bin = join(directory, "bin");
  await exec("sh", [installer], {
    env: {
      ...process.env,
      ZCODE_DIST_BASE_URL: `file://${downloads}/`,
      ZCODE_DIST_HOME: installRoot,
      ZCODE_DIST_BIN_DIR: bin,
    },
  });
  await rm(root, { recursive: true });
  const result = await exec(join(bin, "zcode"), [], { cwd: directory });
  assert.deepEqual(JSON.parse(result.stdout).argv, []);
  const webHelp = await exec(join(bin, "zcode"), ["--web", "--help"]);
  assert.match(webHelp.stdout, /zcode --web/);
});

test("node-pty prebuild patch keeps the official native that matches the official JS", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zcode-distribution-pty-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prebuilds = join(directory, "node_modules/node-pty/prebuilds");
  await mkdir(join(prebuilds, "darwin-arm64"), { recursive: true });
  await writeFile(join(prebuilds, "darwin-arm64/pty.node"), "official-1.1.0");
  await patchNodePtyPrebuilds(directory);
  // Bug 回归：旧补丁用平台包 1.2.0-beta.10 的 darwin native 覆盖官方 1.1.0 native，
  // 官方 JS 只传 3 个 resize 参数，新 native 要 5 个，macOS 终端 resize 必然失败。
  assert.equal(await readFile(join(prebuilds, "darwin-arm64/pty.node"), "utf8"), "official-1.1.0");
  // 官方包缺失的平台仍由平台包补齐。
  assert.ok((await readFile(join(prebuilds, "linux-x64/pty.node"))).length > 0);
});

// 内置技能包不进市场、没有版本身份，bootstrap 在 agent/zcode.cjs 旁按 packages/bundled-skills
// 原地读取；漏 stage 会让 Node 发行包的 /workflow 展开后加载不到技能。
test("bundled skill pack is staged next to the agent entry", async (t) => {
  const packageRoot = await stageRoot(t);
  await stageBundledSkillAssets(packageRoot);
  const stagedRoot = join(packageRoot, "agent/packages/bundled-skills");
  for (const relativePath of [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
  ]) {
    await assertSameFile(
      join(stagedRoot, ...relativePath.split("/")),
      join(cliPackagesRoot, "bundled-skills", ...relativePath.split("/")),
    );
  }
  // 重复 stage 必须清理上一轮残留，避免发行包带上已删除的技能文件。
  const stale = join(stagedRoot, "skills/dynamic-workflows/stale.md");
  await writeFile(stale, "stale");
  await stageBundledSkillAssets(packageRoot);
  assert.equal(await stat(stale).catch(() => null), null);
});

// 官方插件的期望清单只能来自 SEA 采集器；这里验证 stage 出的目录布局就是 bootstrap
// filesystem seed 的 rootCandidates（agent/packages/<x>-plugin），且不带插件 node_modules。
test("official plugin assets are staged under agent/packages from the SEA list", async (t) => {
  const packageRoot = await stageRoot(t);
  const stagedNames = await stageOfficialPluginAssets(packageRoot, { requireRuntime: false });
  const targets = officialPluginStagingTargets();
  assert.deepEqual(stagedNames.toSorted(), targets.map((target) => target.name).toSorted());

  for (const target of targets) {
    assert.match(target.directory, /^packages\//u);
    const pluginRoot = join(packageRoot, "agent", target.directory);
    assert.ok((await stat(join(pluginRoot, ".zcode-plugin/plugin.json"))).isFile(), target.name);
    for (const relativePath of target.requiredSeedPaths) {
      assert.ok(
        (await stat(join(pluginRoot, ...relativePath.split("/"))).catch(() => null))?.isFile(),
        `${target.name} missing seed asset ${relativePath}`,
      );
    }
    assert.deepEqual(await findDirectories(pluginRoot, "node_modules"), []);
  }

  await assertSameFile(
    join(packageRoot, "agent/packages/visualize-plugin/skills/visualize/SKILL.md"),
    join(cliPackagesRoot, "visualize-plugin/skills/visualize/SKILL.md"),
  );
});

// 插件 native 依赖（sharp/koffi）只按 desktop 的官方 producer 门禁 stage：当前仓库的
// @zcode/zcode-cua 不声明 sharp，因此必须整体跳过，且绝不在插件目录里塞 node_modules。
test("plugin native dependency staging follows the official producer gate", async (t) => {
  const packageRoot = await stageRoot(t);
  await stageOfficialPluginAssets(packageRoot, { requireRuntime: false });
  const staged = await stagePluginNativeRuntimeDependencies(packageRoot);
  const pluginRoots = officialPluginStagingTargets().map((target) =>
    join(packageRoot, "agent", target.directory),
  );
  const declaredByComputerUse = await readFile(
    join(repoRoot, "packages/zcode-cua/package.json"),
    "utf8",
  )
    .then(JSON.parse)
    .then((manifest) =>
      ["dependencies", "optionalDependencies", "peerDependencies"].some(
        (field) => typeof manifest[field]?.sharp === "string",
      ),
    )
    .catch(() => false);
  if (declaredByComputerUse) {
    assert.ok(staged.length > 0, "sharp-declaring Computer Use SDK must stage native deps");
  } else {
    assert.deepEqual(staged, []);
    for (const pluginRoot of pluginRoots) {
      assert.equal(
        await stat(join(pluginRoot, "node_modules")).catch(() => null),
        null,
        pluginRoot,
      );
    }
  }
});

// 运行时插件缺少 producer 产物时必须让发行包构建失败，而不是归档一个启动即坏的插件。
// 期望值直接取仓库里 producer 产物的真实状态，因此「缺 dist 报错」与「已构建则通过」两种状态都被覆盖。
test("official plugin runtime gate matches the producer state", async (t) => {
  const packageRoot = await stageRoot(t);
  const runtimesMissing = [];
  for (const target of officialPluginStagingTargets()) {
    for (const relativePath of target.requiredRuntimePaths) {
      // target.directory 已经是相对 apps/zcode-cli 的 packages/<x>-plugin。
      const runtime = join(cliRoot, target.directory, ...relativePath.split("/"));
      if (!(await stat(runtime).catch(() => null))?.isFile()) {
        runtimesMissing.push(`${target.name}/${relativePath}`);
      }
    }
  }
  if (runtimesMissing.length > 0) {
    await assert.rejects(
      () => stageOfficialPluginAssets(packageRoot),
      /Missing .*(MCP runtime|runtime asset)/u,
    );
    return;
  }
  await stageOfficialPluginAssets(packageRoot);
  for (const target of officialPluginStagingTargets()) {
    for (const relativePath of target.requiredRuntimePaths) {
      assert.ok(
        (
          await stat(join(packageRoot, "agent", target.directory, ...relativePath.split("/")))
        ).isFile(),
        `${target.name} runtime ${relativePath}`,
      );
    }
  }
});
