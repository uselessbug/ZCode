import { chmod, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import {
  bundledSkillPackRootPath,
  bundledSkillPackSkillsDirectory,
  collectSeaBundledSkillAssets,
  seaBundledSkillAssetPrefix,
} from "../../apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
  seaOfficialPluginAssetPrefix,
} from "../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import {
  collectSeaTuiAssets,
  seaTuiAssetPrefix,
} from "../../apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
import { supportedTargets } from "../../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";
import { stageKoffiIntoBundledAgents } from "../../packages/desktop/scripts/koffi-package-assets.mjs";
import {
  isSharpRequiredByComputerUse,
  stageSharpIntoBundledAgents,
} from "../../packages/desktop/scripts/sharp-package-assets.mjs";
const root = resolve(import.meta.dirname, "../..");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const cliRoot = resolve(root, "apps/zcode-cli");
// 与 bootstrap/src/app/bundled-plugins.ts 的 candidateBaseDirs 一致：Node 发行包在
// agent/zcode.cjs 旁查找内置资产，因此统一 stage 到 <packageRoot>/agent/packages/*。
const agentRoot = (packageRoot) => resolve(packageRoot, "agent");

// 官方插件清单与文件枚举的唯一事实源是 CLI 的 SEA 采集器。这里只把清单自带的 rootPath
// 映射成发行包内的相对目录（repo 里是 packages/<x>-plugin，发行包里是 agent/packages/<x>-plugin），
// 不新增插件或文件白名单；CUA 与 SEA 一样不在此集合内。
// 同时带出发布校验所需的必需资产路径，供发行包静态验收与 SEA 采集器共用同一份清单。
export const officialPluginStagingTargets = () =>
  officialSeaPlugins.map((plugin) => ({
    directory: plugin.rootPath,
    name: plugin.name,
    packageName: plugin.packageName,
    requiredRuntimePaths:
      plugin.requiresRuntime === false
        ? []
        : (plugin.requiredRuntimePaths ?? ["dist/mcp/server.js"]),
    requiredSeedPaths: plugin.requiredSeedPaths ?? [],
    requiresRuntime: plugin.requiresRuntime !== false,
    version: plugin.version,
  }));

const runtimePackageNames = [
  "@hono/node-server",
  "@hono/node-ws",
  "ssh2",
  "node-pty",
  // HTTP server 与 Agent CLI 均外置 @napi-rs/keyring，发行包需携带主体及平台原生二进制。
  "@napi-rs/keyring",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "follow-redirects",
  "proxy-from-env",
  "ws",
  "hono",
  "yaml",
  "yazl",
  // HTTP bundle 将 yauzl 外置；发行包必须携带它，否则脱离仓库就无法启动后端。
  "yauzl",
  "node-forge",
];

