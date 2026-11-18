import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { type WebRemoteControlMobileNavigationIntent } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WebRemoteControlTaskViewReporter } from "@/web-remote-control/index.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";

type WebRemoteControlMobilePage = "home" | "chat";

// 手机窄屏停在 Home 列表时，聊天内容区并未显示；activeTaskId 仍保留，但用户并没有在看该任务。
// 页面状态属于壳层，这里只对外发布“Home 列表正在前台”这一事实，
// 供 Root 的 syncActiveTaskSession 在此时上报 null，避免该任务的完成通知被误当作已查看而吞掉。
let mobileHomeListVisible = false;
const mobileHomeListVisibilityListeners = new Set<() => void>();

export function isWebRemoteControlMobileHomeListVisible(): boolean {
  return mobileHomeListVisible;
}

export function subscribeWebRemoteControlMobileHomeListVisibility(
  listener: () => void,
): () => void {
  mobileHomeListVisibilityListeners.add(listener);
  return () => {
    mobileHomeListVisibilityListeners.delete(listener);
  };
}

function publishMobileHomeListVisible(visible: boolean): void {
  if (mobileHomeListVisible === visible) return;
  mobileHomeListVisible = visible;
  for (const listener of Array.from(mobileHomeListVisibilityListeners)) listener();
}

function hasMobileHistoryPage(
  state: unknown,
  page: WebRemoteControlMobilePage,
): state is { zcodeMobilePage: WebRemoteControlMobilePage } {
  return (
    typeof state === "object" &&
    state !== null &&
    "zcodeMobilePage" in state &&
    state.zcodeMobilePage === page
  );
}

function recordMobileChatHistory() {
  if (typeof window === "undefined") {
    return;
  }

  const state: unknown = window.history.state;
  if (hasMobileHistoryPage(state, "chat")) {
    return;
  }

  if (hasMobileHistoryPage(state, "home")) {
    window.history.replaceState({ ...state, zcodeMobilePage: "chat" }, "");
  } else {
    window.history.pushState({ zcodeMobilePage: "chat" }, "");
  }
}

function resolveInitialWebRemoteControlMobilePage(
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") {
    return "chat";
  }

  // Bugfix: 手机端在聊天页刷新时，React 内存状态会丢失，但浏览器会保留当前 history.state。
  // 这里复用点击进入聊天页时写入的 history state，避免刷新后只恢复 task 选中态却回到任务首页。
  if (typeof window !== "undefined" && hasMobileHistoryPage(window.history.state, "chat")) {
    return "chat";
  }

  return "home";
}

