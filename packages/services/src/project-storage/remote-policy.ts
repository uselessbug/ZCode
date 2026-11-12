import { isAbsolute, relative } from "node:path";
import type { VirtualProject } from "#src/project-storage/contract.js";

/**
 * 独立云端 Web 的远端策略。只有显式开启时，远端 owner 才允许没有项目的会话；
 * 真实远端 Source 与桌面远控不传该策略，继续按原契约拒绝。
 */
export interface StandaloneNonProjectPolicy {
  allowStandaloneNonProject?: boolean;
  standaloneWorkspaceRoot?: string;
  /**
   * 独立云端 Web 的多 root 能力：允许项目拥有多个 root、允许在网页内增删 root，
   * 并允许 `moveTask` 把任务 cwd 增补为 root。普通远端 owner 不传该字段，维持单 root 与 root 不可变。
   */
  allowStandaloneMultiRoot?: boolean;
}

/**
 * 远端限制必须依据持库宿主，不能让请求中的 hostId 或 addMissingRoot 绕过。
 *
 * 普通远端：root 必须恰好 1 个，且创建后不可变更。
 * 独立云端 Web（`allowStandaloneMultiRoot`）：允许增删 root，但至少要保留 1 个，
 * 否则 `project_roots` 为空会让会话失去 cwd 归属。
 */
export function assertRemoteProjectRoots(
  ownerHostId: string | undefined,
  roots: readonly string[],
  previous?: VirtualProject,
  options?: StandaloneNonProjectPolicy,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (!options?.allowStandaloneMultiRoot) {
    if (roots.length !== 1) throw new Error("project.remote-single-root-required");
    if (previous && (previous.roots.length !== 1 || previous.roots[0]?.rootPath !== roots[0]))
      throw new Error("project.remote-root-immutable");
    return;
  }
  if (roots.length < 1) throw new Error("project.remote-single-root-required");
}

/**
 * 非项目会话目录必须落在配置的独立云端工作区根内。
 * 否则远端客户端可以把会话 cwd 指到任意宿主路径，等于绕过项目约束提权。
 */
function isWithinStandaloneWorkspaceRoot(root: string, path: string): boolean {
  const trimmedRoot = root.trim();
  if (!trimmedRoot) return true;
  if (path === trimmedRoot) return true;
  const rel = relative(trimmedRoot, path);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 无 projectId 会话的远端约束：独立云端 Web 显式开启时放行，且必须落在工作区根内。 */
function assertRemoteNonProjectDirectories(
  workspacePath: string,
  additionalDirectories: readonly string[],
  options?: StandaloneNonProjectPolicy,
): void {
  // 独立云端 Web 允许无 projectId 的会话，但只在显式开启策略时放宽，且仍要求：
  // 唯一目录、非空路径、位于配置的工作区根内。其他远端 owner 维持原拒绝。
  if (!options?.allowStandaloneNonProject) throw new Error("project.remote-project-required");
  if (additionalDirectories.length) throw new Error("project.remote-single-root-required");
  const path = workspacePath?.trim();
  if (!path) throw new Error("project.remote-project-required");
  if (
    options.standaloneWorkspaceRoot &&
    !isWithinStandaloneWorkspaceRoot(options.standaloneWorkspaceRoot, path)
  )
    throw new Error("project.remote-project-required");
}

/** 新建、移动（fork/自动化）共用约束；固定执行配置也不能给远端会话增加第二个目录。 */
export function assertRemoteTaskDirectories(
  ownerHostId: string | undefined,
  project: VirtualProject | null | undefined,
  workspacePath: string,
  additionalDirectories: readonly string[] = [],
  options?: StandaloneNonProjectPolicy,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (!project) {
    assertRemoteNonProjectDirectories(workspacePath, additionalDirectories, options);
    return;
  }
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
    undefined,
    options,
  );
  if (options?.allowStandaloneMultiRoot) {
    // 独立云端 Web 多 root：会话 cwd 与附加目录都必须落在项目 roots 内。
    // 不在这里放宽为“任意路径”，否则多 root 会变成不限 root。
    const roots = new Set(project.roots.map((root) => root.rootPath));
    if (!roots.has(workspacePath)) throw new Error("project.cwd-not-in-roots");
    if (additionalDirectories.some((directory) => !roots.has(directory)))
      throw new Error("project.cwd-not-in-roots");
    return;
  }
  if (additionalDirectories.length) throw new Error("project.remote-single-root-required");
  if (project.roots[0]?.rootPath !== workspacePath) throw new Error("project.cwd-not-in-roots");
}

/**
 * 读取已持久化任务目录时的约束。
 *
 * 原因：独立云端 Web 允许在网页内增删项目 root。任务持久化的是自己的 cwd（`root_path`），
 * 移除某个 root 后，仍属于该项目的历史任务 cwd 可能已不在当前 roots 内；此时必须仍能打开、
 * 导航并 fork 这些任务（与本地「已有任务保留原工作目录」一致）。因此独立多 root 的读取路径只校验
 * root 数量；要求 cwd 落在 roots 内属于创建/移动时的写路径约束。
 *
 * 普通远端（未开多 root）完全沿用创建约束，读取行为不变。
 */
export function assertStoredTaskDirectories(
  ownerHostId: string | undefined,
  project: VirtualProject | null | undefined,
  workspacePath: string,
  additionalDirectories: readonly string[] = [],
  options?: StandaloneNonProjectPolicy,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (!options?.allowStandaloneMultiRoot) {
    assertRemoteTaskDirectories(
      ownerHostId,
      project,
      workspacePath,
      additionalDirectories,
      options,
    );
    return;
  }
  if (!project) {
    assertRemoteNonProjectDirectories(workspacePath, additionalDirectories, options);
    return;
  }
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
    undefined,
    options,
  );
}

/**
 * 移动任务到项目的迁移目标校验。
 *
 * 原因：原实现直接复用 `assertRemoteTaskDirectories`，它在任务 cwd 不等于项目唯一 root 时抛
 * `project.cwd-not-in-roots`，导致 UI 期待的 `project.root-confirmation-required` + `addMissingRoot`
 * 分支在远端（含独立云端 Web）永远走不到。桌面 ownerHostId 为 `local`，本来就跳过远端断言，
 * 所以只有远端暴露这个不一致。
 *
 * 这里只校验 root 数量合法性：普通远端维持“cwd 必须是唯一 root”（不可增补）；独立云端 Web 放行，
 * 缺 root 的裁决交回仓库的 `root-confirmation-required`，由用户确认后以 `addMissingRoot: true` 增补。
 */
export function assertRemoteTaskMoveTarget(
  ownerHostId: string | undefined,
  project: VirtualProject,
  workspacePath: string,
  options?: StandaloneNonProjectPolicy,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
    undefined,
    options,
  );
  if (!options?.allowStandaloneMultiRoot && project.roots[0]?.rootPath !== workspacePath)
    throw new Error("project.cwd-not-in-roots");
}
