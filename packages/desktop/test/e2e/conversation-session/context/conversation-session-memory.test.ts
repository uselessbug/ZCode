import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_MEMORY_CONFLICT,
  TID_SETTINGS_MEMORY_CONTENT,
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_EDIT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_OPEN,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_PREVIEW,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_RELOAD,
  TID_SETTINGS_MEMORY_SAVE,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_SWITCH,
  TID_SETTINGS_MEMORY_VIEWER_DIALOG,
  TID_SETTINGS_MEMORY_WORKSPACE,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import type { E2ENetworkCaptureArtifact } from "#e2e/helpers/network-capture-proxy";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  readSettings,
  seedCliConfig,
} from "#e2e/helpers/desktop-app";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { ensureToolCrossProductFullAccessMode } from "#e2e/helpers/conversation-session-tool-cross-product";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const E2E_TIMEOUT_MS = 240_000;
const DEFAULT_BRANCH_PROMPT = "E2E_MEMORY_WDIO_DEFAULT_BRANCH check";
const EXTRACTION_PROMPT =
  "E2E_MEMORY_WDIO_EXTRACTION deployments require staging approval because release managers need an audit trail.";
const EXTRACTED_DEFAULT_PROMPT = "E2E_MEMORY_WDIO_EXTRACTED_DEFAULT check";
const CUSTOM_PROMPT =
  "E2E_MEMORY_WDIO_CUSTOM delegate this durable review convention to the memory curator.";
const ACTIVE_AFTER_DISABLE_PROMPT = "E2E_MEMORY_WDIO_ACTIVE_AFTER_DISABLE";
const DISABLED_PROMPT = "E2E_MEMORY_WDIO_DISABLED";
const DEFAULT_BRANCH_DONE = "E2E_MEMORY_WDIO_DEFAULT_BRANCH_DONE";
const EXTRACTION_DONE = "E2E_MEMORY_WDIO_EXTRACTION_DONE";
const EXTRACTED_DEFAULT_DONE = "E2E_MEMORY_WDIO_EXTRACTED_DEFAULT_DONE";
const CUSTOM_DONE = "E2E_MEMORY_WDIO_CUSTOM_DONE";
const ACTIVE_AFTER_DISABLE_DONE = "E2E_MEMORY_WDIO_ACTIVE_AFTER_DISABLE_DONE";
const DISABLED_DONE = "E2E_MEMORY_WDIO_DISABLED_DONE";
const EXTRACTION_FILE_MARKER = "E2E_MEMORY_WDIO_EXTRACTION_FILE";
const CUSTOM_FILE_MARKER = "E2E_MEMORY_WDIO_CUSTOM_FILE";
const RELEVANT_MEMORY_MARKER = "Retrieved for possible relevance — use only if it actually applies";
const SELECTOR_MARKER = "You are selecting memories that will be useful";
const EXTRACTION_MARKER = "You are now acting as the memory extraction subagent";
const CUSTOM_MEMORY_MARKER = "# Persistent Agent Memory";
const MAIN_MEMORY_INDEX_POINTER =
  "After writing the file, add a one-line pointer in `MEMORY.md` (`- [Title](file.md) — hook`).";
const MAIN_MEMORY_INDEX_SOURCE = "user's auto-memory, persists across conversations";
const PROJECT_MEMORY_INDEX_CONTENT =
  "- [Database test policy](database-test-policy.md) — integration tests use isolated databases";
const PROJECT_MEMORY_UPDATED_POINTER =
  "- [Deployment approval policy](deployment-approval-policy.md) — staging approval required";
const PROJECT_MEMORY_UPDATED_INDEX_CONTENT = `${PROJECT_MEMORY_INDEX_CONTENT}\n${PROJECT_MEMORY_UPDATED_POINTER}`;
const SECOND_PROJECT_MEMORY_INDEX_CONTENT =
  "- [Incident review policy](incident-review-policy.md) — preserve the original evidence";
const REFRESHED_MEMORY_FACT_MARKER = "E2E_MEMORY_SETTINGS_REFRESHED_FACT";
const CONFLICT_DRAFT_MARKER = "E2E_MEMORY_SETTINGS_CONFLICT_DRAFT";
const CONFLICT_EXTERNAL_MARKER = "E2E_MEMORY_SETTINGS_CONFLICT_EXTERNAL";
const MEMORY_ENABLED_MAIN_FIXTURES = [
  { id: "memory-window-default-branch-boundary", index: "initial" },
  { id: "memory-window-default-branch-final", index: "initial" },
  { id: "memory-window-extraction-main", index: "initial" },
  { id: "memory-window-extracted-default-main", index: "updated" },
  { id: "memory-window-custom-parent-agent", index: "updated" },
  { id: "memory-window-custom-parent-final", index: "updated" },
  { id: "memory-window-active-after-disable", index: "updated" },
] as const;
const PROFILE_NAME = "memory-window-curator";

const PROJECT_MEMORY_ROOT = resolveProjectMemoryRoot(DEFAULT_WORKSPACE);
const PROJECT_MEMORY_INDEX = join(PROJECT_MEMORY_ROOT, "MEMORY.md");
const EXISTING_FILE = join(PROJECT_MEMORY_ROOT, "database-test-policy.md");
const EXTRACTED_FILE = join(PROJECT_MEMORY_ROOT, "deployment-approval-policy.md");
const SECOND_PROJECT_MEMORY_WORKSPACE_LABEL =
  "secondary-project-with-an-intentionally-very-long-workspace-name";
