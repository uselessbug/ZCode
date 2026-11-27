import assert from "node:assert/strict";

/**
 * 系统主题回归的共享场景（spec：docs/web-remote-control/mobile-theme-control.md）。
 *
 * system-theme.test.mjs 用 Vite + Playwright 驱动；同一组场景也可以由其他 driver
 * （例如本地 Browser Use）复用。driver 只需实现：
 *   open(surface, { stored, system })  打开 web / share / desktop fixture，首屏前写入 localStorage
 *   setSystem("dark" | "light")         改变系统亮暗偏好
 *   setTheme(theme)                     通过真实 store / applyTheme 切换主题偏好
 *   reload()                            整页刷新
 *   state()                             返回 readThemeState 的结果
 */

/** fixture 首屏前写入的系统偏好 key，仅 system: "controlled" 时使用。 */
export const CONTROLLED_SYSTEM_KEY = "__zcode-test-system-theme";

const ENTRY_SCRIPTS = {
  web: '<script type="module" src="/src/main.tsx"></script>',
  share: '<script type="module" src="/src/main.tsx"></script>',
};

/**
 * 用真实入口 HTML 组装 fixture 页面：保留 head 中的 meta 与内联 bootstrap，
 * 只把业务 bundle 换成 fixture 入口。desktop 没有 Web 入口，也就没有浏览器表面 opt-in。
 */
export function buildFixtureHtml(surface, { entryHtml, entryTag, prelude = "" }) {
  if (surface === "desktop") {
    return `<!doctype html><html><head>${prelude}</head><body><div id="root"></div>${entryTag}</body></html>`;
  }
  const original = ENTRY_SCRIPTS[surface];
  if (!entryHtml.includes(original)) {
    throw new Error(`${surface} index.html no longer contains ${original}`);
  }
  return entryHtml.replace(original, entryTag).replace("<head>", `<head>${prelude}`);
}

/**
 * 页面内执行：模拟浏览器的 prefers-color-scheme 规则。必须在任何页面脚本之前运行。
 *
 * rule:
 * - "standard"：顶层 prefers-color-scheme 只跟随系统（Chromium / Firefox Beta 行为）。
 * - "nightly"：Firefox Nightly 161+（Mozilla bug 2085572 / 2087391）行为，
 *   meta[name="color-scheme"] 只声明单个 light/dark 时覆写顶层 prefers-color-scheme，
 *   双值 "light dark" 时仍跟随系统。
 * system:
 * - "native"：系统偏好来自真实 Chromium matchMedia（Playwright emulateMedia 控制）。
 * - "controlled"：系统偏好来自 localStorage，供无法模拟媒体特性的 driver 使用。
 *
 * 同时记录每次读取 prefers-color-scheme 时 meta 的内容，以及运行时对两类 meta 的写入。
 */
export function installColorSchemeRules({ rule, system, systemKey }) {
  const nativeMatchMedia = window.matchMedia.bind(window);
  const log = { reads: [], colorSchemeWrites: [], themeColorWrites: [] };
  window.__zcodeColorScheme = log;
  const metaContent = () =>
    document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? null;
  const systemDark = () =>
    system === "native"
      ? nativeMatchMedia("(prefers-color-scheme: dark)").matches
      : localStorage.getItem(systemKey) === "dark";
  const metaOverride = () => {
    if (rule !== "nightly") return null;
    const values = (metaContent() ?? "")
      .trim()
      .split(/\s+/)
      .filter((value) => value === "light" || value === "dark");
    return values.length === 1 ? values[0] : null;
  };
  const effectiveDark = () => {
    const override = metaOverride();
    return override ? override === "dark" : systemDark();
  };

  const lists = new Set();
  let last = effectiveDark();
  const notify = () => {
    const now = effectiveDark();
    if (now === last) return;
    last = now;
    for (const list of lists) list.dispatch();
  };

  class EmulatedMediaQueryList extends EventTarget {
    constructor(media, wantsDark) {
      super();
      this.media = media;
      this.wantsDark = wantsDark;
      this.onchange = null;
    }
    get matches() {
      return effectiveDark() === this.wantsDark;
    }
    addListener(listener) {
      this.addEventListener("change", listener);
    }
    removeListener(listener) {
      this.removeEventListener("change", listener);
    }
    dispatch() {
      const event = new MediaQueryListEvent("change", { media: this.media, matches: this.matches });
      this.onchange?.(event);
      this.dispatchEvent(event);
    }
  }

  window.matchMedia = (query) => {
    const match = /prefers-color-scheme\s*:\s*(dark|light)/.exec(String(query));
    if (!match) return nativeMatchMedia(query);
    log.reads.push(metaContent());
    if (rule === "standard" && system === "native") return nativeMatchMedia(query);
    const list = new EmulatedMediaQueryList(String(query), match[1] === "dark");
    lists.add(list);
    return list;
  };

  if (system === "native") {
    nativeMatchMedia("(prefers-color-scheme: dark)").addEventListener("change", notify);
  } else {
    window.__zcodeSetSystemTheme = (theme) => {
      localStorage.setItem(systemKey, theme);
      notify();
    };
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== "attributes" || record.target.localName !== "meta") continue;
      const name = record.target.getAttribute("name");
      const content = record.target.getAttribute("content");
      if (name === "color-scheme") log.colorSchemeWrites.push(content);
      if (name === "theme-color") log.themeColorWrites.push(content);
    }
    notify();
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["content"],
  });
}

