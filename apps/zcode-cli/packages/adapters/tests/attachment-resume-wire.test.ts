import { png, fixture } from "./attachment-resume-wire-fixture.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createTraceId,
  type AttachmentStorageMetadata,
  type ModelInputFormat,
  type ModelInputMessage,
} from "@zcode/contracts";
import type { TurnAttachment } from "../../core/src/runtime/deps.js";
import { resolveTurnAttachments } from "../../core/src/runtime/helpers/attachments.js";
import { buildRuntimeUserEntriesFromTurn } from "../../core/src/runtime/helpers/conversation.js";
import { projectMessagesWithMediaAttachmentPaths } from "../../core/src/runtime/helpers/media-attachment-path.js";
import { buildProviderRequestMessages } from "../../core/src/runtime/helpers/provider-request-messages.js";
import { toAiSdkMessages } from "../src/model/transform.js";

const FULL_INPUT_FORMAT: ModelInputFormat = {
  supportsText: true,
  supportsImage: true,
  supportsAudio: false,
  supportsVideo: true,
  supportsPdf: true,
};
const TRACE_CONTEXT = { traceId: createTraceId() };

const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.7\nfixture").toString("base64")}`;
const scenarios: Array<{ name: string; attachments: TurnAttachment[] }> = [
  { name: "binary path", attachments: [{ type: "file", path: "bundle.zip" }] },
  {
    name: "clipboard path",
    attachments: [{ type: "file", path: "pasted.txt", sourceKind: "clipboard-text" }],
  },
  { name: "PDF", attachments: [{ type: "pdf", filename: "report.pdf", content: pdf }] },
  {
    name: "mixed media",
    attachments: [
      { type: "image", content: png },
      { type: "pdf", filename: "report.pdf", content: pdf },
      { type: "video", content: "data:video/mp4;base64,dmlkZW8=" },
      { type: "image", content: png },
    ],
  },
  { name: "text file", attachments: [{ type: "file", path: "notes.md" }] },
  { name: "inline text", attachments: [{ type: "file", content: "inline notes" }] },
  { name: "no attachment", attachments: [] },
];

