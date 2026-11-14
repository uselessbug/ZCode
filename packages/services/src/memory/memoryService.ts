import type { Memory, MemoryConfig } from "@zcode/shared";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_FILE_WRITE_LIMIT_EXCEEDED_ERROR_CODE,
  type IMemoryService,
  type ProjectMemoryFileContent,
  type ProjectMemoryFileSummary,
  type ProjectMemoryWorkspaceSummary,
} from "./memory.js";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  readProjectMemoryFileFromStableHandle,
  hashProjectMemoryContent,
} from "#src/memory/projectMemoryStableRead.js";
import { getZCodeDataRootDir } from "#src/paths.js";

const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const PROJECT_MEMORY_DIRECTORY_NAME = "memory";
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getProjectMemoriesRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isProjectMemoryFileName(fileName: string): boolean {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith(".md") && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

function resolveWorkspaceLabel(workspaceId: string): string {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function requirePlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project Memory directory is not a regular directory: ${path}`);
  }
}

async function requireProjectMemoriesRoot(): Promise<string> {
  const projectsRoot = getProjectMemoriesRoot();
  // 只校验 workspace 子目录时，projectsRoot symlink 会让 list/read 跟随到本地数据目录外。
  await requirePlainDirectory(projectsRoot);
  return projectsRoot;
}

async function requireExactProjectMemoryFile(
  memoryRoot: string,
  fileName: string,
): Promise<string> {
  const memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  const fileEntry = memoryEntries.find((entry) => entry.name === fileName);
  const requestedFilePath = join(memoryRoot, fileName);
  if (!fileEntry) {
    // 文件确实不存在时继续透传原始 ENOENT；只有大小写别名能命中时才拒绝读取。
    await lstat(requestedFilePath);
    throw new Error(`Project Memory file name does not match exactly: ${fileName}`);
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  return requestedFilePath;
}

async function assertContainedProjectMemoryPath(
  projectsRoot: string,
  targetPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const targetRealPath = await realpath(targetPath);
  const relativePath = relative(projectsRootRealPath, targetRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the local profile: ${targetPath}`);
  }
}

function createProjectMemoryChangedError(fileName: string, reason: string): Error {
  return Object.assign(
    new Error(`Project Memory file changed before save: ${fileName} (${reason})`),
    { code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE },
  );
}

function hasProjectMemoryChangedCode(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE
  );
}

/**
 * 保存阶段的错误归一化：目标/父目录消失（ENOENT）或目标被替换成非常规文件
 * 都视为“读取后已被改动/删除/替换”，统一映射 PROJECT_MEMORY_FILE_CHANGED；
 * 其它 IO 错误（权限、磁盘）保留原始错误，避免误导成并发冲突。
 */
function toProjectMemorySaveError(error: unknown, fileName: string): unknown {
  if (hasProjectMemoryChangedCode(error)) {
    return error;
  }
  if (isNotFoundError(error)) {
    return createProjectMemoryChangedError(fileName, "missing");
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("is not a regular file") || message.includes("is not a regular directory")) {
    return createProjectMemoryChangedError(fileName, "replaced");
  }
  return error;
}

