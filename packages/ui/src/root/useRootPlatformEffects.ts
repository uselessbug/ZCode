/* oxlint-disable eslint(max-lines) -- 平台事件和分享导入共用同一生命周期。 */
import { getConversationShareErrorDetails } from "@/lib/conversationShareError.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import type { IPlatformService, ZCodeTaskClientMode } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { readV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  isWorkspaceTab,
  type TabStoreState,
  type WindowTabState,
  type WorkspaceTabState,
} from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import { requestNotificationTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { logger } from "@/logger.js";
import {
  isWebRemoteControlMobileHomeListVisible,
  subscribeWebRemoteControlMobileHomeListVisibility,
} from "@/WebRemoteControlMobileShell.js";
import { resolveImportedComposerConfig } from "@/v4/composer/newTaskDraft.js";
import { dismissToast, toast, updateToast } from "@/components/ui/toast.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import {
  useWebRemoteControlWorkspaceSync,
  shouldPublishCompleteWorkspaceSnapshot,
} from "@/root/rootPlatformWorkspaceSync.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  createShareImportIntent,
  isShareImportIntentSame,
  resolveShareImportFailurePresentation,
  type ShareImportIntent,
} from "@/root/shareImportIntent.js";

type NotificationTaskContext = { workspacePath?: string; workspaceIdentity?: string };

/** 冷启动时 workspace 列表可能还在加载，通知点击最多等待这么久再放弃。 */
const NOTIFICATION_TASK_WAIT_MS = 12_000;

type NotificationNavigationDeps = {
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (workspacePath: string) => void;
  /** 读取当前激活的 workspace tab，用来取得 tab 实际使用的 workspaceIdentity。 */
  getActiveWorkspaceTab: () => { workspacePath: string; workspaceIdentity?: string } | undefined;
  /** 独立 Web 才允许在 identity 未命中时退回本地 path 与新建本地 tab。 */
  allowLocalFallback: boolean;
  /** 历史 tab 还没恢复完成时不能 addTab，否则会被随后的 restoreTabs 整体替换。 */
  canOpenTab: boolean;
};

/**
 * 激活通知目标 workspace，返回 tab 实际使用的 identity；目标暂不可用时返回 null。
 *
 * 独立 Web 的浏览器本地 tab 没有 workspaceIdentity，而服务端通知带的是 canonical identity，
 * 所以 identity 未命中时先退回纯 path 激活，仍未打开则新建本地 tab。
 */
function activateNotificationWorkspace(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  deps: NotificationNavigationDeps,
): { workspaceIdentity: string | undefined } | null {
  const resolveIdentity = (fallback: string | undefined) => {
    const activeTab = deps.getActiveWorkspaceTab();
    return activeTab?.workspacePath === workspacePath ? activeTab.workspaceIdentity : fallback;
  };
  const strict = ensureTaskNavigationWorkspace({
    workspacePath,
    workspaceIdentity,
    activateTabByPath: deps.activateTabByPath,
    // 本地目录没有 tab 时的新建行为受 canOpenTab 约束，下面统一处理。
    addLocalWorkspaceTab: (path) => {
      if (deps.canOpenTab) deps.addTab(path);
    },
  });
  if (strict.accepted) {
    return deps.canOpenTab || !strict.openedLocalTab
      ? { workspaceIdentity: resolveIdentity(workspaceIdentity) }
      : null;
  }
  if (!deps.allowLocalFallback) return null;
  if (deps.activateTabByPath(workspacePath)) {
    return { workspaceIdentity: resolveIdentity(undefined) };
  }
  if (!deps.canOpenTab) return null;
  deps.addTab(workspacePath);
  return { workspaceIdentity: resolveIdentity(undefined) };
}

type NotificationTaskTarget = { workspacePath: string; workspaceIdentity?: string };
type NotificationTaskLookup = NotificationTaskTarget | "retry" | null;

/** 连接断线或目标服务暂不可用时的重试间隔；总时长仍受 NOTIFICATION_TASK_WAIT_MS 约束。 */
const NOTIFICATION_TASK_RETRY_MS = 400;

/** 为 workspace tab 选择任务查询服务；远程 tab 未连接时返回 null，由调用方等待重连。 */
function resolveNotificationLookupServices(
  tab:
    | Pick<WorkspaceTabState, "remoteSessionId" | "remoteTarget" | "workspaceIdentity">
    | undefined,
  baseServices: IServiceAccessor | null,
): IServiceAccessor | null {
  if (tab?.remoteSessionId) return getRemoteWorkspaceSession(tab.remoteSessionId)?.services ?? null;
  if (tab?.remoteTarget) return null;
  return baseServices;
}

/**
 * 向 Host 索引确认任务存在并取得真实归属。侧栏已迁到项目树，旧任务列表缓存恒为 null，
 * 只信 getTaskMeta：明确返回 null 才表示不存在，RPC 抛错交给调用方重试。
 * 独立 Web 的浏览器本地 tab 可能没有 canonical identity，带 identity 查不到时再按纯 path 查一次。
 */
