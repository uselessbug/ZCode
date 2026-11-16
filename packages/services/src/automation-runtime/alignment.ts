import { isRemoteWorkspaceIdentity, remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import {
  AutomationPermanentDispatchError,
  type AutomationDispatchRequest,
  type AutomationLoggerPort,
  type AutomationRepoPort,
} from "./contract.js";

export interface StandaloneWorkspaceResolution {
  canonicalWorkspaceKey: string;
}

export interface StandaloneAutomationAlignmentOptions {
  repo: Pick<AutomationRepoPort, "list" | "alignStandaloneWorkspaceIdentity">;
  projectStorageHostId: string;
  /** 必须为只读/无批量迁移副作用的 canonical 身份查询，不得扫描改写同路径异域记录。 */
  resolveWorkspace: (workspacePath: string) => Promise<StandaloneWorkspaceResolution>;
  logger: Pick<AutomationLoggerPort, "info" | "warn">;
}

/**
 * standalone HTTP 调度器启动前对存量定义执行权威身份对齐：
 * 必须在调用可能产生 SQLite 迁移副作用的 resolveWorkspace 之前，以纯无副作用条件判定
 * 定义确属当前服务器；非本 Host 的异域定义立即跳过，绝不调用 resolveWorkspace、不覆盖、不回落 "local"。
 */
export async function alignStandaloneAutomations(
  options: StandaloneAutomationAlignmentOptions,
): Promise<void> {
  if (!options.repo.alignStandaloneWorkspaceIdentity) return;
  const automations = await options.repo.list();
  for (const automation of automations) {
    // 1. 先按 hostId 排除非本服务器的异域定义（允许缺失或 "local" 的本机历史记录继续检查）。
    if (
      automation.hostId &&
      automation.hostId !== "local" &&
      automation.hostId !== options.projectStorageHostId
    ) {
      options.logger.warn(
        `跳过异域定时任务身份对齐 automation=${automation.automationId} hostId=${automation.hostId}`,
      );
      continue;
    }

    // 2. 纯无副作用检查已有身份：若携带远程 URI 身份（remote:ssh:* / remote:wsl:* / remote:docker:*
    //    或其他 remote:server:*），仅当其 hostId 确属当前 serverId 时才允许进入后续解析；
    //    非远端 URI（缺失或显式本地路径如 workspaceIdentity === workspacePath）视为历史本地记录。
    const rawIdentity =
      automation.workspaceIdentity?.trim() ||
      (isRemoteWorkspaceIdentity(automation.workspaceKey) ? automation.workspaceKey : undefined);
    if (rawIdentity && isRemoteWorkspaceIdentity(rawIdentity)) {
      if (remoteHostIdFromWorkspaceIdentity(rawIdentity) !== options.projectStorageHostId) {
        options.logger.warn(
          `跳过异域 workspaceIdentity 定时任务对齐 automation=${automation.automationId} identity=${rawIdentity}`,
        );
        continue;
      }
    }

    let canonicalWorkspaceKey: string;
    try {
      canonicalWorkspaceKey = (await options.resolveWorkspace(automation.workspacePath))
        .canonicalWorkspaceKey;
    } catch (error) {
      options.logger.warn(
        `解析定时任务工作区身份失败，保持原记录待派发时拒绝 automation=${automation.automationId}`,
        error,
      );
      continue;
    }

    const alreadyAligned =
      automation.workspaceKey === canonicalWorkspaceKey &&
      automation.workspaceIdentity === canonicalWorkspaceKey &&
      automation.hostId === options.projectStorageHostId;
    if (alreadyAligned) continue;

    const aligned = await options.repo.alignStandaloneWorkspaceIdentity({
      automationId: automation.automationId,
      expectedOldWorkspaceKey: automation.workspaceKey,
      canonicalWorkspaceKey,
      hostId: options.projectStorageHostId,
    });
    if (aligned) {
      options.logger.info(
        `已对齐存量定时任务身份 automation=${automation.automationId} key=${canonicalWorkspaceKey}`,
      );
    }
  }
}

/**
 * standalone 运行期派发防线：只允许当前 Host canonical 身份与可信 hostId 派发，
 * 异域或未对齐记录明确按 permanent failure 拒绝，绝不调用 resolveWorkspace、绝不回落 "local"。
 */
export async function assertStandaloneAutomationOwnership(params: {
  request: Pick<
    AutomationDispatchRequest,
    "automationId" | "hostId" | "workspacePath" | "workspaceIdentity"
  >;
  projectStorageHostId: string;
  resolveWorkspace: (workspacePath: string) => Promise<StandaloneWorkspaceResolution>;
}): Promise<void> {
  const { request, projectStorageHostId } = params;
  if (!request.hostId || request.hostId === "local" || request.hostId !== projectStorageHostId) {
    throw new AutomationPermanentDispatchError(
      `Automation host mismatch: ${request.hostId ?? "missing"} !== ${projectStorageHostId}`,
    );
  }
  const identity = request.workspaceIdentity?.trim();
  if (!identity) {
    throw new AutomationPermanentDispatchError(
      `Automation workspaceIdentity missing: ${request.automationId}`,
    );
  }
  if (
    !isRemoteWorkspaceIdentity(identity) ||
    (identity.startsWith("remote:server:") &&
      remoteHostIdFromWorkspaceIdentity(identity) !== projectStorageHostId)
  ) {
    throw new AutomationPermanentDispatchError(
      `Automation workspaceIdentity is not owned by this server: ${identity}`,
    );
  }
  const { canonicalWorkspaceKey } = await params.resolveWorkspace(request.workspacePath);
  if (identity !== canonicalWorkspaceKey) {
    throw new AutomationPermanentDispatchError(
      `Automation workspaceIdentity mismatch: ${identity} !== ${canonicalWorkspaceKey}`,
    );
  }
}