async function captureWire(messages: ModelInputMessage[], kind: "anthropic" | "openai") {
  let captured: unknown;
  const fetch = async (_input: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return Response.json(
      kind === "anthropic"
        ? {
            id: "fixture",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
    );
  };
  const options = { apiKey: "fixture-key", baseURL: "https://provider.example/v1", fetch };
  const model =
    kind === "anthropic"
      ? createAnthropic(options)("fixture")
      : createOpenAICompatible({ ...options, name: "fixture" })("fixture");
  await generateText({
    model,
    maxRetries: 0,
    messages: toAiSdkMessages(messages, {
      inputFormat: FULL_INPUT_FORMAT,
    }),
  });
  expect(captured).toBeDefined();
  return captured;
}

describe("attachment history across durable cold resume", () => {
  for (const scenario of scenarios) {
    it.each(scenario.attachments.length ? ["Summarize the attachment.", ""] : ["Text only."])(
      `${scenario.name}, prompt=%j: preserves final SDK request`,
      async (prompt) => {
        const f = await fixture();
        try {
          const resolved = await resolveTurnAttachments(scenario.attachments, {
            ...f.runtime,
            traceContext: TRACE_CONTEXT,
          });
          f.history.addEntries(buildRuntimeUserEntriesFromTurn(prompt, resolved));
          await f.runtime.persistUserPrompt(
            createMessageId("first"),
            prompt,
            resolved,
            TRACE_CONTEXT,
          );
          const cold = await f.cold();
          for (const attachment of resolved.filter((a) => a.metadata.storageKind === "local_ref")) {
            const part = cold.messages[0]!.parts.find(
              (p) => p.type === "file" && p.url === attachment.url,
            );
            expect(part).toMatchObject({
              metadata: {
                pathReferenceText:
                  attachment.contentBlock.type === "text"
                    ? attachment.contentBlock.text
                    : undefined,
              },
            });
          }
          for (const useMidConversationSystem of [false, true]) {
            const requests = await Promise.all(
              [f.history, cold.history].map(async (history) => {
                const entries = [
                  ...history.toRuntimeEntries(),
                  { message: { role: "assistant" as const, content: "done" } },
                  {
                    message: { role: "user" as const, content: "Continue." },
                    metadata: { source: "real_user" as const },
                  },
                ];
                const { messages } = buildProviderRequestMessages({
                  entries,
                  useMidConversationSystem,
                  applyCacheControl: true,
                });
                return projectMessagesWithMediaAttachmentPaths(messages, f.artifactStore);
              }),
            );
            for (const provider of ["anthropic", "openai"] as const) {
              expect(await captureWire(requests[1]!, provider)).toEqual(
                await captureWire(requests[0]!, provider),
              );
            }
          }
          expect((await f.cold()).history.toRuntimeEntries()).toEqual(
            cold.history.toRuntimeEntries(),
          );
        } finally {
          await f.close();
        }
      },
    );
  }

  it("keeps local images in submission order even when hydration rebuilds their media source as inline", async () => {
    const f = await fixture();
    try {
      const resolved = await resolveTurnAttachments(
        [
          { type: "image", content: png },
          { type: "image", path: "local.png" },
          { type: "pdf", content: pdf, filename: "report.pdf" },
        ],
        { ...f.runtime, traceContext: TRACE_CONTEXT },
      );
      f.history.addEntries(buildRuntimeUserEntriesFromTurn("Compare.", resolved));
      await f.runtime.persistUserPrompt(
        createMessageId("mixed-local"),
        "Compare.",
        resolved,
        TRACE_CONTEXT,
      );
      const cold = await f.cold();
      // 这里只比较媒体与正文合同；local path 到 artifact 派生 path 的既有投影单独测试。
      const requests = [f.history, cold.history].map(
        (h) => buildProviderRequestMessages({ entries: h.toRuntimeEntries() }).messages,
      );
      const transformOptions = {
        inputFormat: FULL_INPUT_FORMAT,
      };
      const first = toAiSdkMessages(requests[0]!, transformOptions);
      expect(toAiSdkMessages(requests[1]!, transformOptions)).toEqual(first);
      const user = requests[0]!.find((m) => m.role === "user")!;
      expect(Array.isArray(user.content) && user.content.map((b) => b.type)).toEqual([
        "text",
        "image",
        "file",
        "image",
      ]);
    } finally {
      await f.close();
    }
  });

  it.each([undefined, 42, { text: "invalid" }])(
    "keeps the legacy placeholder when saved path text is %j",
    async (pathReferenceText) => {
      const f = await fixture();
      try {
        const resolved = await resolveTurnAttachments([{ type: "file", path: "bundle.zip" }], {
          ...f.runtime,
          traceContext: TRACE_CONTEXT,
        });
        resolved[0]!.metadata = {
          ...resolved[0]!.metadata,
          pathReferenceText,
        } as AttachmentStorageMetadata;
        await f.runtime.persistUserPrompt(
          createMessageId("legacy"),
          "Prompt",
          resolved,
          TRACE_CONTEXT,
        );
        const cold = await f.cold();
        expect(
          buildProviderRequestMessages({ entries: cold.history.toRuntimeEntries() }).messages.at(-1)
            ?.content,
        ).toEqual([
          { type: "text", text: "Prompt" },
          { type: "text", text: "[Attached application/octet-stream: bundle.zip]" },
        ]);
      } finally {
        await f.close();
      }
    },
  );

  it("preserves uploaded artifact-backed text (.json/.vue/empty) and binary/.log files across cold resume", async () => {
    const f = await fixture();
    try {
      const jsonContent = '{"service":"zcode","ok":true}';
      const vueContent = "<template><p>Hello</p></template>\n";
      const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xaa, 0xbb]);
      const largeLogBytes = Buffer.from("log-entry\n".repeat(8000));

      const upload = async (name: string, mime: string, bytes: Buffer) =>
        f.artifactStore.writeToolResultArtifact({
          sessionId: f.runtime.sessionId,
          toolCallId: `upload-${name}`,
          toolName: "prompt-attachment:upload",
          content: `data:${mime};base64,${bytes.toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
        });

      const [jsonArt, vueArt, emptyArt, zipArt, logArt] = await Promise.all([
        upload("config.json", "application/json", Buffer.from(jsonContent)),
        upload("App.vue", "application/octet-stream", Buffer.from(vueContent)),
        upload("empty.txt", "text/plain", Buffer.alloc(0)),
        upload("archive.zip", "application/zip", zipBytes),
        upload("app.log", "text/plain", largeLogBytes),
      ]);

      const resolved = await resolveTurnAttachments(
        [
          {
            type: "file",
            content: jsonArt.uri,
            filename: "config.json",
            mimeType: "application/json",
          },
          {
            type: "file",
            content: vueArt.uri,
            filename: "App.vue",
            mimeType: "application/octet-stream",
          },
          { type: "file", content: emptyArt.uri, filename: "empty.txt", mimeType: "text/plain" },
          {
            type: "file",
            content: zipArt.uri,
            filename: "archive.zip",
            mimeType: "application/zip",
          },
          { type: "file", content: logArt.uri, filename: "app.log", mimeType: "text/plain" },
        ],
        { ...f.runtime, traceContext: TRACE_CONTEXT },
      );

      f.history.addEntries(buildRuntimeUserEntriesFromTurn("Inspect uploaded files.", resolved));
      await f.runtime.persistUserPrompt(
        createMessageId("uploaded-files"),
        "Inspect uploaded files.",
        resolved,
        TRACE_CONTEXT,
      );

      const cold = await f.cold();
      const zipPart = cold.messages[0]!.parts.find(
        (p) => p.type === "file" && p.filename === "archive.zip",
      );
      expect(zipPart).toMatchObject({
        type: "file",
        metadata: {
          artifactUri: zipArt.uri,
          originalUrl: zipArt.uri,
          storageKind: "local_ref",
        },
      });
      expect(zipPart?.type === "file" && zipPart.url).not.toBe(zipArt.uri);
      expect(zipPart?.type === "file" && zipPart.url.startsWith("zcode-artifact://")).toBe(true);

      const liveMessages = buildProviderRequestMessages({
        entries: f.history.toRuntimeEntries(),
      }).messages;
      const coldMessages = buildProviderRequestMessages({
        entries: cold.history.toRuntimeEntries(),
      }).messages;
      expect(coldMessages).toEqual(liveMessages);
      const coldText = coldMessages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
        )
        .join("\n");
      expect(coldText).toContain(jsonContent);
      expect(coldText).toContain(vueContent);
      for (const provider of ["anthropic", "openai"] as const) {
        expect(await captureWire(coldMessages, provider)).toEqual(
          await captureWire(liveMessages, provider),
        );
      }
    } finally {
      await f.close();
    }
  });

  it("preserves uploaded clipboard-text dual artifact URIs across cold resume and listArtifactReferrers", async () => {
    const f = await fixture();
    try {
      const clipboardText = "clipboard line 1\nclipboard line 2\n";
      const uploadArt = await f.artifactStore.writeToolResultArtifact({
        sessionId: f.runtime.sessionId,
        toolCallId: "upload-clipboard",
        toolName: "prompt-attachment:upload",
        content: `data:text/plain;charset=utf-8;base64,${Buffer.from(clipboardText).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
      });
      const resolved = await resolveTurnAttachments(
        [
          {
            type: "file",
            content: uploadArt.uri,
            filename: "pasted.txt",
            mimeType: "text/plain",
            sourceKind: "clipboard-text",
          },
        ],
        { ...f.runtime, traceContext: TRACE_CONTEXT },
      );

      expect(resolved[0]).toMatchObject({
        metadata: {
          artifactUri: uploadArt.uri,
          originalUrl: uploadArt.uri,
          storageKind: "local_ref",
        },
      });
      expect(resolved[0]?.url).toMatch(/^zcode-artifact:\/\//);
      expect(resolved[0]?.url).not.toBe(uploadArt.uri);

      f.history.addEntries(buildRuntimeUserEntriesFromTurn("Inspect clipboard.", resolved));
      await f.runtime.persistUserPrompt(
        createMessageId("clip-msg-1"),
        "Inspect clipboard.",
        resolved,
        TRACE_CONTEXT,
      );

      const cold = await f.cold();
      expect(
        buildProviderRequestMessages({ entries: cold.history.toRuntimeEntries() }).messages,
      ).toEqual(buildProviderRequestMessages({ entries: f.history.toRuntimeEntries() }).messages);

      const forkId = createSessionId("attachment-resume-fork");
      await f.runtime.sessionStore!.createSession({
        id: forkId,
        projectID: createProjectId("fixture"),
        slug: "fork",
        directory: f.root,
        title: "fork",
        version: "1",
      });
      const clipPart = cold.messages[0]!.parts.find((p) => p.type === "file")!;
      await f.runtime.sessionStore!.saveMessage({
        id: createMessageId("fork-clip-msg"),
        sessionID: forkId,
        role: "user",
        time: { created: Date.now() },
        agent: "fixture",
      });
      await f.runtime.sessionStore!.savePart({
        ...clipPart,
        id: createPartId("fork-clip-part"),
        sessionID: forkId,
        messageID: createMessageId("fork-clip-msg"),
      });

      const referrers = await f.runtime.sessionStore!.listArtifactReferrers?.([
        f.runtime.sessionId,
      ]);
      expect(referrers?.get(f.runtime.sessionId)).toEqual([forkId]);
    } finally {
      await f.close();
    }
  });
});