async function lookupNotificationTask(
  services: IServiceAccessor,
  taskId: string,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  allowIdentityFallback: boolean,
): Promise<NotificationTaskTarget | null> {
  const query = (identity: string | undefined) =>
    services.zcodeTaskService.getTaskMeta({
      workspacePath,
      ...(identity ? { workspaceIdentity: identity } : {}),
      taskId,
    });
  let meta = await query(workspaceIdentity);
  let usedIdentity = workspaceIdentity;
  if (!meta && workspaceIdentity && allowIdentityFallback) {
    meta = await query(undefined);
    usedIdentity = undefined;
  }
  if (!meta) return null;
  const resolvedIdentity = meta.workspaceIdentity ?? usedIdentity;
  return {
    workspacePath: meta.workspacePath || workspacePath,
    ...(resolvedIdentity ? { workspaceIdentity: resolvedIdentity } : {}),
  };
}

/**
 * 定位通知任务所属 workspace。带 workspacePath 时直接验证该 workspace；
 * 旧桌面 IPC 只传 taskId，则遍历已打开的 workspace tab 逐个查询。
 */
async function locateNotificationTask(params: {
  taskId: string;
  context: NotificationTaskContext | undefined;
  tabs: WindowTabState[];
  baseServices: IServiceAccessor | null;
  allowIdentityFallback: boolean;
}): Promise<NotificationTaskLookup> {
  const { taskId, context, baseServices, allowIdentityFallback } = params;
  const workspaceTabs = params.tabs.filter(isWorkspaceTab);
  try {
    if (context?.workspacePath) {
      const targetPath = context.workspacePath;
      const targetIdentity = context.workspaceIdentity;
      // 同路径不同远端的 tab 不能互相借用连接；只有独立 Web 的本地 tab 允许忽略 identity。
      const tab =
        workspaceTabs.find(
          (candidate) =>
            candidate.workspacePath === targetPath &&
            (targetIdentity
              ? candidate.workspaceIdentity === targetIdentity
              : !candidate.workspaceIdentity),
        ) ??
        (allowIdentityFallback
          ? workspaceTabs.find(
              (candidate) =>
                candidate.workspacePath === targetPath &&
                !candidate.remoteSessionId &&
                !candidate.remoteTarget,
            )
          : undefined);
      const services = resolveNotificationLookupServices(tab, baseServices);
      if (!services) return "retry";
      return await lookupNotificationTask(
        services,
        taskId,
        targetPath,
        targetIdentity,
        allowIdentityFallback,
      );
    }
  } catch (error) {
    logger.warn("[Root] 通知任务查询失败，等待连接恢复后重试", { taskId, error });
    return "retry";
  }

  let needsRetry = false;
  for (const tab of workspaceTabs) {
    const services = resolveNotificationLookupServices(tab, baseServices);
    if (!services) {
      needsRetry = true;
      continue;
    }
    try {
      const found = await lookupNotificationTask(
        services,
        taskId,
        tab.workspacePath,
        tab.workspaceIdentity,
        false,
      );
      if (found) return found;
    } catch (error) {
      logger.warn("[Root] 遍历 workspace 查询通知任务失败", {
        taskId,
        workspacePath: tab.workspacePath,
        error,
      });
      needsRetry = true;
    }
  }
  return needsRetry ? "retry" : null;
}

/**
 * 冷启动深链带了 canonical workspaceIdentity，但浏览器已恢复的同路径本地 tab 没有 identity 时，
 * 沿用该本地 tab，避免 addTab 另开一个 identity tab（与 activateNotificationWorkspace 的回退一致）。
 */
function resolveBootstrapWorkspaceIdentity(
  tabs: WindowTabState[],
  workspacePath: string,
  workspaceIdentity: string | undefined,
  allowLocalFallback: boolean,
): string | undefined {
  if (!workspaceIdentity || !allowLocalFallback) return workspaceIdentity;
  const samePath = tabs.filter(isWorkspaceTab).filter((tab) => tab.workspacePath === workspacePath);
  if (samePath.some((tab) => tab.workspaceIdentity === workspaceIdentity)) return workspaceIdentity;
  return samePath.some((tab) => !tab.workspaceIdentity && !tab.remoteSessionId && !tab.remoteTarget)
    ? undefined
    : workspaceIdentity;
}

