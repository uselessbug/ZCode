import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import {
  buildFixtureHtml,
  CONTROLLED_SYSTEM_KEY,
  installColorSchemeRules,
  readThemeState,
  systemThemeCases,
} from "./system-theme.cases.mjs";

/**
 * 系统主题回归（spec：docs/web-remote-control/mobile-theme-control.md）。
 *
 * 触发场景：Android Firefox Nightly 162.0a1 上 system 主题，系统暗 -> 浅后页面仍暗，刷新仍暗；
 * PC Firefox Beta 正常。根因：Nightly 161+ 让单值 meta[name="color-scheme"] 覆写顶层
 * prefers-color-scheme，而 Web 入口把该 meta 写成当前 resolved 主题。
 *
 * 页面 head 直接取自 packages/web/index.html 与 packages/web-share/index.html（含内联 bootstrap），
 * fixture 运行真实 createZCodeStore（system 监听）与 applyTheme。系统偏好由真实 Chromium
 * emulateMedia 驱动；Nightly 规则由 installColorSchemeRules 在页面脚本之前叠加到 matchMedia。
 *
 * 变异对照：ZCODE_SYSTEM_THEME_BASELINE=<git rev> 时改用该提交的 useTheme.ts 与两个 index.html；
 * 修复前版本可检出 Nightly 自锁，且因双值 meta 约束未满足而无法通过完整回归。
 */
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/system-theme.fixture.tsx";
const baseline = process.env.ZCODE_SYSTEM_THEME_BASELINE;
const run = promisify(execFile);
let server;
let browser;
let origin;

/** 读取工作区文件；设置 baseline 时读取该提交中的版本。 */
async function source(path) {
  if (!baseline) return readFile(`${root}${path}`, "utf8");
  const { stdout } = await run("git", ["show", `${baseline}:${path}`], { cwd: root });
  return stdout;
}

before(async () => {
  const entries = {
    web: await source("packages/web/index.html"),
    share: await source("packages/web-share/index.html"),
  };
  const baselineUseTheme = baseline ? await source("packages/ui/src/useTheme.ts") : null;
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "system-theme-fixture",
        enforce: "pre",
        load(id) {
          if (baselineUseTheme && id.split("?")[0].endsWith("/packages/ui/src/useTheme.ts")) {
            return baselineUseTheme;
          }
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url ?? "/", "http://fixture");
            if (url.pathname === "/seed") {
              res.setHeader("Content-Type", "text/html");
              res.end("<!doctype html><title>seed</title>");
              return;
            }
            const surface = url.searchParams.get("surface");
            if (url.pathname !== "/fixture" || !["web", "share", "desktop"].includes(surface)) {
              return next();
            }
            const html = buildFixtureHtml(surface, {
              entryHtml: entries[surface],
              entryTag: `<script type="module" src="${entry}"></script>`,
            });
            res.setHeader("Content-Type", "text/html");
            res.end(await vite.transformIndexHtml(req.url, html));
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : {},
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/** Playwright driver：系统偏好走真实 Chromium prefers-color-scheme 模拟。 */
async function createDriver(rule) {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(installColorSchemeRules, {
    rule,
    system: "native",
    systemKey: CONTROLLED_SYSTEM_KEY,
  });
  const waitReady = () =>
    page.waitForFunction(() => window.zcodeTheme?.ready, null, { timeout: 30000 });
  return {
    errors,
    close: () => context.close(),
    async open(surface, { stored, system }) {
      await page.emulateMedia({ colorScheme: system });
      await page.goto(`${origin}seed`);
      await page.evaluate((theme) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem("zcode-theme", theme);
      }, stored);
      await page.goto(`${origin}fixture?surface=${surface}`, { timeout: 60000 });
      await waitReady();
    },
    setSystem: (system) => page.emulateMedia({ colorScheme: system }),
    setTheme: (theme) => page.evaluate((t) => window.zcodeTheme.setTheme(t), theme),
    async reload() {
      await page.reload();
      await waitReady();
    },
    state: () => page.evaluate(readThemeState),
  };
}

for (const rule of ["standard", "nightly"]) {
  describe(`${rule} 浏览器规则`, () => {
    for (const scenario of systemThemeCases) {
      if (scenario.rules && !scenario.rules.includes(rule)) continue;
      test(scenario.name, async () => {
        const driver = await createDriver(rule);
        try {
          await scenario.run(driver);
          if (driver.errors.length) throw new Error(`page errors: ${driver.errors.join("\n")}`);
        } finally {
          await driver.close();
        }
      });
    }
  });
}
