// 独立 Web 记忆正文的真实文件验收，不启动浏览器或调用模型。
// 运行：pnpm exec tsx packages/web/test/e2e/remote-control/projects/manual-review/pending/standalone-memory-files.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDataBaseDir } from "../../../../../../../services/src/paths.ts";
import { createMemoryService } from "../../../../../../../services/src/memory/memoryService.ts";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_FILE_WRITE_LIMIT_EXCEEDED_ERROR_CODE,
} from "../../../../../../../services/src/memory/memory.ts";

const root = await mkdtemp(join(tmpdir(), "zcode-memory-files-"));
const workspaceId = "acceptance-0123456789abcdef";
const memoryRoot = join(root, ".zcode/cli/memories/projects", workspaceId, "memory");
const filePath = join(memoryRoot, "MEMORY.md");
setDataBaseDir(root);
const service = createMemoryService();
const read = () => service.readProjectMemoryFile({ workspaceId, fileName: "MEMORY.md" });
const save = (snapshot, content) =>
  service.saveProjectMemoryFile({
    workspaceId,
    fileName: "MEMORY.md",
    content,
    expectedUpdatedAt: snapshot.updatedAt,
    expectedContentHash: snapshot.contentHash,
  });

try {
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(filePath, "# 原始记忆\n", { mode: 0o600 });
  await chmod(filePath, 0o600);
  const original = await read();
  const saved = await save(original, "# 网页修改\n");
  const current = await read();
  assert.equal(current.content, "# 网页修改\n");
  assert.equal(current.contentHash, saved.contentHash);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  console.log("PASS 正文读取、保存与权限保留");

  await writeFile(filePath, "# Agent 已更新\n");
  await assert.rejects(save(current, "# 旧草稿\n"), {
    code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  });
  assert.equal(await readFile(filePath, "utf8"), "# Agent 已更新\n");
  console.log("PASS Agent 更新后拒绝覆盖");

  const beforeDelete = await read();
  await rm(filePath);
  await assert.rejects(save(beforeDelete, "# 旧草稿\n"), {
    code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  });
  console.log("PASS 删除后保存返回冲突");

  const outsidePath = join(root, "outside.md");
  await writeFile(outsidePath, "不能覆盖\n");
  await symlink(outsidePath, filePath);
  await assert.rejects(save(beforeDelete, "# 越界写入\n"), {
    code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  });
  assert.equal(await readFile(outsidePath, "utf8"), "不能覆盖\n");
  await assert.rejects(read());
  console.log("PASS 符号链接不可读写，外部文件不变");

  await rm(filePath);
  await writeFile(filePath, "# 有效记忆\n");
  const valid = await read();
  await assert.rejects(save(valid, "x".repeat(PROJECT_MEMORY_FILE_MAX_BYTES + 1)), {
    code: PROJECT_MEMORY_FILE_WRITE_LIMIT_EXCEEDED_ERROR_CODE,
  });
  await assert.rejects(
    service.saveProjectMemoryFile({
      workspaceId: "..",
      fileName: "MEMORY.md",
      content: "非法路径",
      expectedUpdatedAt: valid.updatedAt,
      expectedContentHash: valid.contentHash,
    }),
  );
  console.log("PASS 字节上限与路径边界");
} finally {
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
}