export async function stageTuiRuntime(packageRoot) {
  const stagingDirectory = resolve(packageRoot, "../tui-staging");
  const copied = new Map();
  try {
    for (const target of supportedTargets) {
      const { assets, manifest } = await collectSeaTuiAssets({
        root: resolve(root, "apps/zcode-cli"),
        stagingDirectory,
        target,
      });
      for (const file of manifest.files) {
        const previous = copied.get(file.path);
        if (previous) {
          if (previous !== file.sha256)
            throw new Error(`Conflicting TUI asset: ${file.path} (${target})`);
          continue;
        }
        const destination = resolve(packageRoot, "agent", file.path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(assets[`${seaTuiAssetPrefix}${file.path}`], destination);
        await chmod(destination, file.mode);
        copied.set(file.path, file.sha256);
      }
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

// 内置官方插件：复用 SEA 采集器的官方清单与枚举输出，按 bootstrap 的 filesystem seed 期望
// 把每个插件落到 <agent>/packages/<x>-plugin。requireRuntime 默认开启，缺 dist/mcp/server.js
// 直接让发行包构建失败（与 SEA 的 producer 门禁一致），而不是发一个没有运行时的插件。
export async function stageOfficialPluginAssets(packageRoot, { requireRuntime = true } = {}) {
  const stagingDirectory = resolve(packageRoot, "../official-plugin-staging");
  const targetByName = new Map(
    officialPluginStagingTargets().map((target) => [target.name, target]),
  );
  try {
    const { assets, manifest } = await collectSeaOfficialPluginAssets({
      requireRuntime,
      root: cliRoot,
      stagingDirectory,
    });
    for (const plugin of manifest.plugins) {
      const target = targetByName.get(plugin.name);
      if (!target) {
        throw new Error(`Unknown official plugin in SEA asset manifest: ${plugin.name}`);
      }
      const pluginTarget = resolve(agentRoot(packageRoot), target.directory);
      // 重新构建不累积上一轮的残留文件；插件目录是本次采集内容的完整快照。
      await rm(pluginTarget, { force: true, recursive: true });
      for (const file of plugin.files) {
        const assetKey = `${seaOfficialPluginAssetPrefix}${plugin.marketplace}/${plugin.name}/${plugin.version}/${file.path}`;
        const source = assets[assetKey];
        if (!source) {
          throw new Error(`Missing official plugin asset for ${plugin.name}: ${file.path}`);
        }
        const destination = resolve(pluginTarget, ...file.path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination);
        await chmod(destination, file.mode);
      }
      await assertStagedFile(
        resolve(pluginTarget, ".zcode-plugin", "plugin.json"),
        `${plugin.name} staged plugin manifest in ${packageRoot}`,
      );
      for (const runtimePath of requireRuntime ? target.requiredRuntimePaths : []) {
        await assertStagedFile(
          resolve(pluginTarget, ...runtimePath.split("/")),
          `${plugin.name} staged runtime in ${packageRoot}`,
        );
      }
    }
    return manifest.plugins.map((plugin) => plugin.name);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

// 随 CLI 内置的技能包（不是插件）：与官方插件同路，落到 <agent>/packages/bundled-skills，
// bootstrap 的 resolveBundledSkillRoots 在入口旁原地读取。缺任一必需文件同样中止构建。
export async function stageBundledSkillAssets(packageRoot) {
  const stagingDirectory = resolve(packageRoot, "../bundled-skills-staging");
  try {
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: cliRoot,
      stagingDirectory,
    });
    const targetRoot = resolve(agentRoot(packageRoot), bundledSkillPackRootPath);
    await rm(targetRoot, { force: true, recursive: true });
    for (const file of manifest.files) {
      const source = assets[`${seaBundledSkillAssetPrefix}${file.path}`];
      if (!source) {
        throw new Error(`Missing bundled skill asset: ${file.path}`);
      }
      const destination = resolve(targetRoot, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
      await chmod(destination, file.mode);
    }
    await assertStagedDirectory(
      resolve(targetRoot, bundledSkillPackSkillsDirectory),
      `bundled skill pack in ${packageRoot}`,
    );
    return manifest.files.map((file) => file.path);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

// desktop prepare-agent-node-bundle 的 native staging 目标：这些插件的 runtime 把 native
// 依赖（sharp / koffi）外部化，脱离仓库运行时要按目标平台补 native closure。
// 是否真的需要由 desktop 的官方 producer 门禁决定（当前仓库的 @zcode/zcode-cua 不声明 sharp，
// 所以正常跳过）；落点与本次已 stage 的官方插件目录求交集，CUA 未在集合内时 koffi 无落点，
// 不在这里新增插件白名单，也不整份拷贝 node_modules。
const pluginNativeStagingTargets = [
  { directory: "packages/node-repl-host", kind: "sharp" },
  { directory: "packages/browser-use-plugin", kind: "sharp" },
  { directory: "packages/zcode-cua-plugin", kind: "sharp" },
  { directory: "packages/zcode-cua-plugin", kind: "koffi" },
];

export async function stagePluginNativeRuntimeDependencies(packageRoot) {
  const desktopPackageRoot = resolve(root, "packages", "desktop");
  if (!isSharpRequiredByComputerUse({ desktopPackageRoot })) {
    console.log(
      "[zcode] Computer Use SDK does not declare sharp; skipping plugin native dependency staging",
    );
    return [];
  }
  const packagesDir = resolve(agentRoot(packageRoot), "packages");
  const stagedDirectories = new Set(await readdir(packagesDir).catch(() => []));
  // 发行包与构建机同平台消费（Docker 在镜像内构建并运行同一套 tar），因此按宿主平台补 native。
  const targetPlatform = { arch: process.arch, os: process.platform };
  const staged = [];
  for (const target of pluginNativeStagingTargets) {
    const name = target.directory.slice("packages/".length);
    if (!stagedDirectories.has(name)) continue;
    const glmDir = resolve(packagesDir, name);
    if (target.kind === "sharp") {
      staged.push(...stageSharpIntoBundledAgents({ desktopPackageRoot, glmDir, targetPlatform }));
      continue;
    }
    staged.push(
      ...stageKoffiIntoBundledAgents({
        glmDir,
        koffiPackageRoot: resolve(cliRoot, "packages", "adapters"),
        targetPlatform,
      }),
    );
  }
  return staged;
}

async function assertStagedFile(file, label) {
  const fileStat = await stat(file).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`Missing ${label}: ${file}`);
  }
}

async function assertStagedDirectory(directory, label) {
  const directoryStat = await stat(directory).catch(() => null);
  if (!directoryStat?.isDirectory()) {
    throw new Error(`Missing ${label}: ${directory}`);
  }
}

const lydellNodePtyPackages = [
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-darwin-x64",
  "@lydell/node-pty-linux-arm64",
  "@lydell/node-pty-linux-x64",
];

function shouldCopyPackagePath(packageDirectory, source) {
  const rel = relative(packageDirectory, source);
  if (!rel) {
    return true;
  }
  const parts = rel.split(sep);
  return !parts.includes("node_modules") && !parts.includes(".git");
}

async function resolvePackageJsonPath(requireFrom, packageName) {
  try {
    return requireFrom.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw error;
    }
    let current = dirname(requireFrom.resolve(packageName));
    for (;;) {
      const candidate = resolve(current, "package.json");
      if (await pathExists(candidate)) {
        try {
          const packageJson = await readJson(candidate);
          if (packageJson.name === packageName) {
            return candidate;
          }
        } catch {
          // Keep walking; malformed nested metadata should not pick the package root.
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function copyRuntimePackageTree({ packageName, packageRoot, requireFrom, seen }) {
  if (seen.has(packageName)) {
    return;
  }
  seen.add(packageName);

  let packageJsonPath;
  try {
    packageJsonPath = await resolvePackageJsonPath(requireFrom, packageName);
  } catch (error) {
    throw new Error(`Unable to resolve runtime package ${packageName}`, {
      cause: error,
    });
  }

  const packageDirectory = dirname(packageJsonPath);
  const destination = resolve(packageRoot, "node_modules", ...packageName.split("/"));
  await mkdir(dirname(destination), {
    recursive: true,
  });
  await cp(packageDirectory, destination, {
    dereference: true,
    force: true,
    recursive: true,
    filter: (source) => shouldCopyPackagePath(packageDirectory, source),
  });

  const packageJson = await readJson(packageJsonPath);
  const requireFromPackage = createRequire(packageJsonPath);
  const dependencies = Object.assign(
    {},
    packageJson.dependencies,
    packageJson.optionalDependencies,
  );
  for (const dependencyName of Object.keys(dependencies)) {
    try {
      await copyRuntimePackageTree({
        packageName: dependencyName,
        packageRoot,
        requireFrom: requireFromPackage,
        seen,
      });
    } catch (error) {
      if (!Object.hasOwn(packageJson.optionalDependencies ?? {}, dependencyName)) {
        throw error;
      }
      console.warn(`[zcode] optional package ${dependencyName} is unavailable; skipping`);
    }
  }
}

export async function copyRuntimeNodeModules(packageRoot) {
  const requireFromServer = createRequire(resolve(root, "packages", "server", "package.json"));
  const seen = new Set();
  for (const packageName of runtimePackageNames) {
    await copyRuntimePackageTree({
      packageName,
      packageRoot,
      requireFrom: requireFromServer,
      seen,
    });
  }
  // CLI 的浏览器运行时同样是外部依赖，不能依赖开发仓库的 hoisted node_modules。
  await copyRuntimePackageTree({
    packageName: "playwright-core",
    packageRoot: resolve(packageRoot, "agent"),
    requireFrom: createRequire(resolve(root, "apps/zcode-cli/packages/cli/package.json")),
    seen: new Set(),
  });
}

export async function patchNodePtyPrebuilds(packageRoot) {
  const requireFromServer = createRequire(resolve(root, "packages", "server", "package.json"));
  const nodePtyPrebuildRoot = resolve(packageRoot, "node_modules", "node-pty", "prebuilds");

  for (const packageName of lydellNodePtyPackages) {
    let packageJsonPath;
    try {
      packageJsonPath = await resolvePackageJsonPath(requireFromServer, packageName);
    } catch {
      console.warn(`[zcode] ${packageName} is unavailable; skipping node-pty prebuild patch`);
      continue;
    }
    const sourcePrebuildRoot = resolve(dirname(packageJsonPath), "prebuilds");
    const sourceStat = await stat(sourcePrebuildRoot).catch(() => null);
    if (!sourceStat?.isDirectory()) {
      continue;
    }
    for (const platformKey of await readdir(sourcePrebuildRoot)) {
      const targetPrebuildDir = resolve(nodePtyPrebuildRoot, platformKey);
      // Bug 原因：平台包是 1.2.0-beta.10（resize 要 5 个参数），旧逻辑整目录 force 覆盖，
      // 把官方 node-pty 自带的同版本 darwin native 换掉，官方 JS 只传 3 个参数，macOS 终端
      // resize 必然失败。官方包已自带的平台 prebuild 与其 JS 同版本，不能被覆盖；
      // 平台包只补官方包缺失的平台。
      if (await pathExists(targetPrebuildDir)) {
        continue;
      }
      await cp(resolve(sourcePrebuildRoot, platformKey), targetPrebuildDir, {
        dereference: true,
        recursive: true,
      });
    }
  }

  for (const helper of [
    resolve(nodePtyPrebuildRoot, "darwin-arm64", "spawn-helper"),
    resolve(nodePtyPrebuildRoot, "darwin-x64", "spawn-helper"),
  ]) {
    if (await pathExists(helper)) {
      await chmod(helper, 0o755);
    }
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
