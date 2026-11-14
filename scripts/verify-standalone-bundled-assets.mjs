// 已构建发行镜像内的内置资产静态断言。
//
// 为什么单独成脚本：Dockerfile 的 .dockerignore 排除了 .git/.agents，镜像里也没有 pnpm 依赖，
// 完整 zcode-distribution-smoke 需要解压 tar 与 TUI/native 运行时，不适合在 runtime 镜像里跑；
// 这里只读 /app/zcode 已落盘的文件，断言官方插件（含 skill-creator）与内置技能包真实存在。
//
// 期望清单一律来自 CLI SEA 采集器（构建侧同一份事实源），脚本内不平行枚举资产；
// CI 只读挂载仓库提供清单文件，命中路径必须落在 releaseRoot 内、且不在挂载的源码树内，
// 避免用仓库源码资源造成假通过。
//
// 用法：node scripts/verify-standalone-bundled-assets.mjs <releaseRoot>（默认 /app/zcode）
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  bundledSkillPackRequiredPaths,
  bundledSkillPackRootPath,
} from "../apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs";
import { officialSeaPlugins } from "../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";

const releaseRoot = resolve(process.argv[2] ?? "/app/zcode");
const repoRoot = resolve(import.meta.dirname, "..");
const agentRoot = join(releaseRoot, "agent");
const insideRelease = (path) => path === releaseRoot || path.startsWith(`${releaseRoot}${sep}`);

async function assertReleaseFile(file, label) {
  assert.ok(insideRelease(file), `${label} escapes the release root: ${file}`);
  assert.ok(
    !file.startsWith(`${repoRoot}${sep}`),
    `${label} resolved into the mounted repo checkout: ${file}`,
  );
  const info = await stat(file).catch(() => null);
  assert.ok(info?.isFile(), `Missing ${label}: ${file}`);
}

for (const plugin of officialSeaPlugins) {
  const pluginRoot = join(agentRoot, plugin.rootPath);
  assert.ok(
    insideRelease(pluginRoot) && !pluginRoot.startsWith(`${repoRoot}${sep}`),
    `official plugin ${plugin.name} staged outside the release: ${pluginRoot}`,
  );
  await assertReleaseFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    `${plugin.name} plugin manifest`,
  );
  for (const relativePath of plugin.requiredSeedPaths ?? []) {
    await assertReleaseFile(
      join(pluginRoot, ...relativePath.split("/")),
      `${plugin.name} required seed asset ${relativePath}`,
    );
  }
  const runtimePaths =
    plugin.requiresRuntime === false ? [] : (plugin.requiredRuntimePaths ?? ["dist/mcp/server.js"]);
  for (const relativePath of runtimePaths) {
    await assertReleaseFile(
      join(pluginRoot, ...relativePath.split("/")),
      `${plugin.name} runtime ${relativePath}`,
    );
  }
}

// 内置技能包（packages/bundled-skills）随 CLI 打入发行包，缺失会静默丢技能。
for (const relativePath of bundledSkillPackRequiredPaths) {
  await assertReleaseFile(
    join(agentRoot, bundledSkillPackRootPath, ...relativePath.split("/")),
    `bundled skill asset ${relativePath}`,
  );
}

console.log(
  JSON.stringify({
    releaseRoot,
    plugins: officialSeaPlugins.length,
    bundledSkillAssets: bundledSkillPackRequiredPaths.length,
    bundledAssets: "verified",
  }),
);
