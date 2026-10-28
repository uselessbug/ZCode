import { isAbsolute, relative } from "node:path";
import type { VirtualProject } from "#src/project-storage/contract.js";

/**
 * 独立云端 Web 的非项目工作策略。只有显式开启时，远端 owner 才允许没有项目的会话；
 * 真实远端 Source 与桌面远控不传该策略，继续按原契约拒绝。
 */
export interface StandaloneNonProjectPolicy {
  allowStandaloneNonProject?: boolean;
  standaloneWorkspaceRoot?: string;
}

/** 远端限制必须依据持库宿主，不能让请求中的 hostId 或 addMissingRoot 绕过。 */
export function assertRemoteProjectRoots(
  ownerHostId: string | undefined,
  roots: readonly string[],
  previous?: VirtualProject,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (roots.length !== 1) throw new Error("project.remote-single-root-required");
  if (previous && (previous.roots.length !== 1 || previous.roots[0]?.rootPath !== roots[0]))
    throw new Error("project.remote-root-immutable");
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

/** 新建、移动和恢复共用约束；固定执行配置也不能给远端会话增加第二个目录。 */
export function assertRemoteTaskDirectories(
  ownerHostId: string | undefined,
  project: VirtualProject | null | undefined,
  workspacePath: string,
  additionalDirectories: readonly string[] = [],
  options?: StandaloneNonProjectPolicy,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (!project) {
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
    return;
  }
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
  );
  if (additionalDirectories.length) throw new Error("project.remote-single-root-required");
  if (project.roots[0]?.rootPath !== workspacePath) throw new Error("project.cwd-not-in-roots");
}