export function useRootPlatformEffects({
  initialWorkspaceAbsPath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  clientMode = "desktop-continuous",
  canBootstrapInitialWorkspace = true,
  addTab,
  setIsBootstrappingInitialWorkspace,
  platform,
  activateTabByPath,
  startDraftInWorkspace,
  startNewTaskFromActiveWorkspace,
  openWorkspace,
  openWorkspacePath,
  setWorkspaceActionError,
  allowOpenWorkspace = true,
  isDesktop,
  locale,
  localeResolved = true,
  tabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  reconnectingRemoteWorkspaceKeys = [],
  remoteWorkspaceErrorByWorkspaceKey = {},
  webRemoteControlFeatureEnabled = false,
  hasCompletedFullTabRestore = true,
  intl,
  isRestoringOAuthSession,
}: {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  initialTaskId?: string;
  initialTaskDraft?: CreateTaskOptions;
  clientMode?: ZCodeTaskClientMode;
  canBootstrapInitialWorkspace?: boolean;
  addTab: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
  ) => void;
  setIsBootstrappingInitialWorkspace: (value: boolean) => void;
  platform: IPlatformService;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  startDraftInWorkspace: (
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CreateTaskOptions,
  ) => void;
  startNewTaskFromActiveWorkspace: (source: string) => void;
  openWorkspace: () => void;
  openWorkspacePath: (workspacePath: string, activateOtherWindow?: boolean) => void | Promise<void>;
  setWorkspaceActionError: (message: string | null) => void;
  allowOpenWorkspace?: boolean;
  isDesktop?: boolean;
  locale: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["locale"];
  /** IntlProvider 是否已从持久化设置确定语言；未确定前 locale 只是占位初值。 */
  localeResolved?: boolean;
  tabs: WindowTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
  webRemoteControlFeatureEnabled?: boolean;
  hasCompletedFullTabRestore?: boolean;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  isRestoringOAuthSession: boolean;
}) {
  const didBootstrapInitialWorkspaceRef = useRef(false);
  const baseServices = useOptionalBaseWorkspaceServices();
  const pendingShareImportRef = useRef<ShareImportIntent | null>(null);
  const [shareImportRevision, setShareImportRevision] = useState(0);
  const composerClientNamespace = useComposerClientNamespace();
  const activeShareImportRef = useRef<ShareImportIntent | null>(null);
  const importOperationRef = useRef<string | null>(null);
  const lastImportProgressToastRef = useRef<{ phase: string; at: number } | null>(null);
  const importToastIdRef = useRef<number | null>(null);
  // 进行中的通知点击流程的取消函数；独立于平台监听 effect，避免 tabs 变化时被提前取消。
  const pendingNotificationWaitRef = useRef<(() => void) | null>(null);
  // 唤醒正在等待就绪或连接恢复的通知点击流程。
  const wakeNotificationWaitRef = useRef<(() => void) | null>(null);
  const tabStoreApi = useTabStoreApi();
  // 初始 workspace 注入（含 openWorkspacePath 异步分支）是否已结束；通知点击要等它结束再改 tab。
  const bootstrapSettledRef = useRef(false);
  // 通知点击回调只在平台监听 effect 里注册一次，这里用 ref 读取最新的 tab 恢复状态与服务。
  const notificationEnvRef = useRef({
    addTab,
    hasCompletedFullTabRestore,
    isDesktop,
    baseServices,
  });
  notificationEnvRef.current = { addTab, hasCompletedFullTabRestore, isDesktop, baseServices };
  useEffect(() => {
    // 历史 tab 恢复完成后，等待中的通知目标可以开始解析与新建 tab。
    if (hasCompletedFullTabRestore) wakeNotificationWaitRef.current?.();
  }, [hasCompletedFullTabRestore]);
  const settleInitialBootstrap = useCallback(() => {
    bootstrapSettledRef.current = true;
    setIsBootstrappingInitialWorkspace(false);
    wakeNotificationWaitRef.current?.();
  }, [setIsBootstrappingInitialWorkspace]);

  useEffect(
    () => () => {
      pendingNotificationWaitRef.current?.();
      pendingNotificationWaitRef.current = null;
    },
    [],
  );

  useEffect(() => {
    // 启动时必须先判断 OAuth 本地会话，再恢复历史/初始 workspace。
    // 如果这里抢先 addTab，未登录用户会先看到主界面，之后才被登录页覆盖。
    if (!canBootstrapInitialWorkspace || didBootstrapInitialWorkspaceRef.current) {
      return;
    }

    didBootstrapInitialWorkspaceRef.current = true;
    if (
      isDesktop &&
      initialWorkspaceAbsPath &&
      initialWorkspacePurpose === "project" &&
      clientMode === "desktop-continuous" &&
      !initialWorkspaceIdentity &&
      !initialTaskId &&
      !initialTaskDraft &&
      !isRendererReloadNavigation()
    ) {
      // 冷启动的 project 标记只描述 tab，不能代替草稿 projectId；与运行中系统目录
      // 入口共用 Host 项目接纳，完成前保留启动屏障，避免空归属草稿先被预热。
      void Promise.resolve(openWorkspacePath(initialWorkspaceAbsPath)).finally(
        settleInitialBootstrap,
      );
      return;
    }
    if (initialWorkspaceAbsPath) {
      const savedScope = readComposerWorkspaceScope(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity,
        composerClientNamespace,
      );
      // 手机重建 Root 时 bridge 只有地址；项目意图随已有浏览器草稿恢复，先于 prewarm。
      const savedDraft =
        clientMode === "web-remote-replayable" && !initialTaskId && !initialTaskDraft
          ? readV4ComposerDraft(
              initialWorkspaceAbsPath,
              initialWorkspaceIdentity,
              V4_DRAFT_SCOPE_ROOT,
              savedScope,
            )
          : null;
      const draftIntent =
        initialTaskDraft ??
        (savedScope
          ? { projectId: savedScope.projectId, taskGroupId: savedDraft?.taskGroupId }
          : undefined) ??
        (savedDraft?.projectId !== undefined
          ? { projectId: savedDraft.projectId, taskGroupId: savedDraft.taskGroupId }
          : undefined);
      // 通知深链冷启动：浏览器已恢复同路径的本地 tab 时沿用它，不另开 identity tab。
      const bootstrapIdentity = initialTaskId
        ? resolveBootstrapWorkspaceIdentity(
            tabStoreApi.getState().tabs,
            initialWorkspaceAbsPath,
            initialWorkspaceIdentity,
            !isDesktop && Boolean(platform.setWebPushSubscribed),
          )
        : initialWorkspaceIdentity;
      addTab(
        initialWorkspaceAbsPath,
        bootstrapIdentity || initialWorkspacePurpose
          ? {
              ...(bootstrapIdentity ? { workspaceIdentity: bootstrapIdentity } : {}),
              ...(initialWorkspacePurpose ? { workspacePurpose: initialWorkspacePurpose } : {}),
            }
          : undefined,
      );
      if (initialTaskId) {
        // setActiveTaskId 自身会发布“已查看”事实，侧栏未读标记随之清除。
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(initialWorkspaceAbsPath, initialTaskId, bootstrapIdentity);
      } else if (draftIntent || !isRendererReloadNavigation()) {
        // 修复原因：main 注入 initial workspace 只表达工作区入口；没有显式 taskId
        // 的 app 冷启动必须进入草稿，不能让 renderer-local last-session/group/pane
        // 抢回历史会话；同一 renderer reload 则保留当前 session 续流资格。
        startDraftInWorkspace(initialWorkspaceAbsPath, initialWorkspaceIdentity, draftIntent);
      }
    }
    // Dock 最近项目会通过 initialWorkspaceAbsPath 直达工作区。
    // 如果这里仍然等首屏先按默认空 tab 渲染一次，窗口会先闪出打开工作区中间页，
    // 再异步补上目标 workspace，视觉上像是“打开错页再跳转”。
    // 这里把初始工作区注入也纳入启动保护期，等首个 tab 准备好后再渲染正式内容。
    settleInitialBootstrap();
  }, [
    addTab,
    openWorkspacePath,
    isDesktop,
    canBootstrapInitialWorkspace,
    initialTaskId,
    initialTaskDraft,
    composerClientNamespace,
    clientMode,
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    platform,
    settleInitialBootstrap,
    startDraftInWorkspace,
    tabStoreApi,
  ]);

  useEffect(() => {
    const disposeFocusTab = platform.onFocusTab((path: string) => {
      logger.info("[Root] onFocusTab:", path);
      // 跨窗口打开由目标窗口完成项目接纳，避免只激活目录后留下未归类草稿。
      void openWorkspacePath(path, false);
    });
    const disposeNewTab = platform.onNewTab(() => {
      logger.info("[Root] onNewTab");
      setWorkspaceActionError(null);
      // 新标签过去会打开工作区中间页，导致启动/快捷键都可能进入中间页。
      // 现在新标签语义收敛为“打开工作区”动作，由 Root 决定目录选择或默认 workspace 兜底。
      openWorkspace();
    });
    // 新建回调包含当前语言；同步更新订阅，避免快捷键展示切换语言前的错误提示。
    const disposeNewTask = platform.onNewTask(() => {
      startNewTaskFromActiveWorkspace("onNewTask");
    });
    const disposeOpenWorkspace = platform.onOpenWorkspace(() => {
      logger.info("[Root] onOpenWorkspace");
      openWorkspace();
    });
    const disposeOpenWorkspacePath = platform.onOpenWorkspacePath
      ? platform.onOpenWorkspacePath((path: string) => {
          if (!allowOpenWorkspace) {
            logger.info("[Root] 当前模式不支持通过 deep link 打开文件夹，已忽略请求");
            return;
          }

          logger.info("[Root] onOpenWorkspacePath:", path);
          // 系统服务 deep link 对应输入框上方 Open folder 语义。
          // 这里复用 handleSelectProject，而不是把路径作为聊天附件，才能保留 tab 去重、
          // 跨窗口激活和 recentProjects 更新这些手动打开文件夹的既有行为。
          openWorkspacePath(path);
        })
      : () => {};
    const disposeShareImport = platform.onShareImport
      ? platform.onShareImport((payload) => {
          const current = pendingShareImportRef.current ?? activeShareImportRef.current;
          if (current && isShareImportIntentSame(current, payload)) {
            logger.info("[Root] 忽略重复的 share import deep link", {
              shareCodeLength: payload.shareCode.length,
            });
            return;
          }
          const activeTab = tabs.find(
            (tab): tab is Extract<WindowTabState, { kind: "workspace" }> =>
              tab.kind === "workspace" &&
              tab.workspacePath === activeWorkspacePath &&
              (activeWorkspaceIdentity
                ? tab.workspaceIdentity === activeWorkspaceIdentity
                : !tab.workspaceIdentity),
          );
          pendingShareImportRef.current = createShareImportIntent(payload.shareCode, undefined, {
            ...(activeWorkspacePath ? { targetWorkspacePath: activeWorkspacePath } : {}),
            ...(activeWorkspaceIdentity
              ? { targetWorkspaceIdentity: activeWorkspaceIdentity }
              : {}),
            targetWorkspaceKind:
              activeTab?.remoteSessionId || activeTab?.remoteTarget ? "remote" : "local",
          });
          setShareImportRevision((revision) => revision + 1);
          logger.info("[Root] 收到 share import deep link", {
            shareCodeLength: payload.shareCode.length,
          });
        })
      : () => {};
    const disposeNotificationClick = platform.onTaskNotificationClick(
      (taskId: string, context?: NotificationTaskContext) => {
        logger.info("[Root] onTaskNotificationClick:", taskId);
        pendingNotificationWaitRef.current?.();
        const run = { cancelled: false };
        const cancel = () => {
          run.cancelled = true;
          wakeNotificationWaitRef.current?.();
        };
        pendingNotificationWaitRef.current = cancel;
        const deadline = Date.now() + NOTIFICATION_TASK_WAIT_MS;
        const isReady = () =>
          bootstrapSettledRef.current && notificationEnvRef.current.hasCompletedFullTabRestore;
        // 可被就绪/重连事件提前唤醒的等待，且不会越过总超时。
        const wait = (ms: number) =>
          new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              if (wakeNotificationWaitRef.current === finish)
                wakeNotificationWaitRef.current = null;
              resolve();
            };
            const timer = setTimeout(finish, Math.max(0, Math.min(ms, deadline - Date.now())));
            wakeNotificationWaitRef.current = finish;
          });
        const fail = (reason: string) => {
          logger.warn(`[Root] onTaskNotificationClick: ${reason}:`, taskId);
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
        };

        void (async () => {
          try {
            // 冷启动时历史 tab 与初始 workspace 可能还没就绪，此时 addTab 会被随后的 restoreTabs 覆盖。
            while (!isReady()) {
              if (run.cancelled) return;
              if (Date.now() >= deadline) return fail("workspace not ready");
              await wait(deadline - Date.now());
            }
            let located: NotificationTaskLookup = "retry";
            while (!run.cancelled) {
              const env = notificationEnvRef.current;
              located = await locateNotificationTask({
                taskId,
                context,
                tabs: tabStoreApi.getState().tabs,
                baseServices: env.baseServices,
                allowIdentityFallback: !env.isDesktop && Boolean(platform.setWebPushSubscribed),
              });
              if (located !== "retry" || Date.now() >= deadline) break;
              // 连接断线重连时 RPC 会暂时抛错，等待恢复而不是判定任务不存在。
              await wait(NOTIFICATION_TASK_RETRY_MS);
            }
            if (run.cancelled) return;
            if (!located || located === "retry") {
              return fail(
                located === "retry" ? "task lookup timed out" : "task not found in any workspace",
              );
            }
            const env = notificationEnvRef.current;
            const activated = activateNotificationWorkspace(
              located.workspacePath,
              located.workspaceIdentity,
              {
                activateTabByPath,
                addTab: (workspacePath) => env.addTab(workspacePath),
                getActiveWorkspaceTab: () => {
                  const { tabs: currentTabs, activeTabId: currentActiveTabId } =
                    tabStoreApi.getState();
                  const active = currentTabs.find((tab) => tab.id === currentActiveTabId);
                  return active && isWorkspaceTab(active) ? active : undefined;
                },
                allowLocalFallback: !env.isDesktop && Boolean(platform.setWebPushSubscribed),
                canOpenTab: env.hasCompletedFullTabRestore,
              },
            );
            if (!activated) return fail("workspace unavailable");
            // 与侧栏点击任务同一条路径：分屏同步、退出自动化/插件页、选中并清未读，窄屏切入 Chat。
            requestNotificationTaskNavigation({
              workspacePath: located.workspacePath,
              ...(activated.workspaceIdentity
                ? { workspaceIdentity: activated.workspaceIdentity }
                : {}),
              taskId,
              revealChat: true,
            });
          } catch (error) {
            logger.warn("[Root] onTaskNotificationClick failed", { taskId, error });
            if (!run.cancelled)
              toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          } finally {
            if (pendingNotificationWaitRef.current === cancel) {
              pendingNotificationWaitRef.current = null;
            }
          }
        })();
      },
    );
    const disposeUpdateCheckResult = platform.onUpdateCheckResult
      ? platform.onUpdateCheckResult((payload) => {
          logger.info("[Root] onUpdateCheckResult:", payload.kind);
          switch (payload.kind) {
            case "up-to-date":
              toast(
                intl.formatMessage(
                  { id: "update.toast.upToDate" },
                  { version: payload.currentVersion },
                ),
              );
              return;
            case "downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.downloading" },
                  { version: payload.version },
                ),
              );
              return;
            case "available":
              toast(
                intl.formatMessage({ id: "update.toast.available" }, { version: payload.version }),
              );
              return;
            case "already-downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.alreadyDownloading" },
                  { progress: payload.progress },
                ),
              );
              return;
            case "ready":
              toast(intl.formatMessage({ id: "update.toast.ready" }, { version: payload.version }));
              return;
            case "dev-skipped":
              toast(intl.formatMessage({ id: "update.toast.devSkipped" }));
              return;
            case "error":
              toast(intl.formatMessage({ id: "update.toast.error" }, { error: payload.message }));
              return;
          }
        })
      : () => {};
    return () => {
      disposeFocusTab();
      disposeNewTab();
      disposeNewTask();
      disposeOpenWorkspace();
      disposeOpenWorkspacePath();
      disposeShareImport();
      disposeNotificationClick();
      disposeUpdateCheckResult();
    };
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    platform,
    startNewTaskFromActiveWorkspace,
    tabStoreApi,
    tabs,
  ]);

  useEffect(() => {
    const pending = pendingShareImportRef.current;
    if (!pending || !baseServices || activeShareImportRef.current || importOperationRef.current) {
      return;
    }
    if (isRestoringOAuthSession) {
      return;
    }

    // 分享页 Deep Link 不应在 Root 层按登录态分叉；未登录与已登录都
    // 走同一份 continuation/import 流程。公开可导入分享由接口自身决定是否可用。
    pending.status = "importing";
    pendingShareImportRef.current = null;
    activeShareImportRef.current = pending;
    if (importToastIdRef.current !== null) {
      dismissToast(importToastIdRef.current);
      importToastIdRef.current = null;
    }
    const operationId = `share-import-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    importOperationRef.current = operationId;
    lastImportProgressToastRef.current = null;
    const progressEvent =
      baseServices.conversationShareService.onDynamicImportProgress(operationId);
    const disposeProgress = progressEvent((progress) => {
      const now = Date.now();
      const last = lastImportProgressToastRef.current;
      if (
        last &&
        last.phase === progress.phase &&
        now - last.at < 800 &&
        progress.phase !== "complete"
      ) {
        return;
      }
      // complete 只表示导入事务已经收口；成功结果会在下方统一替换进度提示，避免短暂闪过
      // “导入完成”后又紧接着出现“已从分享导入”的两条成功 Toast。
      if (progress.phase === "complete") {
        return;
      }
      lastImportProgressToastRef.current = { phase: progress.phase, at: now };
      const label =
        progress.phase === "downloading"
          ? intl.formatMessage(
              { id: "conversationShare.import.downloading" },
              { completed: progress.completedArtifacts, total: progress.totalArtifacts },
            )
          : progress.phase === "installing"
            ? intl.formatMessage({ id: "conversationShare.import.installing" })
            : intl.formatMessage({ id: "conversationShare.import.committing" });
      if (importToastIdRef.current === null) {
        importToastIdRef.current = toast(label, { durationMs: 0, variant: "info" });
      } else {
        updateToast(importToastIdRef.current, {
          message: label,
          durationMs: 0,
          variant: "info",
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        });
      }
    });

    void baseServices.conversationShareService
      .importShare(
        {
          shareCode: pending.shareCode,
          clientRequestId: pending.clientRequestId,
          ...(pending.targetWorkspacePath
            ? { targetWorkspacePath: pending.targetWorkspacePath }
            : {}),
          ...(pending.targetWorkspaceIdentity
            ? { targetWorkspaceIdentity: pending.targetWorkspaceIdentity }
            : {}),
          ...(pending.targetWorkspaceKind
            ? { targetWorkspaceKind: pending.targetWorkspaceKind }
            : {}),
          locale,
        },
        operationId,
      )
      .then((result) => {
        pending.status = "complete";
        // 先准备实际落地工作区的独立草稿，再激活；复用导入不覆盖会话选择。
        const composerConfig = resolveImportedComposerConfig(result, composerClientNamespace);
        const activated = activateTabByPath(
          result.workspacePath,
          result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : undefined,
        );
        if (!activated) {
          addTab(result.workspacePath, {
            ...(result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : {}),
            workspacePurpose: "conversation",
          });
        }
        const sessionStore = useZCodeSessionStore.getState();
        sessionStore.setActiveTaskId(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
          composerConfig,
        );
        // 导入可能复用当前已打开的 session；仅 setActiveTaskId 不会产生可观察的切换。
        // 每次成功都显式发出一次定位请求，目标 pane 准备好分享内容后再消费。
        sessionStore.requestTimelineBottom(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
        );
        // 回退过的导入会落在与用户当前所看不同的 workspace，必须讲清落在哪、为何回退，
        // 否则用户只会看到会话“跑到别处去了”。
        const resultMessage = result.fallbackReason
          ? intl.formatMessage(
              {
                id:
                  result.fallbackReason === "remote_workspace"
                    ? "conversationShare.import.fallbackRemoteWorkspace"
                    : "conversationShare.import.fallbackDefaultWorkspace",
              },
              { title: result.title, workspacePath: result.workspacePath },
            )
          : intl.formatMessage({ id: "conversationShare.import.source" }, { title: result.title });
        const resultToastOptions = {
          durationMs: result.fallbackReason ? 7000 : 3000,
          variant: result.fallbackReason ? ("info" as const) : ("default" as const),
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(resultMessage, resultToastOptions);
        } else {
          updateToast(importToastIdRef.current, { message: resultMessage, ...resultToastOptions });
        }
      })
      .catch((error) => {
        pending.status = "failed";
        const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const kind = typeof record.kind === "string" ? record.kind : "unknown";
        const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : undefined;
        const firstIssue = Array.isArray(record.issues) ? record.issues[0] : undefined;
        const firstIssueRecord =
          firstIssue && typeof firstIssue === "object" && !Array.isArray(firstIssue)
            ? (firstIssue as Record<string, unknown>)
            : undefined;
        const artifactDisplayName =
          typeof firstIssueRecord?.artifactDisplayName === "string"
            ? firstIssueRecord.artifactDisplayName
            : undefined;
        const diagnostics = getConversationShareErrorDetails(error);
        logger.warn("[Root] share import failed", {
          status: diagnostics.status,
          code: diagnostics.code,
          requestId: diagnostics.requestId,
          operationId,
          clientRequestId: pending.clientRequestId,
          kind,
          ...(reasonCode ? { reasonCode } : {}),
          ...(typeof record.issueCount === "number" ? { issueCount: record.issueCount } : {}),
        });
        const failurePresentation = resolveShareImportFailurePresentation(kind);
        const retryImport = () => {
          pending.status = "received";
          pendingShareImportRef.current = pending;
          setShareImportRevision((revision) => revision + 1);
        };
        const detailedMessageId =
          artifactDisplayName && kind === "invalid_contract"
            ? "conversationShare.import.integrityFailedWithArtifact"
            : artifactDisplayName && kind === "network"
              ? "conversationShare.import.failedWithArtifact"
              : failurePresentation.messageId;
        const failureMessage = intl.formatMessage(
          { id: detailedMessageId },
          artifactDisplayName ? { artifactDisplayName } : undefined,
        );
        const failureToastOptions = {
          durationMs: 7000,
          ...(failurePresentation.retryable
            ? {
                actionLabel: intl.formatMessage({ id: "conversationShare.import.retry" }),
                onAction: retryImport,
              }
            : {}),
          dismissible: true,
          variant: "default" as const,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(failureMessage, failureToastOptions);
        } else {
          updateToast(importToastIdRef.current, {
            message: failureMessage,
            ...failureToastOptions,
          });
        }
      })
      .finally(() => {
        disposeProgress.dispose();
        activeShareImportRef.current = null;
        importOperationRef.current = null;
        setShareImportRevision((revision) => revision + 1);
      });
  }, [
    activateTabByPath,
    addTab,
    baseServices,
    intl,
    isRestoringOAuthSession,
    locale,
    shareImportRevision,
    composerClientNamespace,
  ]);

  useEffect(() => {
    if (!isDesktop || !shouldPublishCompleteWorkspaceSnapshot(hasCompletedFullTabRestore)) {
      return;
    }

    const paths = tabs
      .filter(isWorkspaceTab)
      // 启动期远程 workspace 现在会先以“断开占位 tab”恢复，
      // 这些 tab 没有 remoteSessionId，但本质仍是远程会话，不能当成本地路径同步给主进程窗口列表。
      // 这里改成按完整远程身份字段过滤，避免把远程路径误同步到本地窗口标签。
      .filter((tab) => !tab.remoteSessionId && !tab.workspaceIdentity && !tab.remoteTarget)
      .map((tab) => tab.workspacePath);
    platform.syncWindowTabs(paths);
  }, [hasCompletedFullTabRestore, isDesktop, platform, tabs]);

  const activeTab = useTabStore((state: TabStoreState) => {
    const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    return tab && isWorkspaceTab(tab) ? tab : undefined;
  });
  const viewingWorkspacePath = activeTab?.workspacePath;
  const viewingWorkspaceIdentity = activeTab?.workspaceIdentity;

  useEffect(() => {
    if (isDesktop || !shouldPublishCompleteWorkspaceSnapshot(hasCompletedFullTabRestore)) {
      return;
    }
    // activeWorkspacePath 保留最近的工作区。设置页等非工作区标签必须以上报空首项表示。
    platform.syncWindowTabs([
      viewingWorkspacePath ?? "",
      ...new Set(tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath)),
    ]);
  }, [viewingWorkspacePath, hasCompletedFullTabRestore, isDesktop, platform, tabs]);

  useWebRemoteControlWorkspaceSync({
    platform,
    tabs,
    isDesktop: Boolean(isDesktop),
    featureEnabled: webRemoteControlFeatureEnabled,
    hasCompletedFullTabRestore,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
  });

  useEffect(() => {
    if (isDesktop) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占。本监听先于录制监听注册（同 capture 阶段），
      // 不短路的话录制期按 Cmd/Ctrl+N、O 预览会真实触发新建任务/打开工作区。
      if (isShortcutRecordingActive()) {
        return;
      }
      const isNewTaskShortcut = matchesPrimaryShortcut(event, "n");
      const isOpenWorkspaceShortcut = matchesPrimaryShortcut(event, "o");

      if (!isNewTaskShortcut && !isOpenWorkspaceShortcut) {
        return;
      }

      // Web 端没有宿主菜单，补一层 best-effort 键盘监听，按平台主修饰键落到同一套根级动作。
      // 耦合说明：这里固定使用默认键位（Ctrl/Cmd+N、+O），与「menu 通道命令在 Web 端不可配置」
      // （设置页置灰）配套——若未来放开 Web 端 menu 通道改键，
      // 此处必须改为读快捷键生效表，否则用户改键后 Web 行为会分裂。
      event.preventDefault();
      if (isOpenWorkspaceShortcut) {
        openWorkspace();
        return;
      }

      startNewTaskFromActiveWorkspace("web CmdOrCtrl+N");
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [isDesktop, openWorkspace, startNewTaskFromActiveWorkspace]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }
    // 冷启动竞态修复：IntlProvider 读完 setting.json 之前，locale 只是占位初值（无本地偏好时按
    // navigator 系统语言，中文系统即 zh-CN）。以前这里一挂载就把占位值推给 Main，Main 再广播给
    // Host，导致 UI 选 ja/ru/ko 的用户冷启动后几秒内遥测、client/configs、marketing/touch、
    // getCustomerInfo 等请求带 X-Client-Language=zh-CN。Main 启动时已从 setting.json 同步拿到
    // 真实语言，所以这里必须等语言确定后再同步，不能用占位值覆盖。
    if (!localeResolved) {
      return;
    }

    let disposed = false;

    // 原生菜单文案之前在 main 进程里写死，renderer 切换 locale 只会更新 React 标题栏菜单。
    // 结果就是桌面端会同时出现两套语言，Help 里的反馈/导出日志也无法跟随当前语言切换。
    // 这里把当前 locale 主动同步给 main，让原生菜单和标题栏菜单都从同一份语言状态重建。
    platform.setApplicationLocale(locale).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] 同步应用菜单语言失败", { locale, error });
    });

    return () => {
      disposed = true;
    };
  }, [isDesktop, locale, localeResolved, platform]);

  const lastSyncedSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // 桌面端交给 Main 做 PiP 聚焦；Web 端交给通知控制器，按任务精确判断是否正在被查看。
    const syncActiveSession = (): void => {
      // 设置页等非 workspace tab 时 workspacePath 为空，已上报 null；手机窄屏停在 Home 列表时
      // 聊天区未显示，同样上报 null，让通知照常展示。
      const nextSessionId =
        viewingWorkspacePath && !isWebRemoteControlMobileHomeListVisible()
          ? (useZCodeSessionStore
              .getState()
              .getWorkspaceState(viewingWorkspacePath, viewingWorkspaceIdentity).activeTaskId ??
            null)
          : null;
      if (nextSessionId === lastSyncedSessionIdRef.current) return;
      lastSyncedSessionIdRef.current = nextSessionId;
      platform.syncActiveTaskSession(nextSessionId);
    };
    syncActiveSession();
    const unsubscribeSession = useZCodeSessionStore.subscribe(syncActiveSession);
    const unsubscribeMobileHome =
      subscribeWebRemoteControlMobileHomeListVisibility(syncActiveSession);
    return () => {
      unsubscribeSession();
      unsubscribeMobileHome();
    };
  }, [viewingWorkspacePath, viewingWorkspaceIdentity, platform]);
}
