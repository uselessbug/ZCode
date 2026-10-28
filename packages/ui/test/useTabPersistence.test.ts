// @vitest-environment jsdom
import { createElement, type ReactNode, useCallback } from "react";
import { act, renderHook } from "@testing-library/react";
import type { ISettingService } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasCompletedTabPersistenceInitialRestore,
  type WorkspacePersistenceGate,
  useTabPersistence,
} from "@/hooks/useTabPersistence.js";
import { shouldResolveProviderStartupState } from "@/lib/rootStartupGate.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  createTabStore,
  isSettingsTab,
  isWorkspaceTab,
  type TabStoreState,
} from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import type { AppSettings } from "@zcode/shared";

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

describe("useTabPersistence", () => {
  it("builds a persistence patch from the latest settings snapshot", async () => {
    vi.useFakeTimers();
    let settings = {
      lastWorkspaceSession: [{ kind: "local" as const, workspacePath: "/workspace/active" }],
      lastActiveTabIndex: 0,
      sourceServerWorkspaceHistory: [] as Array<{ workspacePath: string }>,
    };
    const update = vi.fn(async () => undefined);
    const settingService = {
      get: vi.fn(async () => settings),
      update,
    } as unknown as ISettingService;
    const buildPersistPatch = vi.fn((_state: unknown, currentSettings: typeof settings) => ({
      sourceServerWorkspaceHistory: currentSettings.sourceServerWorkspaceHistory,
    }));
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result } = renderHook(
      () => {
        const store = useTabStoreApi();
        useTabPersistence({ settingService, buildPersistPatch });
        return store;
      },
      { wrapper },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    settings = {
      ...settings,
      sourceServerWorkspaceHistory: [{ workspacePath: "/workspace/remote" }],
    };

    act(() => result.current.getState().addTab("/workspace/next"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(buildPersistPatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceServerWorkspaceHistory: [{ workspacePath: "/workspace/remote" }],
      }),
    );
    expect(update).toHaveBeenCalledWith({
      sourceServerWorkspaceHistory: [{ workspacePath: "/workspace/remote" }],
    });
  });

  it("关闭本地 tab 后只保存活动目录，重启不会从旧快照复活导航", async () => {
    // 项目列表由 Host 持久化；Renderer 只写活动目录，不能以 tabs 覆盖项目入口集合。
    // 新活动目录存在后，恢复不再回读旧 lastWorkspaceSession 快照。
    vi.useFakeTimers();
    let settings = {
      lastWorkspaceSession: [
        { kind: "local" as const, workspacePath: "/workspace/kept" },
        { kind: "local" as const, workspacePath: "/workspace/closed" },
      ],
      lastActiveTabIndex: 0,
    } as unknown as AppSettings;
    const update = vi.fn(async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
    });
    const settingService = {
      get: vi.fn(async () => settings),
      update,
    } as unknown as ISettingService;
    const persistenceGate: WorkspacePersistenceGate = {
      canPersist: false,
      restoreFailed: false,
    };
    let restoreTarget: ReturnType<typeof createTabStore> | null = null;
    const restorePersistedSession = (currentSettings: AppSettings) => {
      restorePersistedRemoteWorkspaceSessions({
        settings: currentSettings,
        tabStoreApi: restoreTarget!,
      });
    };
    const buildPersistPatch = (state: TabStoreState, currentSettings: AppSettings) =>
      buildRemoteWorkspacePersistPatch(
        state,
        [],
        currentSettings.sourceServerWorkspaceHistory,
        currentSettings.remoteConversationWorkspaceBySourceServerId,
        { persistedWorkspaceSession: currentSettings.lastWorkspaceSession },
      );
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result } = renderHook(
      () => {
        const store = useTabStoreApi();
        restoreTarget = store as never;
        useTabPersistence({
          settingService,
          persistenceGate,
          restorePersistedSession,
          buildPersistPatch,
        });
        return store;
      },
      { wrapper },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(persistenceGate.canPersist).toBe(true);
    const closingTab = result.current
      .getState()
      .tabs.find((tab) => isWorkspaceTab(tab) && tab.workspacePath === "/workspace/closed");
    expect(closingTab).toBeDefined();

    act(() => result.current.getState().closeTab(closingTab!.id));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(settings.lastActiveWorkspace).toEqual({
      kind: "local",
      workspacePath: "/workspace/kept",
    });
    expect(update).toHaveBeenCalled();
    expect(update.mock.calls.every(([patch]) => !("lastWorkspaceSession" in patch))).toBe(true);

    const restartedStore = createTabStore();
    restorePersistedRemoteWorkspaceSessions({ settings, tabStoreApi: restartedStore });
    expect(
      restartedStore
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/kept"]);
  });

  it("deferred restore 完成前不持久化 active-only 瞬态", async () => {
    vi.useFakeTimers();
    let runIdleCallback: (() => void) | undefined;
    Object.defineProperty(globalThis, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        runIdleCallback = callback;
        return 9;
      }),
    });
    Object.defineProperty(globalThis, "cancelIdleCallback", {
      configurable: true,
      value: vi.fn(),
    });
    const update = vi.fn(async () => undefined);
    const persistenceGate: WorkspacePersistenceGate = {
      canPersist: false,
      restoreFailed: false,
    };
    const settingService = {
      get: vi.fn(async () => ({
        lastWorkspaceSession: [
          { kind: "local" as const, workspacePath: "/workspace/active" },
          { kind: "local" as const, workspacePath: "/workspace/inactive" },
        ],
        lastActiveTabIndex: 0,
        recentProjects: ["/workspace/active", "/workspace/inactive"],
      })),
      update,
    } as unknown as ISettingService;

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result } = renderHook(
      () => {
        const store = useTabStoreApi();
        const restorePersistedSession = useCallback(() => {
          store.getState().restoreTabs(["/workspace/active"], 0);
          return {
            deferredRestore: () =>
              store.getState().completeTabRestore(["/workspace/active", "/workspace/inactive"]),
          };
        }, [store]);
        const persistence = useTabPersistence({
          settingService,
          restorePersistedSession,
          persistenceGate,
        });
        return { persistence, store };
      },
      { wrapper },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.persistence.isRestoring).toBe(false);
    expect(result.current.persistence.hasCompletedFullRestore).toBe(false);
    expect(
      result.current.store
        .getState()
        .tabs.map((tab) => (tab.kind === "workspace" ? tab.workspacePath : tab.kind)),
    ).toEqual(["/workspace/active"]);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(update).not.toHaveBeenCalled();

    act(() => runIdleCallback?.());
    expect(result.current.persistence.hasCompletedFullRestore).toBe(true);
    expect(persistenceGate.canPersist).toBe(true);
    expect(
      result.current.store
        .getState()
        .tabs.map((tab) => (tab.kind === "workspace" ? tab.workspacePath : tab.kind)),
    ).toEqual(["/workspace/active", "/workspace/inactive"]);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        lastActiveWorkspace: { kind: "local", workspacePath: "/workspace/active" },
      }),
    );
  });

  it("restore 失败时保持 fail-closed，后续 tab 变化不能覆盖磁盘快照", async () => {
    vi.useFakeTimers();
    const update = vi.fn(async () => undefined);
    const settingService = {
      get: vi.fn(async () => {
        throw new Error("settings read failed");
      }),
      update,
    } as unknown as ISettingService;
    const persistenceGate: WorkspacePersistenceGate = {
      canPersist: false,
      restoreFailed: false,
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result } = renderHook(
      () => {
        const store = useTabStoreApi();
        useTabPersistence({ settingService, persistenceGate });
        return store;
      },
      { wrapper },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(persistenceGate).toEqual({
      canPersist: false,
      restoreFailed: true,
    });
    act(() => result.current.getState().addTab("/workspace/after-failure"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(update).not.toHaveBeenCalled();
  });

  it("restoreSession 从关闭切到开启时会先等待当前恢复完成", () => {
    const settingService = {} as ISettingService;

    expect(
      hasCompletedTabPersistenceInitialRestore({
        settingService,
        restoreSession: true,
        restoreLifecycle: {
          settingService: undefined,
          restoreSession: false,
          completed: true,
          fullyCompleted: true,
        },
      }),
    ).toBe(false);
  });

  it("当前 settingService 的恢复完成后才允许初始 workspace 注入", () => {
    const settingService = {} as ISettingService;

    expect(
      hasCompletedTabPersistenceInitialRestore({
        settingService,
        restoreSession: true,
        restoreLifecycle: {
          settingService,
          restoreSession: true,
          completed: true,
          fullyCompleted: true,
        },
      }),
    ).toBe(true);
  });

  it("不需要恢复会话时不阻塞初始 workspace 注入", () => {
    expect(
      hasCompletedTabPersistenceInitialRestore({
        settingService: undefined,
        restoreSession: true,
        restoreLifecycle: {
          settingService: undefined,
          restoreSession: true,
          completed: false,
          fullyCompleted: false,
        },
      }),
    ).toBe(true);
  });

  it("同一 settingService 恢复成功后，仅 restorePersistedSession 换引用不再从磁盘覆盖当前 tabs", async () => {
    // 真实独立 Web 重连会换掉除 settingService 外的所有 services，Root 的
    // restorePersistedSession 因依赖 services.fileService 而换引用。同一 Host 已完整恢复后，
    // 这里必须跳过重复恢复，否则会清掉用户正打开的 settings tab 并切回工作台。
    vi.useFakeTimers();
    const settings = {
      lastWorkspaceSession: [{ kind: "local" as const, workspacePath: "/workspace/restored" }],
      lastActiveTabIndex: 0,
    } as unknown as AppSettings;
    const get = vi.fn(async () => settings);
    const settingService = {
      get,
      update: vi.fn(async () => undefined),
    } as unknown as ISettingService;
    const persistenceGate: WorkspacePersistenceGate = { canPersist: false, restoreFailed: false };
    const restoreCalls = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result, rerender } = renderHook(
      ({
        fileService,
        providerStartupSyncPending,
      }: {
        fileService: { id: string };
        providerStartupSyncPending: boolean;
      }) => {
        const store = useTabStoreApi();
        const restorePersistedSession = useCallback(() => {
          restoreCalls();
          store.getState().restoreTabs(["/workspace/restored"], 0);
        }, [store, fileService]);
        useTabPersistence({
          settingService,
          persistenceGate,
          restorePersistedSession,
          restoreSession: !shouldResolveProviderStartupState({
            isWebRemoteControlRoot: false,
            providerStartupSyncPending,
            providerAvailabilityStartupCheckCompleted: true,
          }),
        });
        return store;
      },
      {
        wrapper,
        initialProps: { fileService: { id: "file-a" }, providerStartupSyncPending: false },
      },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restoreCalls).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(persistenceGate).toEqual({ canPersist: true, restoreFailed: false });

    // 用户切到设置页
    act(() => result.current.getState().openSettingsTab());
    const settingsTab = result.current.getState().tabs.find(isSettingsTab);
    expect(settingsTab).toBeDefined();
    expect(result.current.getState().activeTabId).toBe(settingsTab!.id);

    // 重连：fresh services → callback 换引用；settingService 仍为同一对象（同一 Host）
    rerender({ fileService: { id: "file-b" }, providerStartupSyncPending: true });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender({ fileService: { id: "file-c" }, providerStartupSyncPending: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restoreCalls).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    const state = result.current.getState();
    expect(state.activeTabId).toBe(settingsTab!.id);
    expect(state.tabs).toContain(settingsTab);
    expect(state.tabs.some(isSettingsTab)).toBe(true);
    expect(persistenceGate).toEqual({ canPersist: true, restoreFailed: false });
  });

  it("真实 settingService 换实例（Host 变更）仍会重新恢复", async () => {
    vi.useFakeTimers();
    const makeService = (workspacePath: string) =>
      ({
        get: vi.fn(
          async () =>
            ({
              lastWorkspaceSession: [{ kind: "local" as const, workspacePath }],
              lastActiveTabIndex: 0,
            }) as unknown as AppSettings,
        ),
        update: vi.fn(async () => undefined),
      }) as unknown as ISettingService;
    const serviceA = makeService("/workspace/a");
    const serviceB = makeService("/workspace/b");
    const restoreCalls = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result, rerender } = renderHook(
      ({ settingService }: { settingService: ISettingService }) => {
        const store = useTabStoreApi();
        const restorePersistedSession = useCallback(
          (currentSettings: AppSettings) => {
            restoreCalls();
            const paths = (currentSettings.lastWorkspaceSession ?? [])
              .filter((entry) => entry.kind === "local")
              .map((entry) => entry.workspacePath);
            store.getState().restoreTabs(paths, 0);
          },
          [store],
        );
        useTabPersistence({ settingService, restorePersistedSession });
        return store;
      },
      { wrapper, initialProps: { settingService: serviceA } },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(restoreCalls).toHaveBeenCalledTimes(1);
    expect(
      result.current
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/a"]);

    act(() => result.current.getState().openSettingsTab());
    // 换到另一 Host：settingService 是新的转发对象，必须重新恢复
    rerender({ settingService: serviceB });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(restoreCalls).toHaveBeenCalledTimes(2);
    expect(
      result.current
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/b"]);
  });

  it("恢复失败后 restorePersistedSession 换引用仍可重试，门禁按真实结果恢复", async () => {
    vi.useFakeTimers();
    const settings = {
      lastWorkspaceSession: [{ kind: "local" as const, workspacePath: "/workspace/retry" }],
      lastActiveTabIndex: 0,
    } as unknown as AppSettings;
    let shouldFail = true;
    const get = vi.fn(async () => {
      if (shouldFail) throw new Error("settings read failed");
      return settings;
    });
    const settingService = {
      get,
      update: vi.fn(async () => undefined),
    } as unknown as ISettingService;
    const persistenceGate: WorkspacePersistenceGate = { canPersist: false, restoreFailed: false };
    const restoreCalls = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result, rerender } = renderHook(
      ({ fileService }: { fileService: { id: string } }) => {
        const store = useTabStoreApi();
        const restorePersistedSession = useCallback(() => {
          restoreCalls();
          store.getState().restoreTabs(["/workspace/retry"], 0);
        }, [store, fileService]);
        useTabPersistence({ settingService, persistenceGate, restorePersistedSession });
        return store;
      },
      { wrapper, initialProps: { fileService: { id: "file-a" } } },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // 失败时 fail-closed：门禁关闭，且不放开持久化
    expect(persistenceGate).toEqual({ canPersist: false, restoreFailed: true });
    expect(restoreCalls).not.toHaveBeenCalled();

    shouldFail = false;
    // 重连换 callback 引用后仍允许重试
    rerender({ fileService: { id: "file-b" } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(restoreCalls).toHaveBeenCalledTimes(1);
    expect(persistenceGate).toEqual({ canPersist: true, restoreFailed: false });
    expect(
      result.current
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/retry"]);
  });
});