const SECOND_PROJECT_MEMORY_WORKSPACE_ID = `${SECOND_PROJECT_MEMORY_WORKSPACE_LABEL}-2222222222222222`;
const SECOND_PROJECT_MEMORY_ROOT = join(
  getE2EAppDataPaths().storageRoot,
  "cli",
  "memories",
  "projects",
  SECOND_PROJECT_MEMORY_WORKSPACE_ID,
  "memory",
);
const SECOND_PROJECT_MEMORY_INDEX = join(SECOND_PROJECT_MEMORY_ROOT, "MEMORY.md");
const SECOND_PROJECT_MEMORY_FACT = join(SECOND_PROJECT_MEMORY_ROOT, "incident-review-policy.md");
const REFRESHED_FILE = join(SECOND_PROJECT_MEMORY_ROOT, "manual-refresh.md");
const PROFILE_FILE = join(DEFAULT_WORKSPACE, ".zcode", "agents", `${PROFILE_NAME}.md`);
const CUSTOM_MEMORY_ROOT = join(DEFAULT_WORKSPACE, ".zcode", "agent-memory", PROFILE_NAME);
const CUSTOM_MEMORY_FILE = join(CUSTOM_MEMORY_ROOT, "review-convention.md");
let providerCaptureStartIndex = 0;