export function WebRemoteControlMobileShell({
  children,
  isMobileViewport = true,
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  taskViewEnabled = true,
  chatContent,
  chatOverlay,
  initialNavigationIntent,
  composerPrefillRequestId,
  revealChatRequestId,
  isSidePaneOpen = false,
  onCloseSidePane,
  renderTaskHome,
  renderChatHeader,
  sidePaneContent,
  switcher,
  webRemoteControlTerminalTransportState,
}: {
  children?: ReactNode;
  isMobileViewport?: boolean;
  switcher?: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskViewEnabled?: boolean;
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  composerPrefillRequestId?: number;
  /** 单调递增的“切到 Chat”请求序号（如通知点击选中会话）；变化且大于 0 时进入 Chat。 */
  revealChatRequestId?: number;
  isSidePaneOpen?: boolean;
  onCloseSidePane?: () => void;
  renderTaskHome: (options: {
    navigateToChat(): void;
    setSwitching(switching: boolean): void;
  }) => ReactNode;
  renderChatHeader: (options: { onBackHome: () => void }) => ReactNode;
  chatContent: ReactNode;
  chatOverlay?: ReactNode;
  sidePaneContent?: ReactNode;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
}) {
  const { intl } = useZCodeIntl();
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    composerPrefillRequestId
      ? "chat"
      : resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const terminalTransportState = useWebRemoteControlTerminalTransportState(
    webRemoteControlTerminalTransportState,
  );
  const shouldInertChatSurface = Boolean(sidePaneContent) && isSidePaneOpen;

  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
  }, []);

  useEffect(() => {
    // 普通 Web 设置层只准备了草稿；手机 Home 没有 Composer，必须显式进入 Chat 才能消费预填。
    // 不观察 currentPage，避免返回 Home 后把已经处理的意图重新执行。
    if (isMobileViewport && composerPrefillRequestId) navigateToChat();
  }, [
    isMobileViewport,
    composerPrefillRequestId,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    navigateToChat,
  ]);

  // 挂载时已有的序号视为已处理，重挂载或断点切换不会把停在 Home 的用户重新拉进 Chat。
  const lastRevealChatRequestIdRef = useRef(revealChatRequestId ?? 0);
  useEffect(() => {
    // 与预填请求同理只观察序号、不观察 currentPage：用户之后点返回箭头或系统返回键仍能回到 Home。
    if (!revealChatRequestId || revealChatRequestId === lastRevealChatRequestIdRef.current) return;
    lastRevealChatRequestIdRef.current = revealChatRequestId;
    if (isMobileViewport) navigateToChat();
  }, [isMobileViewport, revealChatRequestId, navigateToChat]);

  const navigateHome = useCallback(() => {
    // 聊天可能是历史首项，浏览器无法后退。箭头直接回列表，并同步历史供刷新恢复。
    setCurrentPage("home");
    const state: unknown = window.history.state;
    if (hasMobileHistoryPage(state, "chat")) {
      window.history.replaceState({ ...state, zcodeMobilePage: "home" }, "");
    }
  }, []);

  useEffect(() => {
    // 初始意图只随导航变化消费；断点恢复不能重放旧 chat 意图，覆盖用户已经返回的 Home。
    if (initialNavigationIntent === "chat") setCurrentPage("chat");
  }, [initialNavigationIntent]);

  useLayoutEffect(() => {
    if (isMobileViewport && currentPage === "chat") recordMobileChatHistory();
  }, [isMobileViewport, currentPage]);

  useEffect(() => {
    publishMobileHomeListVisible(isMobileViewport && currentPage === "home");
  }, [isMobileViewport, currentPage]);
  // 壳层卸载后不再有 Home 列表，必须复位，否则宽屏或桌面壳层会一直上报“未在查看”。
  useEffect(() => () => publishMobileHomeListVisible(false), []);

  useEffect(() => {
    if (!isMobileViewport || typeof window === "undefined") {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextPage = hasMobileHistoryPage(event.state, "chat") ? "chat" : "home";
      setCurrentPage(nextPage);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isMobileViewport]);

  // Bugfix: 移动端聊天/侧栏都是 flex 子树，默认 min-width:auto 会按长消息的
  // min-content 宽度撑开抽屉；窄屏随后从左侧裁掉正文。沿整条宽度链显式允许收缩，
  // 让 subagent 输出、进程面板和正文在抽屉内换行。
  return (
    <>
      <WebRemoteControlTaskViewReporter
        enabled={
          taskViewEnabled &&
          (!isMobileViewport ||
            (currentPage === "chat" && !shouldInertChatSurface && !switchingWorkspace))
        }
        activeTaskId={activeTaskId}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        switcher={switcher}
      />
      {isMobileViewport ? (
        <div className="mobile-workspace relative flex h-full min-h-0 min-w-0 flex-col bg-background">
          {currentPage === "home" ? (
            <section className="flex h-full min-h-0 min-w-0 flex-col" data-mobile-page="home">
              {renderTaskHome({ navigateToChat, setSwitching: setSwitchingWorkspace })}
            </section>
          ) : (
            <section
              className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
              data-mobile-page="chat"
            >
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: "webRemoteControl.mobileShell.backHome",
                  })}
                  onClick={navigateHome}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
                </span>
                <WebRemoteControlThemeMenu />
              </div>
              {renderChatHeader({ onBackHome: navigateHome })}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <main
                  className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  aria-hidden={shouldInertChatSurface ? true : undefined}
                  data-mobile-chat-surface={shouldInertChatSurface ? "inert" : undefined}
                  inert={shouldInertChatSurface ? true : undefined}
                >
                  {/* Bugfix: 手机侧栏打开时底部 composer 会被抽屉覆盖。
                  如果聊天区仍留在交互树里，模型选择等控件会被遮挡但仍可被浏览器命中，
                  造成“按钮不可点”的误导。这里把被覆盖的聊天表面设为 inert，
                  让右侧抽屉成为唯一可交互区域。 */}
                  {chatContent}
                </main>
                {sidePaneContent ? (
                  <div
                    className={[
                      "absolute inset-0 z-30 transition-opacity duration-200 ease-out",
                      isSidePaneOpen ? "opacity-100" : "pointer-events-none opacity-0",
                    ].join(" ")}
                    aria-hidden={!isSidePaneOpen}
                    data-mobile-side-pane-overlay="true"
                  >
                    <button
                      type="button"
                      className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
                      aria-label={intl.formatMessage({ id: "sidePane.collapse" })}
                      onClick={onCloseSidePane}
                    />
                    <div
                      className={[
                        "absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
                        isSidePaneOpen ? "translate-x-0" : "translate-x-full",
                      ].join(" ")}
                    >
                      {/* Bugfix: 手机远控之前把 side pane 作为底部纵向面板渲染，
                      会挤压聊天区且不像桌面右侧栏。这里改成右侧覆盖抽屉，
                      只覆盖手机聊天区，不改变桌面端分栏布局。 */}
                      {sidePaneContent}
                    </div>
                  </div>
                ) : null}
                {chatOverlay ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-40"
                    data-mobile-chat-overlay="true"
                  >
                    {/* Bugfix: 查找框属于聊天视觉区域，但不能成为 inert 聊天表面的后代。
                    独立 overlay 保留抽屉隔离，同时让文件变更查找仍可聚焦、切换和关闭。 */}
                    <div className="pointer-events-auto">{chatOverlay}</div>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {switchingWorkspace ? (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
                <LoaderCircle className="size-4 animate-spin" />
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            </div>
          ) : null}
          {terminalTransportState === "reconnecting" ? (
            <div
              className="pointer-events-none absolute top-3 left-1/2 z-50 flex -translate-x-1/2 justify-center px-3"
              aria-live="polite"
              aria-busy="true"
              data-web-remote-control-reconnect-notice="true"
            >
              <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-lg border border-border bg-toast px-3 py-2 text-ui-base text-foreground shadow-lg">
                <LoaderCircle className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                <span className="min-w-0 whitespace-nowrap">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        children
      )}
    </>
  );
}