/** 页面内执行：读取主题相关的 DOM 与 meta 状态。 */
export function readThemeState() {
  const root = document.documentElement;
  const log = window.__zcodeColorScheme;
  return {
    ready: Boolean(window.zcodeTheme?.ready),
    dark: root.classList.contains("dark"),
    themeClass: root.classList.contains("theme-zai-dark")
      ? "zai-dark"
      : root.classList.contains("theme-zai-light")
        ? "zai-light"
        : null,
    surface: root.getAttribute("data-zcode-browser-theme-surface"),
    cssColorScheme: root.style.colorScheme,
    colorSchemeMetas: [...document.querySelectorAll('meta[name="color-scheme"]')].map(
      (meta) => meta.content,
    ),
    themeColorMetas: [...document.querySelectorAll('meta[name="theme-color"]')].map(
      (meta) => meta.content,
    ),
    background: getComputedStyle(root).getPropertyValue("--color-background").trim(),
    reads: [...(log?.reads ?? [])],
    colorSchemeWrites: [...(log?.colorSchemeWrites ?? [])],
    themeColorWrites: [...(log?.themeColorWrites ?? [])],
  };
}

const BACKGROUNDS = { dark: "#161616", light: "#f8f8f8" };
const STATIC_META = "light dark";

/** 每个 surface 在给定主题偏好与系统偏好下应得到的状态。 */
export function expectedThemeState(surface, theme, system) {
  const resolved =
    theme === "system" ? system : theme === "dark" || theme === "zai-dark" ? "dark" : "light";
  const base = {
    dark: resolved === "dark",
    themeClass: resolved === "dark" ? "zai-dark" : "zai-light",
    // 页面任何一次 prefers-color-scheme 读取都必须发生在双值 meta 之下（desktop 没有该 meta）。
    readsUnderSingleValueMeta: 0,
    colorSchemeWrites: [],
  };
  if (surface === "web") {
    return {
      ...base,
      surface: resolved,
      cssColorScheme: resolved,
      colorSchemeMetas: [STATIC_META],
      themeColorMetas: [BACKGROUNDS[resolved]],
      background: BACKGROUNDS[resolved],
    };
  }
  if (surface === "share") {
    // 分享页不声明浏览器表面：不写 CSS color-scheme，也不改写任何 meta。
    return {
      ...base,
      surface: null,
      cssColorScheme: "",
      colorSchemeMetas: [STATIC_META],
      themeColorWrites: [],
    };
  }
  // Desktop Electron 没有浏览器表面 opt-in：不写 CSS color-scheme，也不创建 Web meta。
  return {
    ...base,
    surface: null,
    cssColorScheme: "",
    colorSchemeMetas: [],
    themeColorMetas: [],
    themeColorWrites: [],
  };
}

function project(actual, expected) {
  const view = {};
  for (const key of Object.keys(expected)) {
    view[key] =
      key === "readsUnderSingleValueMeta"
        ? actual.reads.filter((content) => content !== null && content !== STATIC_META).length
        : actual[key];
  }
  return view;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 断言页面收敛到期望状态。系统偏好变化通过异步 change 事件到达，这里有界轮询；
 * 超时后用完整 diff 报告实际状态（含每次媒体读取时的 meta 内容）。
 */
export async function expectTheme(driver, surface, theme, system, label) {
  const expected = expectedThemeState(surface, theme, system);
  let actual;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    actual = await driver.state();
    if (actual.ready) {
      try {
        assert.deepEqual(project(actual, expected), expected);
        return;
      } catch {
        // 继续等待 change 事件
      }
    }
    await sleep(50);
  }
  assert.deepEqual(
    project(actual, expected),
    expected,
    `${label}: surface=${surface} theme=${theme} system=${system}; reads=${JSON.stringify(actual.reads)}`,
  );
}

/** 手动主题期间系统变化不得改变页面；等待两轮事件循环后确认状态未变。 */
async function expectStable(driver, surface, theme, system, label) {
  await sleep(150);
  await expectTheme(driver, surface, theme, system, label);
}

