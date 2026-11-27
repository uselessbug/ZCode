/**
 * useTabPersistence —— 标签页持久化
 *
 * - mount 时从 settingService 恢复上次打开的标签页
 * - 订阅 tab store 变化，debounce 写回 settingService
 */
import { useEffect, useRef } from "react";
import { useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { useTabStoreApi } from "../store/TabStoreProvider.js";
import { isWorkspaceTab, type TabStoreState } from "../store/tabStore.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 300;

export interface TabPersistenceRestoreLifecycle {
  settingService?: ISettingService;
  restoreSession: boolean;
  completed: boolean;
  fullyCompleted: boolean;
}

/**
 * 活动目录选择的写回门禁。
 *
 * 这个对象由 Root 在本地窗口内共享给远程 session 流程：恢复未完成或失败时，
 * 远程连接状态变化只能更新内存，不能把半份 tab 快照写回全局 settings。
 */
export interface WorkspacePersistenceGate {
  canPersist: boolean;
  restoreFailed: boolean;
  onCanPersist?: () => void | Promise<void>;
}

function openWorkspacePersistenceGate(
  persistenceGate: WorkspacePersistenceGate | undefined,
  persistSession: boolean,
): void {
  if (!persistenceGate) return;
  persistenceGate.canPersist = Boolean(persistSession);
  if (persistenceGate.canPersist) {
    void persistenceGate.onCanPersist?.();
  }
}

export interface TabPersistenceRestoreResult {
  /** 恢复期间识别出的 app-owned 路径，不得回填为最近项目。 */
  excludedRecentProjectPaths?: readonly string[];
  /** active workspace 已恢复后，在首帧后的 idle period 补齐 inactive workspace。 */
  deferredRestore?: () => void;
}

function scheduleDeferredRestore(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const idleCallbackId = globalThis.requestIdleCallback(() => callback(), {
      timeout: 1_000,
    });
    return () => globalThis.cancelIdleCallback(idleCallbackId);
  }

  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

export function hasCompletedTabPersistenceInitialRestore({
  settingService,
  restoreSession,
  restoreLifecycle,
}: {
  settingService?: ISettingService;
  restoreSession: boolean;
  restoreLifecycle: TabPersistenceRestoreLifecycle;
}): boolean {
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  return (
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.completed)
  );
}

function buildDefaultPersistPatch(state: TabStoreState): Partial<AppSettings> {
  const tab = state.tabs
    .filter(isWorkspaceTab)
    .find(
      (candidate) =>
        (candidate.workspaceIdentity?.trim() || candidate.workspacePath) ===
        (state.activeWorkspaceIdentity?.trim() || state.activeWorkspacePath),
    );
  if (tab?.workspaceIdentity || tab?.remoteSessionId) return {};
  return {
    lastActiveWorkspace: tab
      ? {
          kind: "local",
          workspacePath: tab.workspacePath,
          ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
        }
      : null,
  };
}