describe("Desktop Memory continuous 链路 WDIO", () => {
  before(async function () {
    this.timeout(E2E_TIMEOUT_MS);
    await seedMemoryFixtures();
    await seedCliConfig({ features: { memory: true }, memory: { use: true } });
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    // Bug 根因：replay capture 文件跨 WDIO spec/run 复用；按 fixtureId 全文件查找会把
    // 上一次同名 Memory 轨迹算进本次 proof。记录本 spec 的起始下标，只裁剪旧记录，
    // 保留本次每条 Main/Extraction 请求必须恰好一条的原有断言。
    providerCaptureStartIndex = (await readProviderCapture()).records.length;
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await rm(PROJECT_MEMORY_ROOT, { force: true, recursive: true });
    await rm(SECOND_PROJECT_MEMORY_ROOT, { force: true, recursive: true });
    await rm(join(DEFAULT_WORKSPACE, ".zcode"), {
      force: true,
      recursive: true,
    });
    await clearAppData();
  });

  it("从真实窗口覆盖默认分支、Extraction、custom agent 和 disabled gate", async function () {
    this.timeout(E2E_TIMEOUT_MS);

    const telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });

    await openMemorySettings();
    expect(await readMemorySwitch()).toBe(false);
    expect((await readSettings()).memoryEnabled).toBe(false);
    expect(await hasTestId(TID_SETTINGS_MEMORY_REFRESH)).toBe(false);
    await closeSettings();

    await sendV4Prompt(DISABLED_PROMPT);
    await waitForV4TimelineContaining(DISABLED_DONE, 90_000);
    const initiallyDisabledSessionId = requireSessionId((await getV4PaneSnapshot()).sessionId);

    await expectMemoryTelemetry(telemetryFetch, initiallyDisabledSessionId, "0");
    await setMemoryEnabled(true, initiallyDisabledSessionId);
    await verifyMemorySettingsViewer(initiallyDisabledSessionId);
    // 修复原因：Settings 初始化会异步刷新内置 provider，并可能覆盖 case-local replay
    // 偏好；Memory 轨迹必须在设置操作结束后重新固定测试 provider 再创建 session。
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    // Memory 开关在 session 创建时冻结；完成默认关闭的初始 session 后新建启用 session。
    await startNewV4Draft();

    await sendV4Prompt(DEFAULT_BRANCH_PROMPT);
    await waitForV4TimelineContaining(DEFAULT_BRANCH_DONE, 90_000);
    const projectPane = await waitForV4Pane(
      (snapshot) =>
        Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "Memory default branch 完成后 pane 没有回到 idle",
      90_000,
    );
    const projectSessionId = requireSessionId(projectPane.sessionId);
    await expectMemoryTelemetry(telemetryFetch, projectSessionId, "1");

    await waitForUpstreamRequest(
      { includes: [DEFAULT_BRANCH_PROMPT, "memory_default_branch_boundary"] },
      "Default Memory branch 的 Main continuation 未进入 provider capture",
      60_000,
    );
    const existingContent = await readFile(EXISTING_FILE, "utf8");
    expect(existingContent).not.toContain("originSessionId:");

    await sendV4Prompt(EXTRACTION_PROMPT);
    await waitForV4TimelineContaining(EXTRACTION_DONE, 90_000);
    await waitForUpstreamRequest(
      { includes: [EXTRACTION_MARKER, EXTRACTION_PROMPT] },
      "Desktop 成功 turn 后未捕获后台 Extraction request",
      60_000,
    );
    const extractedContent = await waitForFileContaining(EXTRACTED_FILE, EXTRACTION_FILE_MARKER);
    expect(extractedContent).toMatch(/^\s*node_type:\s*memory\s*$/mu);
    expect(readOriginSessionId(extractedContent)).toBe(projectSessionId);
    const updatedIndex = await waitForFileContaining(
      PROJECT_MEMORY_INDEX,
      PROJECT_MEMORY_UPDATED_POINTER,
    );
    expect(updatedIndex).toBe(`${PROJECT_MEMORY_UPDATED_INDEX_CONTENT}\n`);

    await startNewV4Draft();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(EXTRACTED_DEFAULT_PROMPT);
    await waitForV4TimelineContaining(EXTRACTED_DEFAULT_DONE, 90_000);
    await waitForUpstreamRequest(
      {
        includes: [EXTRACTED_DEFAULT_PROMPT, "# Memory\n"],
      },
      "新 session 的 default Memory Main request 未进入 provider capture",
      60_000,
    );

    await startNewV4Draft();
    await ensureToolCrossProductFullAccessMode();
    // 回归：新草稿模型检查曾回收在途预热，首发被误判为草稿切换；只点一次并确认 admission。
    await sendV4PromptAndWaitAccepted(
      CUSTOM_PROMPT,
      "E2E_MEMORY_WDIO_CUSTOM",
      "Memory 新草稿首次发送未被接收",
    );
    await waitForV4TimelineContaining(CUSTOM_DONE, 90_000);
    await waitForUpstreamRequest(
      {
        includes: [
          "E2E_MEMORY_WDIO_CUSTOM_CHILD",
          CUSTOM_MEMORY_MARKER,
          "Keep review findings evidence-first",
        ],
      },
      "custom agent persistent Memory prompt 未进入 provider capture",
      60_000,
    );
    // 回归：Host 动态 profile 曾绕过 Memory 工具补齐；直接检查 child 最终 wire，不能只看完成文本。
    const customRequest = (await readProviderCapture()).records
      .slice(providerCaptureStartIndex)
      .find((record) => record.replay?.fixtureId === "memory-window-custom-child-write")
      ?.requestJson as { tools?: Array<{ name: string }> } | undefined;
    const customTools = customRequest?.tools?.map((tool) => tool.name);
    expect(customTools).toEqual(expect.arrayContaining(["Grep", "Write", "Edit"]));
    expect(customTools).not.toContain("Read");
    const customContent = await waitForFileContaining(CUSTOM_MEMORY_FILE, CUSTOM_FILE_MARKER);
    expect(customContent).toMatch(/^\s*node_type:\s*memory\s*$/mu);
    expect(readOriginSessionId(customContent)).toMatch(/^sess_subagent_/u);

    const activeMemorySessionId = requireSessionId((await getV4PaneSnapshot()).sessionId);
    await setMemoryEnabled(false, activeMemorySessionId);
    expect(await readFile(REFRESHED_FILE, "utf8")).toContain(REFRESHED_MEMORY_FACT_MARKER);
    await sendV4Prompt(ACTIVE_AFTER_DISABLE_PROMPT);
    await waitForV4TimelineContaining(ACTIVE_AFTER_DISABLE_DONE, 90_000);
    await waitForUpstreamRequest(
      { includes: [ACTIVE_AFTER_DISABLE_PROMPT, "# Memory\n"] },
      "Settings 关闭后当前 Session 不应热更新 Memory",
      60_000,
    );
    expect(requireSessionId((await getV4PaneSnapshot()).sessionId)).toBe(activeMemorySessionId);

    await startNewV4Draft();
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(DISABLED_PROMPT);
    await waitForV4TimelineContaining(DISABLED_DONE, 90_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "Memory disabled turn 完成后 pane 没有回到 idle",
      60_000,
    );

    const providerCapture = await readProviderCapture();
    const currentRunRecords = providerCapture.records.slice(providerCaptureStartIndex);
    const expectedMainMemory = (await readMainMemoryFixture()).replaceAll(
      "<MEMORY_ROOT>",
      PROJECT_MEMORY_ROOT,
    );
    const expectedMainMemoryIndex = (await readMainMemoryIndexFixture()).replaceAll(
      "<MEMORY_INDEX_PATH>",
      PROJECT_MEMORY_INDEX,
    );
    const expectedUpdatedMainMemoryIndex = expectedMainMemoryIndex.replace(
      PROJECT_MEMORY_INDEX_CONTENT,
      PROJECT_MEMORY_UPDATED_INDEX_CONTENT,
    );
    for (const fixture of MEMORY_ENABLED_MAIN_FIXTURES) {
      const matchingRequests = currentRunRecords.filter(
        (record) => record.replay?.fixtureId === fixture.id,
      );
      expect(matchingRequests).toHaveLength(1);
      const request = matchingRequests[0]!;
      expect(extractMainMemorySection(request.requestJson)).toBe(expectedMainMemory);
      expect(extractMainMemoryIndexContext(request.requestJson)).toBe(
        fixture.index === "initial" ? expectedMainMemoryIndex : expectedUpdatedMainMemoryIndex,
      );
      // 指令段不再带 `# agentsMd` 标题；以共享说明开头，见 meta-user-context.md。
      expect(countCaptureOccurrences(request.requestJson, "# agentsMd")).toBe(0);
      expect(countCaptureOccurrences(request.requestJson, "# claudeMd")).toBe(0);
      expect(countCaptureOccurrences(request.requestJson, MAIN_MEMORY_INDEX_POINTER)).toBe(1);
    }
    expect(
      currentRunRecords.some((record) => captureContains(record.requestJson, SELECTOR_MARKER)),
    ).toBe(false);
    expect(
      currentRunRecords.some((record) =>
        captureContains(record.requestJson, RELEVANT_MEMORY_MARKER),
      ),
    ).toBe(false);

    const disabledRequests = currentRunRecords.filter((record) =>
      captureContains(record.requestJson, DISABLED_PROMPT),
    );
    expect(
      disabledRequests.filter(
        (record) => record.replay?.fixtureId === "memory-window-disabled-main",
      ),
    ).toHaveLength(2);
    for (const request of disabledRequests) {
      // 只看 Memory 段标题；默认 prompt 总带 `# Memory, notes and feedback`，那一段不算 Memory 注入。
      expect(captureContains(request.requestJson, "# Memory\n")).toBe(false);
      expect(captureContains(request.requestJson, MAIN_MEMORY_INDEX_SOURCE)).toBe(false);
      expect(captureContains(request.requestJson, SELECTOR_MARKER)).toBe(false);
      expect(captureContains(request.requestJson, EXTRACTION_MARKER)).toBe(false);
    }
    expect(
      currentRunRecords.filter((record) => !record.replay?.fixtureId).map((record) => record.id),
    ).toEqual([]);

    const finalPane = await getV4PaneSnapshot();
    expect(finalPane.timelineText).toContain(DISABLED_DONE);
  });
});

async function openMemorySettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (settingsPageTestId) =>
          Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "memory"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有 Memory 分区入口",
  });
  await browser.waitUntil(async () => (await readMemorySwitch()) !== null, {
    timeout: 15_000,
    timeoutMsg: "Memory 设置没有开关",
  });
}

