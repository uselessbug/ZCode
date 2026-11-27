import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

/**
 * Provider 详情反馈竞态回归（spec：docs/working-memory/provider-refactor/design/registry/settings.md「保存反馈」）。
 *
 * 渲染真实 InlineEditableProviderCard + ProviderDetailFeedbackBoundary；写请求由 fixture 挂起，
 * 测试通过 window.zcodeRace.settle 决定完成顺序与结果。
 *
 * 规则：
 * - 通知 key 之间互不抑制（model-save:<p>:<m> 与 provider-save:<p>）。
 * - 同 key 下旧操作的完成不覆盖新操作的 pending / 终态。
 * - draftRevision 只保护 Provider 表单草稿对应的 provider-save 通知。
 */
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/provider-feedback-race.fixture.tsx";
const artifacts = join(tmpdir(), "zcode-provider-feedback-race");
let server;
let browser;
let origin;

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "provider-feedback-race-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
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

const DELETE_BUTTONS = '[data-testid^="model-provider-model-delete-button-"]';
const FEEDBACK = "[data-provider-detail-feedback-state]";

async function openPage({ width = 1200, locale = "en-US", theme = "dark" } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.setDefaultTimeout(4000);
  await page.goto(`${origin}fixture?${new URLSearchParams({ locale, theme })}`, { timeout: 60000 });
  await page.locator(DELETE_BUTTONS).first().waitFor({ timeout: 30000 });
  assert.equal(
    await page.locator(DELETE_BUTTONS).count(),
    2,
    "fixture must expose two custom models",
  );
  return { page, errors };
}

/** 自定义模型行：删除按钮与启停开关在同一容器内。 */
function customRow(page, index) {
  return page.locator(DELETE_BUTTONS).nth(index).locator("xpath=..");
}

/** 原生 click：先把目标滚到视口上部，避开贴底的 sticky 通知层，与真实长页面的用户操作一致。 */
async function click(locator) {
  await locator.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await locator.click();
}

const settle = (page, args) => page.evaluate((a) => window.zcodeRace.settle(a), args);

async function dumpFeedback(page) {
  return page
    .locator(FEEDBACK)
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => `${node.dataset.providerDetailFeedbackState}: ${node.textContent?.trim()}`,
      ),
    );
}

/** 期望某个模型的通知处于指定状态；失败时输出当前全部通知，便于看出滞留的 pending。 */
async function expectFeedback(page, text, state) {
  try {
    await page
      .locator(`[data-provider-detail-feedback-state="${state}"]`)
      .filter({ hasText: text })
      .first()
      .waitFor({ timeout: 2500 });
  } catch {
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: join(artifacts, `red-${text}-${state}-${page.viewportSize().width}.png`),
    });
    assert.fail(
      `expected "${text}" to be ${state}; actual feedback: ${JSON.stringify(await dumpFeedback(page))}`,
    );
  }
}

async function expectNoFeedback(page, text) {
  const actual = await page.locator(FEEDBACK).filter({ hasText: text }).count();
  assert.equal(
    actual,
    0,
    `"${text}" must not be shown; actual: ${JSON.stringify(await dumpFeedback(page))}`,
  );
}

const nextFrames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

