import { z } from "zod";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import type {
  GroupTaskFact,
  GroupTaskRef,
  ITaskGroupService,
  MoveGroupNode,
} from "#src/task-groups/contract.js";
import { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  GroupTaskFact,
} from "#src/task-groups/contract.js";

/**
 * 独立云端 Web 的本地别名：装配层显式开启时，只把请求侧 `hostId: "local"` 解析到 owner Host。
 * 不改变仓储归属，也不为其它 Host 建立连接。
 */
export function resolveTaskGroupOwnerHostId(
  hostId: string,
  ownerHostId?: string,
  allowStandaloneLocalHostAlias = false,
): string {
  const owner = ownerHostId?.trim() || "local";
  if (allowStandaloneLocalHostAlias && owner !== "local" && hostId === "local") {
    return owner;
  }
  return hostId;
}

/** 校验 ref 的 hostId 与 workspaceIdentity 是否指向同一权威 Host。 */
export function isTaskGroupHostIdentityConsistent(
  task: Pick<GroupTaskRef, "hostId" | "workspacePath" | "workspaceIdentity">,
  ownerHostId?: string,
  allowStandaloneLocalHostAlias = false,
): boolean {
  const effectiveHostId = resolveTaskGroupOwnerHostId(
    task.hostId,
    ownerHostId,
    allowStandaloneLocalHostAlias,
  );
  const owner = ownerHostId?.trim() || "local";
  const identity = task.workspaceIdentity?.trim();
  if (!identity) {
    return (
      effectiveHostId === "local" ||
      (allowStandaloneLocalHostAlias && owner !== "local" && effectiveHostId === owner)
    );
  }
  const identityHostId = remoteHostIdFromWorkspaceIdentity(identity);
  if (!identityHostId) {
    return (
      identity === task.workspacePath &&
      (effectiveHostId === "local" ||
        (allowStandaloneLocalHostAlias && owner !== "local" && effectiveHostId === owner))
    );
  }
  return identityHostId === effectiveHostId;
}

