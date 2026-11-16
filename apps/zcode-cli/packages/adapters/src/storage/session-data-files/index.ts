import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute } from "node:path";

import type { SessionDataDirectory, SessionDataFilesPort, SessionDataFile } from "./contract.js";

export type { SessionDataDirectory, SessionDataFile, SessionDataFilesPort } from "./contract.js";

/** 按 `<artifacts>/<sessionId>` 第一层顶层条目归属判定文件是否匹配目标 artifactId。 */
export function matchesRetainedArtifactFile(
  file: Pick<SessionDataFile, "name" | "relativePath" | "kind" | "artifactEntryName">,
  artifactId: string,
): boolean {
  if (file.kind !== "artifact" || !artifactId) return false;
  const entryName = file.artifactEntryName ?? file.name;
  const segments = file.relativePath.replace(/\\/g, "/").split("/");
  // 新子目录布局（artifacts/<sessionId>/<artifactId>/<leaf>）必须精确匹配顶层目录名，
  // 绝不用叶子 fileName.includes(artifactId)，防止同名文件在不同 artifactId 间误留或误删。
  if (segments[0] === "artifacts" && segments.length > 3) {
    return entryName === artifactId;
  }
  return (
    entryName === artifactId ||
    entryName.startsWith(`${artifactId}.`) ||
    entryName.includes(`-${artifactId}.`) ||
    entryName.endsWith(`-${artifactId}`)
  );
}

export interface NodeSessionDataFilesOptions {
  cliStorageRoot: string;
  /** 返回 `<cli>/memories/projects/<slug>-<hash>/memory`；删除其父目录。 */
  memoryRoot(directory: SessionDataDirectory): string;
}

/** 会话目录（每个会话一个子目录）与模型调用轨迹（每个会话一个文件）所在的位置。 */
const SESSION_DIRECTORY_ROOTS = ["artifacts", "exec", "agents", "sessions"] as const;
const MODEL_IO_DIRECTORIES = ["debug", "rollout"] as const;
const MEMORY_PROJECTS_PATH = ["memories", "projects"] as const;
// 会话 ID 直接拼进路径，必须是单个安全文件名段。
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function createNodeSessionDataFiles(
  options: NodeSessionDataFilesOptions,
): SessionDataFilesPort {
  const root = options.cliStorageRoot;
  const sessionPaths = (sessionId: string) => {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("session-data.invalid-session-id");
    return [
      ...SESSION_DIRECTORY_ROOTS.map((name) => join(root, name, sessionId)),
      ...MODEL_IO_DIRECTORIES.map((name) => join(root, name, `model-io-${sessionId}.jsonl`)),
    ];
  };
  const memoryPath = (directory: SessionDataDirectory) => {
    const projectFolder = dirname(options.memoryRoot(directory));
    const projects = join(root, ...MEMORY_PROJECTS_PATH);
    const inside = relative(projects, projectFolder);
    // 只允许 memories/projects 的直接子目录，防止解析结果越界删到别处。
    if (
      !inside ||
      inside.startsWith("..") ||
      isAbsolute(inside) ||
      inside.includes("/") ||
      inside.includes("\\")
    )
      throw new Error("session-data.memory-outside-storage");
    return projectFolder;
  };
  const measureAll = async (paths: string[]) =>
    (await Promise.all(paths.map(measurePath))).reduce((sum, bytes) => sum + bytes, 0);
  const removeAll = async (paths: string[]) => {
    const bytes = await measureAll(paths);
    // rm 不跟随目录内的符号链接；顶层是链接时只删除链接本身。
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
    return bytes;
  };
  const listSessionFiles = async (sessionId: string): Promise<SessionDataFile[]> => {
    const result: SessionDataFile[] = [];
    const artifactsSessionDir = join(root, "artifacts", sessionId);
    for (const path of sessionPaths(sessionId)) {
      const isArtifactsDir = path === artifactsSessionDir;
      const kind = isArtifactsDir ? "artifact" : "record";
      const walk = async (current: string, artifactEntryName?: string): Promise<void> => {
        let stats;
        try {
          stats = await lstat(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (stats.isSymbolicLink()) {
          result.push({
            name: basename(current),
            relativePath: relative(root, current),
            kind,
            bytes: 0,
            ...(artifactEntryName !== undefined ? { artifactEntryName } : {}),
          });
          return;
        }
        if (stats.isDirectory()) {
          for (const entry of await readdir(current)) {
            // 忽略未发布的具名附件暂存目录（.zcode-staging-*），不计入正式会话产物清单。
            if (
              isArtifactsDir &&
              current === artifactsSessionDir &&
              entry.startsWith(".zcode-staging-")
            ) {
              continue;
            }
            // 仅记录 <artifacts>/<sessionId> 下的第一层顶层条目名供保留归属判定。
            const nextEntryName =
              isArtifactsDir && current === artifactsSessionDir ? entry : artifactEntryName;
            await walk(join(current, entry), nextEntryName);
          }
          return;
        }
        result.push({
          name: basename(current),
          relativePath: relative(root, current),
          kind,
          bytes: stats.size,
          ...(artifactEntryName !== undefined ? { artifactEntryName } : {}),
        });
      };
      // 存储类别目录若被换成链接，不能沿祖先链接清理用户文件。
      const parent = await lstat(dirname(path)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (parent?.isSymbolicLink()) throw new Error("session-data.symlink-root");
      await walk(path);
    }
    return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  };
  const removeSession = async (
    sessionId: string,
    retained: readonly string[] = [],
  ): Promise<number> => {
    const paths = sessionPaths(sessionId);
    const manifest = await listSessionFiles(sessionId);
    if (!retained.length) {
      await removeAll(paths);
      return manifest.reduce((sum, file) => sum + file.bytes, 0);
    }
    // 按第一层顶层 artifact 条目精确保留，未保留子目录连同同名叶子文件一并递归删除。
    const keep = (file: SessionDataFile) =>
      file.kind === "artifact" && retained.some((id) => matchesRetainedArtifactFile(file, id));
    const bytes = manifest.filter((file) => !keep(file)).reduce((sum, file) => sum + file.bytes, 0);
    const retainedEntries = new Set(
      manifest.filter(keep).map((file) => file.artifactEntryName ?? file.name),
    );
    const artifactsDir = paths[0]!;
    const artifactsStats = await lstat(artifactsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (artifactsStats?.isSymbolicLink()) {
      await rm(artifactsDir, { recursive: true, force: true });
    } else if (artifactsStats?.isDirectory()) {
      for (const entry of await readdir(artifactsDir)) {
        if (retainedEntries.has(entry)) continue;
        const entryPath = join(artifactsDir, entry);
        const entryStats = await lstat(entryPath).catch(() => null);
        if (entryStats?.isDirectory() && retained.includes(entry)) continue;
        await rm(entryPath, { recursive: true, force: true });
      }
    }
    for (const path of paths.slice(1)) await rm(path, { recursive: true, force: true });
    return bytes;
  };
  return {
    measureSession: async (sessionId) => measureAll(sessionPaths(sessionId)),
    removeSession,
    listSessionFiles,
    measureMemory: async (directory) => measureAll([memoryPath(directory)]),
    removeMemory: async (directory) => removeAll([memoryPath(directory)]),
  };
}

async function measurePath(path: string): Promise<number> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.size;
  const entries = await readdir(path);
  const sizes = await Promise.all(entries.map((entry) => measurePath(join(path, entry))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}