async function verifyMemorySettingsViewer(expectedSessionId: string): Promise<void> {
  // Bug 根因：首个 disabled turn 回到 idle 后，标题生成仍可能在后台排队；若此时
  // 记录 provider 数量，异步 title request 会被错误归因到 Settings 页面。先等该
  // case 自己的 title fixture 完成，再保留“打开 Settings 不发请求”的原断言。
  await waitForMemoryTitleRequest();
  const requestCountBefore = (await readProviderCapture()).records.length;
  await openMemorySettings();

  await waitForMemoryFile("MEMORY.md", "默认 Workspace Scope 没有显示 MEMORY.md");
  await waitForMemoryFile("database-test-policy.md", "默认 Workspace Scope 没有显示事实文件");
  expect(await hasTestId(testId(TID_SETTINGS_MEMORY_FILE, "incident-review-policy.md"))).toBe(
    false,
  );

  const initialScope = await readMemoryScopePresentation();
  expect(initialScope.hasFolderIcon).toBe(true);
  expect(initialScope.countText).toMatch(/2/u);

  const memoryIndex = await readMemoryFilePresentation("MEMORY.md");
  expect(memoryIndex.tagName).toBe("DIV");
  expect(memoryIndex.role).toBeNull();
  expect(memoryIndex.hasFileIcon).toBe(true);
  expect(memoryIndex.fileName).toBe("MEMORY.md");
  expect(memoryIndex.updatedAt).not.toBe("");
  expect(memoryIndex.hasEditorSlot).toBe(true);

  await openMemoryScopeMenu();
  expect(await countOpenMemoryScopeOptions()).toBe(2);
  await clickMemoryWorkspaceOption(SECOND_PROJECT_MEMORY_WORKSPACE_ID);
  await waitForMemoryFile("MEMORY.md", "第二个 Workspace Scope 没有显示 MEMORY.md");
  await waitForMemoryFile("incident-review-policy.md", "第二个 Workspace Scope 没有显示事实文件");
  expect(await hasTestId(testId(TID_SETTINGS_MEMORY_FILE, "database-test-policy.md"))).toBe(false);
  const secondScope = await readMemoryScopePresentation();
  expect(secondScope.hasFolderIcon).toBe(true);
  expect(secondScope.label).toContain(SECOND_PROJECT_MEMORY_WORKSPACE_LABEL);
  expect(secondScope.countText).toMatch(/2/u);

  await setMemorySearch("INCIDENT-REVIEW");
  await waitForMemoryFile(
    "incident-review-policy.md",
    "Memory 文件名搜索没有忽略大小写命中当前 Scope",
  );
  await waitForMemoryFileHidden("MEMORY.md", "Memory 文件名搜索没有过滤不匹配文件");
  await clearMemorySearch();
  await waitForMemoryFile("MEMORY.md", "清空 Memory 搜索后没有恢复完整文件列表");

  await writeFile(
    REFRESHED_FILE,
    `---\nname: manual-refresh\ndescription: Added while Settings is open.\nmetadata:\n  type: reference\n---\n\n${REFRESHED_MEMORY_FACT_MARKER}\n`,
    "utf8",
  );
  expect(await hasTestId(testId(TID_SETTINGS_MEMORY_FILE, "manual-refresh.md"))).toBe(false);
  await clickTestIdByDom(TID_SETTINGS_MEMORY_REFRESH, {
    timeout: 15_000,
    timeoutMsg: "Project Memory viewer 没有刷新按钮",
  });
  await waitForMemoryFile("manual-refresh.md", "手动刷新后没有出现新增事实文件");
  expect(await hasTestId(testId(TID_SETTINGS_MEMORY_FILE, "database-test-policy.md"))).toBe(false);
  const refreshedScope = await readMemoryScopePresentation();
  expect(refreshedScope.label).toContain(SECOND_PROJECT_MEMORY_WORKSPACE_LABEL);
  expect(refreshedScope.countText).toMatch(/3/u);

  await verifyMemoryConflictReload("incident-review-policy.md", SECOND_PROJECT_MEMORY_FACT);

  expect((await readProviderCapture()).records).toHaveLength(requestCountBefore);
  await closeSettings(expectedSessionId);
}

