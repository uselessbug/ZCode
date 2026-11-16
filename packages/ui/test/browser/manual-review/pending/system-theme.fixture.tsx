import type { IBroadcastService } from "@zcode/services";
import { createZCodeStore } from "@/store/index.js";
import { applyTheme, type Theme } from "@/useTheme.js";
import { resolveWebRemoteControlInitialTheme } from "../../../../../web/src/web-remote-control/adapters/webRemoteControlThemeSeed.js";
import "@/styles.css";

/**
 * 系统主题回归 fixture（spec：docs/web-remote-control/mobile-theme-control.md）。
 *
 * 不渲染 App，只运行真实的主题所有者：
 * - surface=web / desktop：真实 createZCodeStore，初始化时由 store 调用 applyTheme 并按
 *   theme === "system" 挂载 prefers-color-scheme 监听；切换主题走 store.setTheme。
 *   web 页面的 head 由测试直接取自 packages/web/index.html（含内联 bootstrap），
 *   desktop 页面没有 bootstrap，也就没有浏览器表面 opt-in。
 * - surface=share：与 packages/web-share/src/main.tsx 相同，入口按本地偏好调用一次 applyTheme；
 *   head 取自 packages/web-share/index.html。
 */
const surface = new URLSearchParams(location.search).get("surface");

const broadcast: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
  acquireClaim: async () => ({ status: "unavailable" }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => false,
};

declare global {
  interface Window {
    zcodeTheme: { setTheme(theme: Theme): void; ready: true };
  }
}

if (surface === "share") {
  applyTheme(
    resolveWebRemoteControlInitialTheme({
      storedTheme: localStorage.getItem("zcode-theme"),
      defaultTheme: "zai-light",
    }),
  );
  window.zcodeTheme = {
    setTheme: (theme) => {
      localStorage.setItem("zcode-theme", theme);
      applyTheme(theme);
    },
    ready: true,
  };
} else {
  const store = createZCodeStore(broadcast);
  window.zcodeTheme = { setTheme: (theme) => store.getState().setTheme(theme), ready: true };
}
