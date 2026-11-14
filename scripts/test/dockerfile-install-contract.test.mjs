import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);

test("Dockerfile 在 hoisted 模式下以 --child-concurrency=1 串行执行依赖构建脚本", async () => {
  const [dockerfile, npmrc, manifest] = await Promise.all([
    readFile(new URL("Dockerfile", repositoryRoot), "utf8"),
    readFile(new URL(".npmrc", repositoryRoot), "utf8"),
    readFile(new URL("package.json", repositoryRoot), "utf8").then(JSON.parse),
  ]);

  assert.match(npmrc, /^node-linker=hoisted$/mu);
  assert.equal(manifest.packageManager, "pnpm@10.33.2");
  assert.match(manifest.scripts?.prepare ?? "", /\bhusky\b.*build:cua/u);

  const installLines = dockerfile
    .split(/\r?\n/u)
    .filter((line) => /^\s*RUN\s+.*pnpm\s+install\b/u.test(line));

  assert.equal(installLines.length, 1, "Dockerfile 应仅有一条根 pnpm install RUN 指令");
  const [installLine] = installLines;

  assert.match(installLine, /--frozen-lockfile\b/u);
  assert.match(
    installLine,
    /--child-concurrency=1\b/u,
    "hoisted 模式下需通过 --child-concurrency=1 串行化 buildModules postinstall 与 hardLinkDir",
  );
  assert.doesNotMatch(
    installLine,
    /--ignore-scripts\b/u,
    "不可跳过生命周期脚本，否则根 prepare (husky && pnpm build:cua) 与原生构建会被跳过",
  );
  assert.doesNotMatch(
    installLine,
    /(?:\|\|\s*pnpm\s+install|\bwhile\b|\bfor\b)/u,
    "不可用循环 retry 掩盖并发竞态",
  );
});