export function createTaskGroupService(options: {
  database(): Promise<DatabaseSync>;
  resolveTasks(tasks: GroupTaskRef[]): Promise<GroupTaskFact[]>;
  afterChange(): Promise<void>;
  /** 独立云端 Web：owner Host 与本地别名只在装配层显式传入。 */
  ownerHostId?: string;
  allowStandaloneLocalHostAlias?: boolean;
}): ITaskGroupService {
  const allowAlias = Boolean(options.allowStandaloneLocalHostAlias);
  const ownerHostId = options.ownerHostId;
  const owner = ownerHostId?.trim() || "local";
  const taskSchema = z
    .object({
      hostId: z.string().min(1),
      workspacePath: z.string().min(1),
      workspaceIdentity: z.string().trim().min(1).optional(),
      taskId: z.string().min(1),
    })
    .strict()
    .refine(
      (task) => isTaskGroupHostIdentityConsistent(task, ownerHostId, allowAlias),
      "task-group.host-identity-mismatch",
    );
  const nodeSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("group"), groupId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("task"), task: taskSchema }).strict(),
  ]);
  // 请求侧 ref 与 Host 返回的权威 fact 只有在同一任务时才算匹配；独立云端别名下
  // 允许一方只有路径 key、另一方是 owner 作用域的 server identity。
  const matchesTaskFact = (fact: GroupTaskFact, ref: GroupTaskRef): boolean => {
    if (fact.taskId !== ref.taskId || fact.workspacePath !== ref.workspacePath) return false;
    if (
      resolveTaskGroupOwnerHostId(fact.hostId, ownerHostId, allowAlias) !==
      resolveTaskGroupOwnerHostId(ref.hostId, ownerHostId, allowAlias)
    )
      return false;
    if (groupTaskKey(fact) === groupTaskKey(ref)) return true;
    if (!allowAlias || owner === "local") return false;
    const factHostId = resolveTaskGroupOwnerHostId(fact.hostId, ownerHostId, allowAlias);
    if (factHostId !== owner) return false;
    const identityHostIdOf = (identity?: string) => {
      const value = identity?.trim();
      return value ? remoteHostIdFromWorkspaceIdentity(value) : null;
    };
    const isBareIdentity = (identity?: string) => {
      const value = identity?.trim();
      return !value || value === fact.workspacePath;
    };
    const isOwnerScopedIdentity = (identity?: string) => {
      const value = identity?.trim();
      if (!value) return false;
      const identityHostId = identityHostIdOf(value);
      return (
        identityHostId === owner && value.slice(identityHostId.length + 1) === fact.workspacePath
      );
    };
    return (
      (isBareIdentity(fact.workspaceIdentity) && isOwnerScopedIdentity(ref.workspaceIdentity)) ||
      (isBareIdentity(ref.workspaceIdentity) && isOwnerScopedIdentity(fact.workspaceIdentity))
    );
  };
  const repository = async () => new TaskGroupRepository(await options.database());
  const changed = async (run: (repo: TaskGroupRepository) => void) => {
    const repo = await repository();
    run(repo);
    await options.afterChange();
  };
  return {
    read: async () => (await repository()).read(),
    async save(input) {
      const parsed = z
        .object({
          id: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple"]).optional(),
        })
        .strict()
        .parse(input);
      const result = (await repository()).save(parsed);
      await options.afterChange();
      return result;
    },
    async ungroup(id) {
      await changed((repo) => repo.ungroup(z.string().min(1).parse(id)));
    },
    async move(input) {
      const parsed = z
        .object({
          node: nodeSchema,
          sourceGroupId: z.string().min(1).nullable(),
          groupId: z.string().min(1).nullable(),
          anchor: z
            .object({ node: nodeSchema, side: z.enum(["before", "after"]) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const refs = [parsed.node, parsed.anchor?.node].flatMap((node) =>
        node?.type === "task" ? [node.task] : [],
      );
      const facts = await options.resolveTasks(refs);
      // 归一化到 Host 返回的权威事实：仓储写入的 workspace_key / nodeKey / parent 查找
      // 必须与 admit 时数据库里登记的键逐字一致，不能被请求侧别名身份改写。
      const authoritative = (ref: GroupTaskRef): GroupTaskFact => {
        const fact = facts.find((candidate) => matchesTaskFact(candidate, ref));
        if (!fact || fact.deleted || fact.archived) throw new Error("task-group.task-unavailable");
        return fact;
      };
      const normalized: MoveGroupNode = {
        ...parsed,
        node:
          parsed.node.type === "task"
            ? { type: "task", task: authoritative(parsed.node.task) }
            : parsed.node,
        ...(parsed.anchor
          ? {
              anchor: {
                side: parsed.anchor.side,
                node:
                  parsed.anchor.node.type === "task"
                    ? { type: "task", task: authoritative(parsed.anchor.node.task) }
                    : parsed.anchor.node,
              },
            }
          : {}),
      };
      await changed((repo) => repo.move(normalized));
    },
    async admit(input) {
      const parsed = z
        .object({
          tasks: z.array(taskSchema).max(10000),
          placement: z
            .object({
              task: taskSchema,
              groupId: z.string().min(1).nullable(),
              creationId: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
      const refs = [...parsed.tasks];
      if (
        parsed.placement &&
        !refs.some(
          (ref) =>
            ref.taskId === parsed.placement!.task.taskId &&
            ref.workspacePath === parsed.placement!.task.workspacePath,
        )
      )
        refs.push(parsed.placement.task);
      const facts = await options.resolveTasks(refs);
      const placementFact = parsed.placement
        ? facts.find((fact) => matchesTaskFact(fact, parsed.placement!.task) && !fact.deleted)
        : undefined;
      if (parsed.placement && !placementFact)
        throw new Error("task-group.created-task-unavailable");
      // placement.task 必须与 admit 写入的存储键同源，否则 creation_id 标记与移动分支失配。
      const normalizedPlacement = parsed.placement
        ? { ...parsed.placement, task: placementFact! }
        : undefined;
      const db = await options.database();
      const before = db.prepare("SELECT total_changes() AS n").get()?.n;
      new TaskGroupRepository(db).admit(facts, normalizedPlacement);
      if (db.prepare("SELECT total_changes() AS n").get()?.n !== before)
        await options.afterChange();
    },
  };
}