// 回归：查看器内冲突「重新加载」与列表「刷新」必须使用不同 testid，
// 否则 E2E 与 DOM 查询会命中同一选择器的两个按钮；同时覆盖取消/确认丢弃草稿两条路径。
async function verifyMemoryConflictReload(fileName: string, filePath: string): Promise<void> {
  const originalContent = await readFile(filePath, "utf8");
  const externalContent = `${originalContent}\n${CONFLICT_EXTERNAL_MARKER}\n`;
  // 只有主体断言全部通过才允许清理失败向外抛出；主体失败时保留原始错误，不被清理错误覆盖。
  let verified = false;
  try {
    await clickTestIdByDom(testId(TID_SETTINGS_MEMORY_FILE_OPEN, fileName), {
      timeout: 15_000,
      timeoutMsg: `Memory 列表没有 ${fileName} 的页内查看入口`,
    });
    await waitForTestId(TID_SETTINGS_MEMORY_PREVIEW, "Memory 查看器没有显示正文预览");
    await clickTestIdByDom(TID_SETTINGS_MEMORY_EDIT, {
      timeout: 15_000,
      timeoutMsg: "Memory 查看器没有编辑按钮",
    });
    await waitForTestId(TID_SETTINGS_MEMORY_CONTENT, "Memory 查看器没有进入编辑态");
    await setMemoryDraft(CONFLICT_DRAFT_MARKER);

    // 草稿存在后由外部改写真实文件，保存时必须触发 PROJECT_MEMORY_FILE_CHANGED 冲突。
    await writeFile(filePath, externalContent, "utf8");
    await clickTestIdByDom(TID_SETTINGS_MEMORY_SAVE, {
      timeout: 15_000,
      timeoutMsg: "Memory 查看器没有保存按钮",
    });
    await waitForTestId(TID_SETTINGS_MEMORY_CONFLICT, "外部改写后保存没有出现冲突提示");
    // 冲突必须拒绝覆盖：磁盘上仍是外部写入的版本，而不是用户草稿。
    expect(await readFile(filePath, "utf8")).toBe(externalContent);

    expect(await countTestId(TID_SETTINGS_MEMORY_RELOAD)).toBe(1);
    expect(await countTestId(TID_SETTINGS_MEMORY_REFRESH)).toBe(1);

    // 取消丢弃：草稿与冲突提示保持不变。
    await clickTestIdByDom(TID_SETTINGS_MEMORY_RELOAD, {
      timeout: 15_000,
      timeoutMsg: "冲突后没有重新加载按钮",
    });
    await waitForTestId(TID_CONFIRM_DIALOG_CONFIRM, "重新加载没有弹出丢弃草稿确认");
    await clickConfirmDialogCancel();
    await browser.waitUntil(async () => !(await hasTestId(TID_CONFIRM_DIALOG_CONFIRM)), {
      timeout: 15_000,
      timeoutMsg: "取消丢弃后确认弹窗没有关闭",
    });
    expect(await readMemoryDraft()).toBe(CONFLICT_DRAFT_MARKER);
    expect(await hasTestId(TID_SETTINGS_MEMORY_CONFLICT)).toBe(true);

    // 确认丢弃：加载磁盘上的最新内容，退出编辑态与冲突态。
    await clickTestIdByDom(TID_SETTINGS_MEMORY_RELOAD, {
      timeout: 15_000,
      timeoutMsg: "取消后没有重新加载按钮",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeout: 15_000,
      timeoutMsg: "重新加载没有丢弃草稿确认按钮",
    });
    await browser.waitUntil(
      async () =>
        !(await hasTestId(TID_SETTINGS_MEMORY_CONFLICT)) &&
        (await readTestIdText(TID_SETTINGS_MEMORY_PREVIEW)).includes(CONFLICT_EXTERNAL_MARKER),
      { timeout: 15_000, timeoutMsg: "确认丢弃后没有加载最新文件内容" },
    );
    expect(await readTestIdText(TID_SETTINGS_MEMORY_PREVIEW)).not.toContain(CONFLICT_DRAFT_MARKER);
    expect(await hasTestId(TID_SETTINGS_MEMORY_CONTENT)).toBe(false);
    verified = true;
  } finally {
    await cleanupMemoryConflictFixture(filePath, originalContent, verified);
  }
}

// 还原 fixture 并关闭查看器。主体通过时清理失败必须暴露；主体已失败时只尽力清理，
// 否则清理错误（如脏草稿拦住 Escape）会覆盖真正的失败原因。
async function cleanupMemoryConflictFixture(
  filePath: string,
  originalContent: string,
  bodyVerified: boolean,
): Promise<void> {
  const cleanup = async (): Promise<void> => {
    await writeFile(filePath, originalContent, "utf8");
    // 主体中途失败时可能还停在丢弃草稿确认弹窗上；先取消它，再让 Escape 关闭查看器。
    if (await hasTestId(TID_CONFIRM_DIALOG_CONFIRM)) await clickConfirmDialogCancel();
    if (!(await hasTestId(TID_SETTINGS_MEMORY_VIEWER_DIALOG))) return;
    await browser.keys("Escape");
    // 脏草稿会让关闭先弹出丢弃确认；清理阶段的目标就是丢弃 fixture 草稿，直接确认。
    await browser.waitUntil(
      async () => {
        if (!(await hasTestId(TID_SETTINGS_MEMORY_VIEWER_DIALOG))) return true;
        if (await hasTestId(TID_CONFIRM_DIALOG_CONFIRM)) {
          await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 5_000 });
        }
        return false;
      },
      { timeout: 15_000, timeoutMsg: "Memory 查看器没有关闭" },
    );
  };
  if (bodyVerified) {
    await cleanup();
    return;
  }
  await cleanup().catch(() => undefined);
}

async function waitForTestId(testIdValue: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(() => hasTestId(testIdValue), { timeout: 15_000, timeoutMsg });
}

function countTestId(testIdValue: string): Promise<number> {
  return browser.execute(
    (currentTestId) => document.querySelectorAll(`[data-testid="${currentTestId}"]`).length,
    testIdValue,
  );
}