for (const [width, locale, theme] of [
  [1200, "en-US", "dark"],
  [390, "zh-CN", "light"],
]) {
  test(`不同模型并发删除，均成功且按发起顺序完成 ${width}/${locale}`, async () => {
    await mkdir(artifacts, { recursive: true });
    const { page, errors } = await openPage({ width, locale, theme });
    try {
      await click(page.locator(DELETE_BUTTONS).nth(0));
      await click(page.locator(DELETE_BUTTONS).nth(1));
      await expectFeedback(page, "custom-a", "pending");
      await expectFeedback(page, "custom-b", "pending");
      await settle(page, { action: "delete", modelId: "custom-a", ok: true });
      await settle(page, { action: "delete", modelId: "custom-b", ok: true });
      await page.screenshot({ path: join(artifacts, `delete-both-ok-${width}.png`) });
      await expectFeedback(page, "custom-a", "success");
      await expectFeedback(page, "custom-b", "success");
      assert.equal(
        await page.locator('[data-provider-detail-feedback-state="pending"]').count(),
        0,
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("不同模型并发删除，后发起的先完成（反序）", async () => {
  const { page } = await openPage();
  try {
    await click(page.locator(DELETE_BUTTONS).nth(0));
    await click(page.locator(DELETE_BUTTONS).nth(1));
    await settle(page, { action: "delete", modelId: "custom-b", ok: true });
    await settle(page, { action: "delete", modelId: "custom-a", ok: true });
    await expectFeedback(page, "custom-b", "success");
    await expectFeedback(page, "custom-a", "success");
    assert.equal(await page.locator('[data-provider-detail-feedback-state="pending"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("不同模型并发删除，一成功一失败：失败项保留重试，不被成功项吞掉", async () => {
  const { page } = await openPage();
  try {
    await click(page.locator(DELETE_BUTTONS).nth(0));
    await click(page.locator(DELETE_BUTTONS).nth(1));
    await settle(page, { action: "delete", modelId: "custom-a", ok: false });
    await settle(page, { action: "delete", modelId: "custom-b", ok: true });
    await page.screenshot({ path: join(artifacts, "delete-a-fail-b-ok.png") });
    await expectFeedback(page, "custom-a", "failure");
    await expectFeedback(page, "custom-b", "success");
    const failure = page
      .locator('[data-provider-detail-feedback-state="failure"]')
      .filter({ hasText: "custom-a" });
    assert.equal(await failure.getByRole("button", { name: "Retry", exact: true }).count(), 1);
    // 失败项重试必须重试原删除操作，而不是转成保存。
    await failure.getByRole("button", { name: "Retry", exact: true }).click();
    await expectFeedback(page, "custom-a", "pending");
    await settle(page, { action: "delete", modelId: "custom-a", ok: true });
    await expectFeedback(page, "custom-a", "success");
  } finally {
    await page.close();
  }
});

test("不同模型并发删除，全部失败：两条失败通知都保留", async () => {
  const { page } = await openPage();
  try {
    await click(page.locator(DELETE_BUTTONS).nth(0));
    await click(page.locator(DELETE_BUTTONS).nth(1));
    await settle(page, { action: "delete", modelId: "custom-b", ok: false });
    await settle(page, { action: "delete", modelId: "custom-a", ok: false });
    await expectFeedback(page, "custom-a", "failure");
    await expectFeedback(page, "custom-b", "failure");
    assert.equal(await page.locator('[data-provider-detail-feedback-state="pending"]').count(), 0);
  } finally {
    await page.close();
  }
});

test("不同模型并发保存（启停），均成功不遗留 pending", async () => {
  const { page } = await openPage();
  try {
    await click(customRow(page, 0).getByRole("switch"));
    await click(customRow(page, 1).getByRole("switch"));
    await expectFeedback(page, "custom-a", "pending");
    await expectFeedback(page, "custom-b", "pending");
    await settle(page, { action: "enable", modelId: "custom-a", ok: true });
    await settle(page, { action: "enable", modelId: "custom-b", ok: true });
    await expectFeedback(page, "custom-a", "success");
    await expectFeedback(page, "custom-b", "success");
  } finally {
    await page.close();
  }
});

test("同一模型连续操作：旧操作先完成不覆盖新操作的 pending", async () => {
  const { page } = await openPage();
  try {
    const toggle = customRow(page, 0).getByRole("switch");
    await click(toggle);
    await click(toggle);
    await settle(page, { action: "enable", modelId: "custom-a", nth: 0, ok: true });
    await nextFrames(page);
    await expectFeedback(page, "custom-a", "pending");
    await settle(page, { action: "enable", modelId: "custom-a", nth: 0, ok: true });
    await expectFeedback(page, "custom-a", "success");
  } finally {
    await page.close();
  }
});

test("同一模型连续操作：旧操作迟到失败不覆盖新操作的成功", async () => {
  const { page } = await openPage();
  try {
    const toggle = customRow(page, 0).getByRole("switch");
    await click(toggle);
    await click(toggle);
    // 先完成较新的第二次，再让较早的第一次失败（同 key 反序）。
    await settle(page, { action: "enable", modelId: "custom-a", nth: 1, ok: true });
    await expectFeedback(page, "custom-a", "success");
    await settle(page, { action: "enable", modelId: "custom-a", nth: 0, ok: false });
    await nextFrames(page);
    assert.equal(
      await page.locator('[data-provider-detail-feedback-state="failure"]').count(),
      0,
      `stale failure must not replace newer success; actual: ${JSON.stringify(await dumpFeedback(page))}`,
    );
    await expectFeedback(page, "custom-a", "success");
  } finally {
    await page.close();
  }
});

for (const [width, locale, theme] of [
  [1200, "en-US", "dark"],
  [390, "zh-CN", "light"],
]) {
  for (const outcome of ["success", "failure"]) {
    test(`模型删除在途时编辑 Provider 草稿：${outcome} 不遗留 pending ${width}/${locale}`, async () => {
      await mkdir(artifacts, { recursive: true });
      const { page } = await openPage({ width, locale, theme });
      try {
        await click(page.locator(DELETE_BUTTONS).nth(0));
        await expectFeedback(page, "custom-a", "pending");
        await page
          .getByPlaceholder(locale === "zh-CN" ? "输入 API Key" : "Enter API key")
          .fill("edited-key");
        // 草稿编辑不得丢弃或滞留模型级通知。
        await expectFeedback(page, "custom-a", "pending");
        await settle(page, { action: "delete", modelId: "custom-a", ok: outcome === "success" });
        await page.screenshot({ path: join(artifacts, `draft-edit-${outcome}-${width}.png`) });
        await expectFeedback(page, "custom-a", outcome);
        assert.equal(
          await page
            .locator('[data-provider-detail-feedback-state="pending"]')
            .filter({ hasText: "custom-a" })
            .count(),
          0,
        );
      } finally {
        await page.close();
      }
    });
  }
}

test("模型删除与 Provider 保存并发：两个 key 互不抑制", async () => {
  const { page } = await openPage();
  try {
    await click(page.locator(DELETE_BUTTONS).nth(0));
    await click(page.getByTestId("model-provider-enabled-switch"));
    await expectFeedback(page, "custom-a", "pending");
    await expectFeedback(page, "Saving Fixture Provider", "pending");
    await settle(page, { action: "save", ok: true });
    await settle(page, { action: "delete", modelId: "custom-a", ok: true });
    await expectFeedback(page, "custom-a", "success");
    await expectFeedback(page, "Fixture Provider saved", "success");
  } finally {
    await page.close();
  }
});

test("draftRevision 仍保护 Provider 草稿：旧草稿保存的迟到完成不显示成功", async () => {
  const { page } = await openPage();
  try {
    const keyInput = page.getByPlaceholder("Enter API key");
    await keyInput.fill("draft-1");
    // 空闲保存触发后出现 provider-save pending。
    await expectFeedback(page, "Saving Fixture Provider", "pending");
    await keyInput.fill("draft-12");
    await expectNoFeedback(page, "Saving Fixture Provider");
    await settle(page, { action: "save", ok: true });
    await nextFrames(page);
    await expectNoFeedback(page, "Fixture Provider saved");
  } finally {
    await page.close();
  }
});

test("卡片实例重挂载后，旧实例同 key 的迟到完成不覆盖新实例的操作", async () => {
  const { page } = await openPage();
  try {
    await click(customRow(page, 0).getByRole("switch"));
    await expectFeedback(page, "custom-a", "pending");
    // 旧实例的请求仍在途时换成新卡片实例（Boundary 保持不变），新实例对同一模型发起新操作。
    await page.getByTestId("race-remount").click();
    await page.locator(DELETE_BUTTONS).first().waitFor();
    await click(customRow(page, 0).getByRole("switch"));
    await settle(page, { action: "enable", modelId: "custom-a", nth: 0, ok: true });
    await nextFrames(page);
    await expectFeedback(page, "custom-a", "pending");
    await settle(page, { action: "enable", modelId: "custom-a", nth: 0, ok: true });
    await expectFeedback(page, "custom-a", "success");
  } finally {
    await page.close();
  }
});