/**
 * 场景表。rules 表示在哪些浏览器规则下运行；desktop 是 Electron，只按标准规则运行。
 */
export const systemThemeCases = [
  ...["dark", "light"].map((system) => ({
    name: `web 初始 system=${system}`,
    surface: "web",
    async run(d) {
      await d.open("web", { stored: "system", system });
      await expectTheme(d, "web", "system", system, "首屏");
    },
  })),
  {
    name: "web system 连续双向切换（暗->浅->暗->浅->暗）",
    surface: "web",
    async run(d) {
      await d.open("web", { stored: "system", system: "dark" });
      await expectTheme(d, "web", "system", "dark", "首屏");
      for (const system of ["light", "dark", "light", "dark"]) {
        await d.setSystem(system);
        await expectTheme(d, "web", "system", system, `系统切到 ${system}`);
      }
    },
  },
  {
    name: "web system 暗->浅后刷新仍为浅，浅->暗后刷新仍为暗",
    surface: "web",
    async run(d) {
      await d.open("web", { stored: "system", system: "dark" });
      await expectTheme(d, "web", "system", "dark", "首屏");
      await d.setSystem("light");
      await expectTheme(d, "web", "system", "light", "系统切到 light");
      await d.reload();
      await expectTheme(d, "web", "system", "light", "刷新后");
      await d.setSystem("dark");
      await expectTheme(d, "web", "system", "dark", "系统切到 dark");
      await d.reload();
      await expectTheme(d, "web", "system", "dark", "再次刷新后");
    },
  },
  ...[
    ["zai-dark", "light"],
    ["zai-light", "dark"],
  ].map(([manual, system]) => ({
    name: `web 手动 ${manual} -> system（系统 ${system}）后继续跟随系统`,
    surface: "web",
    async run(d) {
      await d.open("web", { stored: manual, system });
      await expectTheme(d, "web", manual, system, "手动主题首屏");
      await d.setTheme("system");
      await expectTheme(d, "web", "system", system, "切回 system");
      const flipped = system === "dark" ? "light" : "dark";
      await d.setSystem(flipped);
      await expectTheme(d, "web", "system", flipped, "system 下系统翻转");
      await d.reload();
      await expectTheme(d, "web", "system", flipped, "刷新后");
    },
  })),
  {
    name: "web 手动与 system 重复切换，手动期间不跟随系统",
    surface: "web",
    async run(d) {
      await d.open("web", { stored: "system", system: "light" });
      await expectTheme(d, "web", "system", "light", "首屏");
      let system = "light";
      for (const manual of ["zai-dark", "zai-light", "zai-dark"]) {
        await d.setTheme(manual);
        await expectTheme(d, "web", manual, system, `手动 ${manual}`);
        system = system === "dark" ? "light" : "dark";
        await d.setSystem(system);
        await expectStable(d, "web", manual, system, `手动 ${manual} 期间系统切到 ${system}`);
        await d.setTheme("system");
        await expectTheme(d, "web", "system", system, `从 ${manual} 切回 system`);
        system = system === "dark" ? "light" : "dark";
        await d.setSystem(system);
        await expectTheme(d, "web", "system", system, `system 下系统切到 ${system}`);
      }
    },
  },
  ...["dark", "light"].map((system) => ({
    name: `share 初始 system=${system}，系统变化后刷新跟随`,
    surface: "share",
    async run(d) {
      await d.open("share", { stored: "system", system });
      await expectTheme(d, "share", "system", system, "首屏");
      const flipped = system === "dark" ? "light" : "dark";
      await d.setSystem(flipped);
      await d.reload();
      await expectTheme(d, "share", "system", flipped, "系统翻转后刷新");
      await d.setTheme("zai-dark");
      await expectTheme(d, "share", "zai-dark", flipped, "手动深色");
      await d.setTheme("system");
      await expectTheme(d, "share", "system", flipped, "切回 system");
    },
  })),
  {
    name: "desktop 无浏览器表面：system 双向与手动切换不写 Web meta",
    surface: "desktop",
    rules: ["standard"],
    async run(d) {
      await d.open("desktop", { stored: "system", system: "dark" });
      await expectTheme(d, "desktop", "system", "dark", "首屏");
      await d.setSystem("light");
      await expectTheme(d, "desktop", "system", "light", "系统切到 light");
      await d.setTheme("zai-dark");
      await expectTheme(d, "desktop", "zai-dark", "light", "手动深色");
      await d.setTheme("system");
      await expectTheme(d, "desktop", "system", "light", "切回 system");
      await d.setSystem("dark");
      await expectTheme(d, "desktop", "system", "dark", "系统切到 dark");
    },
  },
];
