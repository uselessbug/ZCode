import type { Memory, MemoryConfig } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";
export const PROJECT_MEMORY_FILE_WRITE_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_FILE_WRITE_LIMIT_EXCEEDED";

/** 项目记忆正文上限（读写共用）：5 MiB。 */
export const PROJECT_MEMORY_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface ProjectMemoryFileContent {
  content: string;
  /** 读取时刻的文件 mtime（毫秒）。 */
  updatedAt: number;
  /** 读取时刻正文的 sha256（hex），用于保存时的乐观并发校验。 */
  contentHash: string;
}

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

export interface IMemoryService {
  /**
   * 加载指定 agent 的 memory 文件
   * @param workspacePath workspace 路径
   * @param agentId agent ID (如 'claude', 'gemini' 等)
   */
  loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }>;

  /**
   * 保存 memory 配置
   */
  saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void>;

  /**
   * 清除 memory 内容
   */
  clearMemory(params: { workspacePath: string; agentId: string }): Promise<void>;

  /**
   * 获取用户级 memory 目录路径，并确保目录存在
   */
  getUserMemoryDirectory(): Promise<{ path: string }>;

  /** 列出当前本地 profile 中可查看的 Project Memory。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<ProjectMemoryFileContent>;

  /**
   * 写回一个**已存在**的 Project Memory Markdown 文件。
   *
   * 这是最小保存能力，不是通用任意文件写 API：目标必须命中 `requireExactProjectMemoryFile`
   * （已存在、常规文件、非符号链接、文件名精确匹配），且只能写 `memory/` 目录下的 Markdown。
   *
   * 乐观并发：调用方传入读取时得到的 `expectedUpdatedAt` 与 `expectedContentHash`；
   * 保存前用稳定读取重新取当前版本，任一不一致（被改动 / 删除 / 替换）即抛
   * `PROJECT_MEMORY_FILE_CHANGED` 并拒绝覆盖，由调用方保留草稿。
   *
   * 诚实边界：校验与原子 `rename` 之间仍存在窗口，外部写手可能在该窗口替换文件；
   * 本接口只保证“校验时刻已变化则拒绝”，不引入文件锁，也不承诺跨进程严格串行。
   */
  saveProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
    content: string;
    expectedUpdatedAt: number;
    expectedContentHash: string;
  }): Promise<{ updatedAt: number; contentHash: string }>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