function readTestIdText(testIdValue: string): Promise<string> {
  return browser.execute(
    (currentTestId) =>
      document.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`)?.textContent ?? "",
    testIdValue,
  );
}

function readMemoryDraft(): Promise<string> {
  return browser.execute(
    (contentTestId) =>
      document.querySelector<HTMLTextAreaElement>(`[data-testid="${contentTestId}"]`)?.value ?? "",
    TID_SETTINGS_MEMORY_CONTENT,
  );
}

async function setMemoryDraft(value: string): Promise<void> {
  const dispatched = await browser.execute(
    ({ contentTestId, nextValue }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        `[data-testid="${contentTestId}"]`,
      );
      if (!textarea) return false;
      // 与 setMemorySearch 相同：用原生 setter + input 事件驱动受控 Textarea 的 onChange。
      // 必须走原型 setter，绕过 React 挂在实例上的 value tracker，否则 React 会认为值未变而忽略事件。
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(textarea, nextValue);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue }));
      return true;
    },
    { contentTestId: TID_SETTINGS_MEMORY_CONTENT, nextValue: value },
  );
  expect(dispatched).toBe(true);
  // DOM value 在 setter 调用后必然等于目标值，不能证明 React 收到了 onChange。
  // 读取 React 已提交的受控 props.value：只有 draft state 更新并重渲染后才会等于目标值。
  await browser.waitUntil(
    () =>
      browser.execute(
        ({ contentTestId, nextValue }) => {
          const textarea = document.querySelector<HTMLTextAreaElement>(
            `[data-testid="${contentTestId}"]`,
          );
          if (!textarea) return false;
          const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
          const props = propsKey
            ? (textarea as unknown as Record<string, { value?: unknown }>)[propsKey]
            : undefined;
          return props?.value === nextValue && textarea.value === nextValue;
        },
        { contentTestId: TID_SETTINGS_MEMORY_CONTENT, nextValue: value },
      ),
    { timeout: 5_000, timeoutMsg: "Memory 草稿输入没有被 React 受控 Textarea 接收" },
  );
}

// ConfirmDialog 的取消按钮没有专用 testid；它在确认按钮的同一按钮组内紧邻其前
// （requiredAcknowledgement 才会省略取消，Memory 丢弃确认不属于该类）。
async function clickConfirmDialogCancel(): Promise<void> {
  const clicked = await browser.execute((confirmTestId) => {
    const confirm = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (element) => element.dataset.testid === confirmTestId,
    );
    const cancel = confirm?.previousElementSibling;
    if (!(cancel instanceof HTMLButtonElement) || cancel.disabled) return false;
    cancel.click();
    return true;
  }, TID_CONFIRM_DIALOG_CONFIRM);
  expect(clicked).toBe(true);
}

async function openMemoryScopeMenu(): Promise<void> {
  await browser.waitUntil(
    async () => {
      if ((await countOpenMemoryScopeOptions()) > 0) return true;
      await browser.execute((triggerTestId) => {
        const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
        if (
          !(trigger instanceof HTMLButtonElement) ||
          trigger.disabled ||
          trigger.getAttribute("aria-expanded") === "true"
        ) {
          return;
        }
        // Bug 根因：普通 HTMLElement.click() 不会产生 Radix DropdownMenu 依赖的
        // pointerdown，而 WebDriver clickable 在 Linux Electron 容器会误判坐标。
        // 直接派发同语义 pointerdown，既绕开坐标又保留真实菜单打开边界。
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            buttons: 1,
            cancelable: true,
            isPrimary: true,
            pointerType: "mouse",
          }),
        );
      }, TID_SETTINGS_MEMORY_SCOPE_TRIGGER);
      return false;
    },
    {
      interval: 250,
      timeout: 15_000,
      timeoutMsg: "Project Memory Workspace Scope 菜单没有打开",
    },
  );
}

async function clickMemoryWorkspaceOption(workspaceId: string): Promise<void> {
  const optionTestId = testId(TID_SETTINGS_MEMORY_WORKSPACE, workspaceId);
  await clickTestIdByDom(optionTestId, {
    timeout: 15_000,
    timeoutMsg: `Project Memory Workspace Scope 没有显示 ${workspaceId}`,
  });
}

function countOpenMemoryScopeOptions(): Promise<number> {
  return browser.execute(
    (workspaceTestIdPrefix) =>
      document.querySelectorAll(`[data-testid^="${workspaceTestIdPrefix}"]`).length,
    TID_SETTINGS_MEMORY_WORKSPACE,
  );
}

function readMemoryScopePresentation(): Promise<{
  hasFolderIcon: boolean;
  label: string;
  countText: string;
}> {
  return browser.execute(
    (scopeTriggerTestId) => {
      const trigger = document.querySelector<HTMLElement>(
        `[data-testid="${scopeTriggerTestId.trigger}"]`,
      );
      const count = document.querySelector<HTMLElement>(
        `[data-testid="${scopeTriggerTestId.count}"]`,
      );
      return {
        hasFolderIcon: Boolean(
          trigger?.querySelector(`[data-testid="${scopeTriggerTestId.icon}"]`),
        ),
        label: trigger?.textContent?.trim() ?? "",
        countText: count?.textContent?.trim() ?? "",
      };
    },
    {
      count: TID_SETTINGS_MEMORY_COUNT,
      icon: TID_SETTINGS_MEMORY_SCOPE_ICON,
      trigger: TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
    },
  );
}

function readMemoryFilePresentation(fileName: string): Promise<{
  tagName: string | null;
  role: string | null;
  hasFileIcon: boolean;
  fileName: string;
  updatedAt: string;
  hasEditorSlot: boolean;
}> {
  return browser.execute(
    (fileTestId) => {
      const file = document.querySelector<HTMLElement>(`[data-testid="${fileTestId.row}"]`);
      const queryChild = (childTestId: string) =>
        document.querySelector<HTMLElement>(`[data-testid="${childTestId}"]`);
      return {
        tagName: file?.tagName ?? null,
        role: file?.getAttribute("role") ?? null,
        hasFileIcon: Boolean(queryChild(fileTestId.icon)),
        fileName: queryChild(fileTestId.name)?.textContent?.trim() ?? "",
        updatedAt: queryChild(fileTestId.updatedAt)?.textContent?.trim() ?? "",
        hasEditorSlot: Boolean(queryChild(fileTestId.editorActions)),
      };
    },
    {
      editorActions: testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, fileName),
      icon: testId(TID_SETTINGS_MEMORY_FILE_ICON, fileName),
      name: testId(TID_SETTINGS_MEMORY_FILE_NAME, fileName),
      row: testId(TID_SETTINGS_MEMORY_FILE, fileName),
      updatedAt: testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, fileName),
    },
  );
}

async function setMemorySearch(value: string): Promise<void> {
  const applied = await browser.execute(
    ({ searchTestId, nextValue }) => {
      const search = document.querySelector<HTMLInputElement>(`[data-testid="${searchTestId}"]`);
      if (!search) return false;

      // 修复原因：WebDriver setValue 在 React 受控 search input 重渲染时偶发丢键；
      // 使用原生 value setter 并派发 input 事件，仍由产品 onChange 驱动筛选状态。
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, nextValue);
      search.dispatchEvent(new InputEvent("input", { bubbles: true, data: nextValue }));
      return search.value === nextValue;
    },
    { nextValue: value, searchTestId: TID_SETTINGS_MEMORY_SEARCH_INPUT },
  );
  expect(applied).toBe(true);
}

async function clearMemorySearch(): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_MEMORY_SEARCH_CLEAR, {
    timeout: 5_000,
    timeoutMsg: "Memory 文件名搜索没有清空按钮",
  });
}

async function waitForMemoryFile(fileName: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(() => hasTestId(testId(TID_SETTINGS_MEMORY_FILE, fileName)), {
    timeout: 15_000,
    timeoutMsg,
  });
}

async function waitForMemoryFileHidden(fileName: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => !(await hasTestId(testId(TID_SETTINGS_MEMORY_FILE, fileName))),
    {
      timeout: 15_000,
      timeoutMsg,
    },
  );
}

function hasTestId(testIdValue: string): Promise<boolean> {
  return browser.execute(
    (currentTestId) => Boolean(document.querySelector(`[data-testid="${currentTestId}"]`)),
    testIdValue,
  );
}

async function closeSettings(expectedSessionId?: string): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页返回按钮没有出现",
  });
  await waitForV4Pane(
    (snapshot) =>
      expectedSessionId ? snapshot.sessionId === expectedSessionId : snapshot.sessionId !== null,
    expectedSessionId
      ? `返回工作区后没有恢复 Session ${expectedSessionId}`
      : "返回工作区后 V4 pane 没有恢复",
    30_000,
  );
}

async function setMemoryEnabled(enabled: boolean, expectedSessionId?: string): Promise<void> {
  await openMemorySettings();
  if ((await readMemorySwitch()) !== enabled) {
    await clickTestIdByDom(TID_SETTINGS_MEMORY_SWITCH, {
      timeout: 15_000,
      timeoutMsg: "Memory 开关不可点击",
    });
  }
  await browser.waitUntil(
    async () => {
      const checked = await readMemorySwitch();
      const persisted = (await readSettings()).memoryEnabled;
      return checked === enabled && persisted === enabled;
    },
    {
      timeout: 15_000,
      timeoutMsg: `Memory 设置没有持久化为 ${String(enabled)}`,
    },
  );
  await closeSettings(expectedSessionId);
}

function readMemorySwitch(): Promise<boolean | null> {
  return browser.execute((switchTestId) => {
    const control = document.querySelector<HTMLElement>(`[data-testid="${switchTestId}"]`);
    if (!control) return null;
    return (
      control.getAttribute("aria-checked") === "true" ||
      control.getAttribute("data-state") === "checked"
    );
  }, TID_SETTINGS_MEMORY_SWITCH);
}

async function seedMemoryFixtures() {
  await rm(PROJECT_MEMORY_ROOT, { force: true, recursive: true });
  await rm(SECOND_PROJECT_MEMORY_ROOT, { force: true, recursive: true });
  await mkdir(PROJECT_MEMORY_ROOT, { recursive: true });
  await writeFile(PROJECT_MEMORY_INDEX, `${PROJECT_MEMORY_INDEX_CONTENT}\n`, "utf8");
  await writeFile(
    EXISTING_FILE,
    `---
name: database-test-policy
description: Database tests must use the real database rather than mocks.
metadata:
  type: feedback
---

Use the real database for database tests; mocked database tests are not trusted.

**Why:** A prior mocked test passed while production migration behavior failed.

**How to apply:** Use the real database for database integration tests.
`,
    "utf8",
  );
  await mkdir(SECOND_PROJECT_MEMORY_ROOT, { recursive: true });
  await writeFile(SECOND_PROJECT_MEMORY_INDEX, `${SECOND_PROJECT_MEMORY_INDEX_CONTENT}\n`, "utf8");
  await writeFile(
    SECOND_PROJECT_MEMORY_FACT,
    "---\nname: incident-review-policy\ndescription: Preserve original incident evidence.\nmetadata:\n  type: reference\n---\n\nKeep the original incident evidence available for review.\n",
    "utf8",
  );

  await mkdir(dirname(PROFILE_FILE), { recursive: true });
  await writeFile(
    PROFILE_FILE,
    `---
name: ${PROFILE_NAME}
description: Maintain durable review conventions.
memory: project
tools: Grep
maxTurns: 4
---
Review and preserve durable collaboration guidance.
`,
    "utf8",
  );

  await mkdir(CUSTOM_MEMORY_ROOT, { recursive: true });
  await writeFile(
    join(CUSTOM_MEMORY_ROOT, "MEMORY.md"),
    "- [Review convention](review-convention.md): Keep review findings evidence-first.\n",
    "utf8",
  );
}

function resolveProjectMemoryRoot(workspacePath: string) {
  const normalizedWorkspace = resolve(workspacePath);
  const key =
    process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const slug = basename(normalizedWorkspace)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return join(
    getE2EAppDataPaths().storageRoot,
    "cli",
    "memories",
    "projects",
    `${slug || "project"}-${hash}`,
    "memory",
  );
}

async function waitForFileContaining(path: string, marker: string) {
  let latest = "";
  await browser.waitUntil(
    async () => {
      latest = await readFile(path, "utf8").catch(() => "");
      return latest.includes(marker);
    },
    {
      timeout: 60_000,
      timeoutMsg: `Memory 文件未出现 marker ${marker}; path=${path}; latest=${latest}`,
    },
  );
  return latest;
}

function readOriginSessionId(content: string) {
  const match = content.match(/^\s*originSessionId:\s*(\S+)\s*$/mu);
  if (!match?.[1]) throw new Error(`Memory 文件缺少 originSessionId:\n${content}`);
  return match[1];
}

function requireSessionId(sessionId: string | null) {
  if (!sessionId || sessionId === "draft") throw new Error(`无效 sessionId: ${sessionId}`);
  return sessionId;
}

async function readProviderCapture(): Promise<E2ENetworkCaptureArtifact> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) throw new Error("E2E_PROVIDER_CAPTURE_PATH 未配置");
  return JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
}

async function waitForMemoryTitleRequest(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const capture = await readProviderCapture();
      return capture.records.some(
        (record) =>
          record.replay?.fixtureId === "memory-window-title" && record.status === "complete",
      );
    },
    {
      timeout: 30_000,
      timeoutMsg: "Memory 首个 turn 的 title request 没有完成，无法稳定验证 Settings 不发请求",
    },
  );
}

async function readMainMemoryFixture(): Promise<string> {
  const content = normalizeTextFixtureLineEndings(
    await readFile(
      new URL(
        "../../../../../../apps/zcode-cli/packages/core/tests/fixtures/memory/main-memory-default-index.md",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

async function readMainMemoryIndexFixture(): Promise<string> {
  const content = normalizeTextFixtureLineEndings(
    await readFile(
      new URL(
        "../../../../../../apps/zcode-cli/packages/core/tests/fixtures/memory/main-memory-index.md",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function normalizeTextFixtureLineEndings(content: string): string {
  // 修复原因：Windows runner 会把 Markdown fixture checkout 为 CRLF，而 provider-visible
  // Memory 由 join("\n") 生成 LF；逐字合同必须比较文本语义，不能把工作树行尾当成产品差异。
  return content.replace(/\r\n?/gu, "\n");
}

function extractMainMemorySection(requestJson: unknown): string {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) {
    throw new Error("provider request body must be an object");
  }
  const system = (requestJson as Record<string, unknown>).system;
  const dynamicBlock = captureTextValues(system).find((text) => text.includes("# Memory\n\n"));
  if (!dynamicBlock) throw new Error("provider request is missing the Main Memory section");

  const start = dynamicBlock.indexOf("# Memory\n\n");
  // 环境段已移到 user 公告；system 里 Memory 后面紧接 Context management。
  const end = dynamicBlock.indexOf("\n\n# Context management", start);
  if (end < 0) throw new Error("provider request is missing the Context management boundary");
  return dynamicBlock.slice(start, end);
}

function extractMainMemoryIndexContext(requestJson: unknown): string {
  if (!requestJson || typeof requestJson !== "object" || Array.isArray(requestJson)) {
    throw new Error("provider request body must be an object");
  }
  const messages = (requestJson as Record<string, unknown>).messages;
  const contextBlock = captureTextValues(messages).find((text) =>
    text.includes(MAIN_MEMORY_INDEX_SOURCE),
  );
  if (!contextBlock) throw new Error("provider request is missing the Main MEMORY.md source");

  const contextStart = contextBlock.indexOf("Codebase and user instructions are shown below.");
  const firstSourceStart = contextBlock.indexOf("\n\nContents of ", contextStart);
  const memorySourceStart = contextBlock.indexOf(
    `Contents of ${PROJECT_MEMORY_INDEX} (${MAIN_MEMORY_INDEX_SOURCE}):`,
    firstSourceStart,
  );
  // 日期是单独的公告块，指令段在本块的 reminder 结束处收尾。
  const contextEnd = contextBlock.indexOf("\n</system-reminder>", memorySourceStart);
  if (contextStart < 0 || firstSourceStart < 0 || memorySourceStart < 0 || contextEnd < 0) {
    throw new Error("provider request has an invalid Main MEMORY.md context boundary");
  }
  // 修复原因：Request User Context 可同时承载 AGENTS.md 与 AutoMem；Memory fixture
  // 保留共享说明，跳过可选的 AGENTS.md source，再逐字校验 AutoMem source。
  return `${contextBlock.slice(contextStart, firstSourceStart)}\n\n${contextBlock.slice(
    memorySourceStart,
    contextEnd,
  )}`;
}

function captureTextValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(captureTextValues);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(captureTextValues);
}

function captureContains(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => captureContains(item, marker));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => captureContains(item, marker));
}

function countCaptureOccurrences(value: unknown, marker: string): number {
  if (typeof value === "string") return value.split(marker).length - 1;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countCaptureOccurrences(item, marker), 0);
  }
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce(
    (total, item) => total + countCaptureOccurrences(item, marker),
    0,
  );
}

/** 真实网络上报验证开关维度；后台 Extraction 的结果不影响该值。 */
async function expectMemoryTelemetry(
  telemetryFetch: Awaited<ReturnType<typeof browser.electron.mock>>,
  sessionId: string,
  expected: "0" | "1",
): Promise<void> {
  let reports: Array<{ element_name: string; event_extra_detail: Record<string, unknown> }> = [];
  const events = ["send_btn", "message_completion", "agent_step"];
  await browser.waitUntil(
    async () => {
      await telemetryFetch.update();
      reports = telemetryFetch.mock.calls.flatMap(([input, init]) => {
        if (!String(input).includes("/api/v1/event/report")) return [];
        const body = (init as { body?: string } | undefined)?.body;
        if (!body) return [];
        const report = JSON.parse(body);
        return report.talk_id === sessionId && events.includes(report.element_name) ? [report] : [];
      });
      return events.every((name) => reports.some((report) => report.element_name === name));
    },
    { timeout: 15_000, timeoutMsg: "Memory 三类埋点未完整上报" },
  );
  for (const report of reports) expect(report.event_extra_detail.memory_enabled).toBe(expected);
}