export function useTabPersistence({
  settingService,
  restoreSession = true,
  persistSession = restoreSession,
  persistenceGate,
  restorePersistedSession,
  buildPersistPatch,
}: {
  settingService?: ISettingService;
  /** 是否恢复上次会话，首个窗口 true，新窗口 false */
  restoreSession?: boolean;
  /** 是否把当前窗口会话写回全局设置，首个窗口 true，新窗口 false */
  persistSession?: boolean;
  /** 与远程 session 流程共享的活动目录写回门禁。 */
  persistenceGate?: WorkspacePersistenceGate;
  /** 自定义恢复流程；不传则回退到原来的本地 tab 恢复逻辑 */
  restorePersistedSession?: (
    settings: AppSettings,
  ) => Promise<TabPersistenceRestoreResult | void> | TabPersistenceRestoreResult | void;
  /** 自定义持久化补丁；不传则只写回本地 workspace 会话 */
  buildPersistPatch?: (state: TabStoreState, settings: AppSettings) => Partial<AppSettings>;
}) {
  const store = useTabStoreApi();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  const initialRestoreFullyCompletedRef = useRef(!shouldRestoreSession);
  const [restoreLifecycle, setRestoreLifecycle] = useState<TabPersistenceRestoreLifecycle>(() => ({
    settingService,
    restoreSession,
    completed: !shouldRestoreSession,
    fullyCompleted: !shouldRestoreSession,
  }));
  // 只读镜像：恢复 effect 需要判断“同一 Host 是否已完整恢复”，但 restoreLifecycle 不能进
  // 依赖数组 —— 每次 setRestoreLifecycle 都会换引用，会让恢复 effect 变成自触发循环，
  // 还会打断 deferred inactive 的补齐。这里仅在 render 时镜像，effect 里读取当前值。
  const restoreLifecycleRef = useRef(restoreLifecycle);
  restoreLifecycleRef.current = restoreLifecycle;
  // provider/OAuth gate 从 false 切到 true 的同一轮 render 里，
  // 恢复会话 effect 还没来得及把 isRestoring 设为 true。这里把完成态绑定到
  // 当前 settingService + restoreSession，避免 initialWorkspacePath 抢在 restoreTabs 前 addTab。
  const hasCompletedInitialRestore = hasCompletedTabPersistenceInitialRestore({
    settingService,
    restoreSession,
    restoreLifecycle,
  });
  const hasCompletedFullRestore =
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.fullyCompleted);
  const isRestoring = shouldRestoreSession && !hasCompletedInitialRestore;

  // 恢复会话
  useEffect(() => {
    if (!settingService || !restoreSession) {
      initialRestoreFullyCompletedRef.current = true;
      openWorkspacePersistenceGate(persistenceGate, persistSession);
      setRestoreLifecycle({
        settingService,
        restoreSession,
        completed: true,
        fullyCompleted: true,
      });
      return;
    }

    let cancelled = false;
    let cancelDeferredRestore: (() => void) | null = null;

    // Bugfix: Root 的 restorePersistedSession 依赖 services.fileService，独立 Web 重连后
    // fresh services 会让该 callback 换引用，从而让本 effect 重跑。若同一 Host 的首次恢复
    // 已经真正完整成功（initialRestoreFullyCompletedRef 只在成功/补齐后置 true），就不能再
    // 从磁盘 restoreTabs 覆盖当前 tabs —— 否则用户已打开的 settings tab 会被清掉、切回工作台。
    // 这里只按 persistSession 同步写回门禁，不重置恢复中/完成态，避免出现第二个事实源。
    // 失败（ref 保持 false）或 deferred inactive 尚未补齐时不会命中此分支，callback 变化仍可重试；
    // 真实 settingService 换实例（Host 变更）或 restoreSession false→true 时 lifecycle 目标不一致，
    // 也不会命中，保持必须恢复的语义。
    if (
      initialRestoreFullyCompletedRef.current &&
      hasCompletedTabPersistenceInitialRestore({
        settingService,
        restoreSession,
        restoreLifecycle: restoreLifecycleRef.current,
      })
    ) {
      openWorkspacePersistenceGate(persistenceGate, persistSession);
      return;
    }

    initialRestoreFullyCompletedRef.current = false;
    if (persistenceGate) {
      persistenceGate.canPersist = false;
      persistenceGate.restoreFailed = false;
    }
    // Bugfix: Root 首屏会先按 tab store 的默认空状态渲染打开工作区中间页，
    // 随后这里再异步恢复 lastWorkspaceSession，导致主界面启动时闪一下“打开项目”。
    // 这里显式暴露恢复中的状态，让外层在会话检查完成前持续显示 loading，
    // 避免把“默认空态”误展示给用户。
    setRestoreLifecycle({
      settingService,
      restoreSession,
      completed: false,
      fullyCompleted: false,
    });

    settingService
      .get()
      .then(async (settings) => {
        let restoreResult: TabPersistenceRestoreResult | void = undefined;
        if (restorePersistedSession) {
          restoreResult = await restorePersistedSession(settings);
        } else {
          const tabs = readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
            entry.kind === "local"
              ? [
                  entry.workspacePurpose
                    ? {
                        workspacePath: entry.workspacePath,
                        workspacePurpose: entry.workspacePurpose,
                      }
                    : entry.workspacePath,
                ]
              : [],
          );
          const activeIndex = settings.lastActiveTabIndex ?? 0;
          if (tabs.length > 0) {
            logger.info("[useTabPersistence] 恢复标签页:", tabs);
            store.getState().restoreTabs(tabs, activeIndex);
          }
        }

        if (!cancelled) {
          const deferredRestore = restoreResult?.deferredRestore;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: !deferredRestore,
          });
          if (deferredRestore) {
            cancelDeferredRestore = scheduleDeferredRestore(() => {
              if (cancelled) {
                return;
              }
              // active-only 是启动瞬态，不能提前持久化；补齐合并产生的 store event
              // 才是首个允许写回的完整 session snapshot。
              initialRestoreFullyCompletedRef.current = true;
              openWorkspacePersistenceGate(persistenceGate, persistSession);
              try {
                deferredRestore();
              } catch (error) {
                logger.error("[useTabPersistence] 补齐 inactive workspace 失败:", error);
              } finally {
                if (!cancelled) {
                  setRestoreLifecycle({
                    settingService,
                    restoreSession,
                    completed: true,
                    fullyCompleted: true,
                  });
                }
              }
            });
          } else {
            initialRestoreFullyCompletedRef.current = true;
            openWorkspacePersistenceGate(persistenceGate, persistSession);
          }
        }
      })
      .catch((err) => {
        logger.error("[useTabPersistence] 恢复标签页失败:", err);
        if (!cancelled) {
          // 恢复失败时必须 fail-closed；当前 renderer 的 tabs 不是磁盘快照的完整替代品。
          // 只停止 loading，不允许后续远程断连/关闭事件覆盖 setting.json。
          initialRestoreFullyCompletedRef.current = false;
          if (persistenceGate) {
            persistenceGate.canPersist = false;
            persistenceGate.restoreFailed = true;
          }
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: true,
          });
        }
      });

    return () => {
      cancelled = true;
      cancelDeferredRestore?.();
    };
  }, [
    persistSession,
    persistenceGate,
    restorePersistedSession,
    settingService,
    restoreSession,
    store,
  ]);

  // 持久化：订阅 store 变化，debounce 写入
  useEffect(() => {
    if (!settingService || !persistSession) return;

    const unsubscribe = store.subscribe((state) => {
      if (!initialRestoreFullyCompletedRef.current) {
        return;
      }
      if (persistenceGate && !persistenceGate.canPersist) {
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        // 新开的次级窗口如果也把自己的标签页写回全局设置，
        // 会把主窗口真正想恢复的会话覆盖掉，导致下次启动恢复到错误窗口。
        // 这里把“是否持久化会话”独立成开关，只让首个本地窗口负责写回。
        // Bug 原因：remote legacy identity 的单一来源在最新 AppSettings；旧写入者只拿 tab
        // state，默认空 history 会把冻结 identity 改写成当前线路。写前读取同一 settings 快照。
        settingService
          .get()
          .then((settings) =>
            settingService.update(
              buildPersistPatch
                ? buildPersistPatch(state, settings)
                : buildDefaultPersistPatch(state),
            ),
          )
          .catch((err) => {
            logger.error("[useTabPersistence] 持久化失败:", err);
          });
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [buildPersistPatch, persistSession, persistenceGate, store, settingService]);

  return { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore };
}