async function writeProjectMemoryFileAtomically(params: {
  memoryRoot: string;
  fileName: string;
  filePath: string;
  content: Buffer;
  /** 原文件权限位（0o777 掩码），写入后显式恢复，避免临时文件模式与目标不一致。 */
  mode: number;
  /** 复用只读路径的父目录 symlink/containment 校验，创建临时文件前先确认边界。 */
  validatePath: () => Promise<void>;
  /** rename 前最终确认：重新稳定读取目标并与期望版本比对。 */
  confirmUnchanged: () => Promise<void>;
}): Promise<void> {
  // 同目录临时文件 + rename 做原子替换：避免半截内容被并发读取。
  // 独占创建临时文件（wx）防止覆盖同名残留；随机后缀避免两次保存互相踩踏。
  const tempPath = join(params.memoryRoot, `.${params.fileName}.${randomUUID()}.tmp`);
  try {
    // 创建临时文件前先复用父目录/containment 校验，缩小“校验→落盘”窗口。
    await params.validatePath();
    const handle = await open(tempPath, "wx", params.mode);
    try {
      // open 的 mode 会被 umask 过滤，这里显式 fchmod 精确恢复原权限。
      await handle.chmod(params.mode);
      await handle.writeFile(params.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // rename 前复用完整 validatePath + 稳定读取重新比对期望版本：目标被改动/删除/替换即拒绝。
    // 诚实边界：这里到 rename 之间仍有窗口，外部写手可替换文件；本实现不引入文件锁，
    // 只保证“确认时刻不符即拒绝”，不承诺跨进程严格串行。
    await params.confirmUnchanged();
    await rename(tempPath, params.filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function compareProjectMemoryFiles(
  left: ProjectMemoryFileSummary,
  right: ProjectMemoryFileSummary,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "index" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "en");
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getUserMemoryDir(): string {
  return join(resolveUserHomeDir(), ".claude", "memory");
}

/**
 * 获取 agent 对应的 memory 文件名
 */
function getMemoryFileName(_agentId: string): string {
  // 目前只支持 MEMORY.md，后续可以根据 agent 类型扩展
  return "MEMORY.md";
}

/**
 * 创建 Memory 服务实例
 */
export function createMemoryService(): IMemoryService {
  async function loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();

      // 直接从用户级 ~/.claude/memory 目录读取
      const filePath = join(memoryDir, fileName);
      try {
        const content = await readFile(filePath, "utf-8");
        return {
          memory: {
            content: content || "",
            enabled: true,
          },
        };
      } catch {
        // 文件不存在，返回 null
        return { memory: null };
      }
    } catch (error) {
      console.error("Failed to load memory:", error);
      return { memory: null };
    }
  }

  async function saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void> {
    const { agentId, config } = params;

    try {
      // 直接保存到用户级 ~/.claude/memory 目录
      const memoryDir = getUserMemoryDir();
      await mkdir(memoryDir, { recursive: true });

      const fileName = getMemoryFileName(agentId);
      const filePath = join(memoryDir, fileName);
      await writeFile(filePath, config.content, "utf-8");
    } catch (error) {
      console.error("Failed to save memory:", error);
      throw error;
    }
  }

  async function clearMemory(params: { workspacePath: string; agentId: string }): Promise<void> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();
      const filePath = join(memoryDir, fileName);

      try {
        await writeFile(filePath, "", "utf-8");
      } catch {
        // 文件不存在，忽略错误
      }
    } catch (error) {
      console.error("Failed to clear memory:", error);
      throw error;
    }
  }

  async function getUserMemoryDirectory(): Promise<{ path: string }> {
    const memoryDir = getUserMemoryDir();
    try {
      await mkdir(memoryDir, { recursive: true });
    } catch {
      // 目录已存在
    }
    return { path: memoryDir };
  }

  async function listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
    let projectsRoot: string;
    let projectEntries;
    try {
      projectsRoot = await requireProjectMemoriesRoot();
      projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const workspaces: ProjectMemoryWorkspaceSummary[] = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
        continue;
      }

      const workspaceId = projectEntry.name;
      const workspaceRoot = join(projectsRoot, workspaceId);
      const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
      if (!(await isPlainDirectory(workspaceRoot)) || !(await isPlainDirectory(memoryRoot))) {
        continue;
      }

      let memoryEntries;
      try {
        memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
      } catch (error) {
        // 目录检查后 Memory Agent 仍可能删除目录；catalog 快照只跳过已消失的 workspace。
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      const files: ProjectMemoryFileSummary[] = [];
      for (const memoryEntry of memoryEntries) {
        if (
          !memoryEntry.isFile() ||
          memoryEntry.isSymbolicLink() ||
          !isProjectMemoryFileName(memoryEntry.name)
        ) {
          continue;
        }

        const filePath = join(memoryRoot, memoryEntry.name);
        let fileMetadata;
        try {
          fileMetadata = await lstat(filePath);
        } catch (error) {
          // readdir 后事实文件可能被并发删除；它不再属于本次只读快照。
          if (isNotFoundError(error)) {
            continue;
          }
          throw error;
        }
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
          continue;
        }
        files.push({
          name: memoryEntry.name,
          path: filePath,
          kind: memoryEntry.name === PROJECT_MEMORY_INDEX_FILE_NAME ? "index" : "item",
          size: fileMetadata.size,
          updatedAt: fileMetadata.mtimeMs,
        });
      }

      if (files.length === 0) {
        continue;
      }

      files.sort(compareProjectMemoryFiles);
      workspaces.push({
        id: workspaceId,
        label: resolveWorkspaceLabel(workspaceId),
        updatedAt: Math.max(...files.map((file) => file.updatedAt)),
        files,
      });
    }

    workspaces.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"),
    );
    return workspaces;
  }

  async function readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<ProjectMemoryFileContent> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // Bugfix：大小写不敏感文件系统会让请求名称命中不同大小写的磁盘文件，绕过 catalog 白名单。
    const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      },
    });
  }

  async function saveProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
    content: string;
    expectedUpdatedAt: number;
    expectedContentHash: string;
  }): Promise<{ updatedAt: number; contentHash: string }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const contentBuffer = Buffer.from(params.content, "utf-8");
    if (contentBuffer.length > PROJECT_MEMORY_FILE_MAX_BYTES) {
      throw Object.assign(
        new Error(
          `Project Memory content exceeds the ${PROJECT_MEMORY_FILE_MAX_BYTES} byte write limit: ${params.fileName}`,
        ),
        { code: PROJECT_MEMORY_FILE_WRITE_LIMIT_EXCEEDED_ERROR_CODE },
      );
    }

    // 本次实际写入内容的 hash：写后重读必须与它一致，否则说明目标被外部改写，
    // 不能把外部版本（及其 hash）配给用户的草稿。
    const writtenContentHash = hashProjectMemoryContent(params.content);

    try {
      const projectsRoot = await requireProjectMemoriesRoot();
      const workspaceRoot = join(projectsRoot, params.workspaceId);
      const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
      await requirePlainDirectory(workspaceRoot);
      await requirePlainDirectory(memoryRoot);
      const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);

      const validatePath = async (): Promise<void> => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      };
      const assertUnchanged = async (): Promise<void> => {
        const fresh = await readProjectMemoryFileFromStableHandle({
          fileName: params.fileName,
          filePath,
          validatePath,
        });
        if (
          fresh.updatedAt !== params.expectedUpdatedAt ||
          fresh.contentHash !== params.expectedContentHash
        ) {
          throw createProjectMemoryChangedError(params.fileName, "version-mismatch");
        }
      };

      // 乐观并发：复用官方稳定读取拿到当前 mtime + 内容 hash，与调用方读取时的期望比较。
      // 任一不一致（被外部改动 / 删除 / 替换）即拒绝覆盖，由 UI 保留草稿。
      await assertUnchanged();

      // 保留原文件权限位：不要因改写成临时文件而放宽或收紧访问控制。
      const originalMode = (await lstat(filePath)).mode & 0o777;
      await writeProjectMemoryFileAtomically({
        memoryRoot,
        fileName: params.fileName,
        filePath,
        content: contentBuffer,
        mode: originalMode,
        validatePath,
        confirmUnchanged: assertUnchanged,
      });

      // 写后重新稳定读取，返回服务端权威的新版本。若外部写手在我们的 rename 之后又改写了内容，
      // 重读 hash 与本次写入不符——此时报冲突并保留草稿，绝不把它的 hash 当成用户的保存结果。
      const saved = await readProjectMemoryFileFromStableHandle({
        fileName: params.fileName,
        filePath,
        validatePath,
      });
      if (saved.contentHash !== writtenContentHash) {
        throw createProjectMemoryChangedError(params.fileName, "modified-after-write");
      }
      return { updatedAt: saved.updatedAt, contentHash: saved.contentHash };
    } catch (error) {
      throw toProjectMemorySaveError(error, params.fileName);
    }
  }

  return {
    loadMemory,
    saveMemory,
    clearMemory,
    getUserMemoryDirectory,
    listProjectMemories,
    readProjectMemoryFile,
    saveProjectMemoryFile,
  };
}
