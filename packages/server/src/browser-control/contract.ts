import type { BrowserControlExecutor } from "@zcode/services/node";
import type { PlaywrightChromiumModule } from "@zcode/adapters/browser";

export interface ServerBrowserControlOptions {
  /** 显式 Chromium 可执行路径；缺省时由入口读取 CHROME_EXECUTABLE_PATH 或交由官方解析器探测。 */
  executablePath?: string;
  /** 关闭浏览器实例的有界等待时长（ms）。 */
  closeTimeoutMs?: number;
  /** 允许缓存的已释放空闲会话上限，透传给 createManagedCdpBrowserRuntime。 */
  maxReleasedSessions?: number;
  /** 已释放空闲会话的回收 TTL（ms），透传给 createManagedCdpBrowserRuntime。 */
  releasedSessionIdleTtlMs?: number;
  /** 环境变量来源，默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 可选 Playwright 加载器，用于源码与独立发行布局测试注入。 */
  loadPlaywright?: () => Promise<PlaywrightChromiumModule>;
}

export interface ServerBrowserControlHandle {
  /** 注入 createServerHostServices / createLocalServices 的窄执行桥。 */
  executor: BrowserControlExecutor;
  /** 幂等关闭受管 Chromium 运行时与未决请求。 */
  close(): Promise<void>;
}
