import { describe, expect, it } from "vitest";
import { ProviderError, type ChatMessage, type ChatRequest, type ToolSpec } from "../../src/providers/types.js";
import { buildAnthropicBody, createAnthropicClient, thinkingBudget } from "../../src/providers/wire/anthropic.js";
import { collect, collectUntilError, doneOf, fakeFetch, jsonResponse, reasoningOf, sse, sseResponse, textOf } from "./helpers.js";

const editFile: ToolSpec = {
  name: "edit_file",
  description: "Edit a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
    required: ["path", "old", "new"],
  },
};
const bash: ToolSpec = {
  name: "bash",
  description: "Run a command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "claude-sonnet-4-5",
    system: "You are orion, a worker.",
    messages: [{ role: "user", content: "Fix the typo" }],
    tools: [editFile, bash],
    ...over,
  };
}

const ev = (type: string, fields: Record<string, unknown> = {}) => ({ event: type, data: { type, ...fields } });

const thinkingBlock = { type: "thinking", thinking: "The typo is in README.", signature: "ErUBCkYIBRgCIkD..." };

/** A realistic stream: thinking with signature, text, two tool_use blocks with split JSON. */
function toolStream(): string {
  const args1 = '{"path": "README.md", "old": "teh", "new": "the"}';
  const args2 = '{"command": "git diff --stat"}';
  const parts = (s: string) => [s.slice(0, 1), s.slice(1, 9), s.slice(9, 10), s.slice(10, 23), s.slice(23)];
  return sse([
    ev("message_start", {
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 312, cache_creation_input_tokens: 2048, cache_read_input_tokens: 9000, output_tokens: 4 },
      },
    }),
    ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("ping"),
    ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "The typo is " } }),
    ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "in README." } }),
    ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "ErUBCkYIBRgCIkD..." } }),
    ev("content_block_stop", { index: 0 }),
    ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Fixing \u00e9\u00e8 " } }),
    ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "it now." } }),
    ev("content_block_stop", { index: 1 }),
    ev("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_01A", name: "edit_file", input: {} } }),
    ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "" } }),
    ...parts(args1).map((p) => ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: p } })),
    ev("content_block_stop", { index: 2 }),
    ev("content_block_start", { index: 3, content_block: { type: "tool_use", id: "toolu_01B", name: "bash", input: {} } }),
    ...parts(args2).map((p) => ev("content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: p } })),
    ev("content_block_stop", { index: 3 }),
    ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 187 } }),
    ev("message_stop"),
  ]);
}

describe("anthropic request", () => {
  it("sends x-api-key and anthropic-version, never Authorization", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(toolStream()));
    await collect(
      createAnthropicClient({ baseURL: "https://api.anthropic.com/v1/", apiKey: "sk-ant-1", headers: { "anthropic-beta": "context-1m-2025-08-07" } }, fetch).stream(
        request(),
      ),
    );
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers).toEqual({
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-ant-1",
      "anthropic-beta": "context-1m-2025-08-07",
    });
    const noKey = fakeFetch(sseResponse(toolStream()));
    await collect(createAnthropicClient({ baseURL: "https://opencode.ai/zen/v1" }, noKey.fetch).stream(request()));
    expect(noKey.calls[0].headers["x-api-key"]).toBeUndefined();
    expect(Object.keys(noKey.calls[0].headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("folds tool results into one user message and keeps the roles alternating", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(toolStream()));
    const messages: ChatMessage[] = [
      { role: "user", content: "Fix the typo and show the diff" },
      {
        role: "assistant",
        content: "Fixing it now.",
        toolCalls: [
          { id: "toolu_01A", name: "edit_file", arguments: { path: "README.md", old: "teh", new: "the" } },
          { id: "toolu_01B", name: "bash", arguments: { command: "git diff --stat" } },
        ],
        raw: {
          wire: "anthropic",
          data: [
            thinkingBlock,
            { type: "redacted_thinking", data: "EmwKAhgB..." },
            { type: "text", text: "Fixing it now." },
            { type: "tool_use", id: "toolu_01A", name: "edit_file", input: { path: "README.md", old: "teh", new: "the" } },
            { type: "tool_use", id: "toolu_01B", name: "bash", input: { command: "git diff --stat" } },
          ],
        },
      },
      { role: "tool", toolCallId: "toolu_01A", name: "edit_file", content: "Edited README.md" },
      { role: "tool", toolCallId: "toolu_01B", name: "bash", content: "", isError: true },
      { role: "user", content: "[from luna] also update CHANGELOG" },
      // an assistant from another wire: rebuilt, empty text left out
      { role: "assistant", content: "", toolCalls: [{ id: "call_9", name: "bash", arguments: { command: "ls" } }], raw: { wire: "openai-chat", data: {} } },
      { role: "tool", toolCallId: "call_9", name: "bash", content: "CHANGELOG.md\nREADME.md" },
    ];
    await collect(createAnthropicClient({ baseURL: "https://api.anthropic.com/v1", apiKey: "k", body: { metadata: { user_id: "u1" } } }, fetch).stream(request({ messages })));
    const body = calls[0].body;
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Fix the typo and show the diff" }] },
      {
        role: "assistant",
        content: [
          thinkingBlock,
          { type: "redacted_thinking", data: "EmwKAhgB..." },
          { type: "text", text: "Fixing it now." },
          { type: "tool_use", id: "toolu_01A", name: "edit_file", input: { path: "README.md", old: "teh", new: "the" } },
          { type: "tool_use", id: "toolu_01B", name: "bash", input: { command: "git diff --stat" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01A", content: "Edited README.md", is_error: false },
          { type: "tool_result", tool_use_id: "toolu_01B", content: "(no output)", is_error: true },
          { type: "text", text: "[from luna] also update CHANGELOG" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "bash", input: { command: "ls" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_9",
            content: "CHANGELOG.md\nREADME.md",
            is_error: false,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(body.system).toEqual([{ type: "text", text: "You are orion, a worker.", cache_control: { type: "ephemeral" } }]);
    expect(body.tools).toEqual([
      { name: "edit_file", description: "Edit a file", input_schema: editFile.parameters },
      { name: "bash", description: "Run a command", input_schema: bash.parameters },
    ]);
    expect(body.max_tokens).toBe(16000);
    expect(body.stream).toBe(true);
    expect(body.metadata).toEqual({ user_id: "u1" });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("temperature");
    // the stored raw blocks were not changed by the cache marker
    expect(messages[1].role === "assistant" && (messages[1].raw?.data as unknown[]).length).toBe(5);
  });

  it("puts tool results before text that came earlier in the same user turn", () => {
    const body = buildAnthropicBody(
      request({
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "bash", arguments: {} }] },
          { role: "user", content: "[from lyra] hi" },
          { role: "tool", toolCallId: "t1", name: "bash", content: "ok" },
        ],
      }),
      { baseURL: "https://x" },
    );
    expect((body.messages as Array<{ content: Array<{ type: string }> }>)[2].content.map((b) => b.type)).toEqual(["tool_result", "text"]);
  });

  it("merges consecutive user messages and drops empty ones", () => {
    const body = buildAnthropicBody(
      request({
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "" },
          { role: "user", content: "second" },
        ],
        system: "",
        tools: [],
      }),
      { baseURL: "https://x" },
    );
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(body).not.toHaveProperty("system");
    expect(body).not.toHaveProperty("tools");
  });

  it("turns reasoning effort into a thinking budget below max_tokens", () => {
    expect(thinkingBudget("low")).toBe(2048);
    expect(thinkingBudget("medium")).toBe(8192);
    expect(thinkingBudget("high")).toBe(16384);
    expect(thinkingBudget("xhigh")).toBe(32000);
    expect(thinkingBudget("max")).toBe(32000);
    expect(thinkingBudget("none")).toBeNull();
    expect(thinkingBudget(undefined)).toBeNull();

    const medium = buildAnthropicBody(request({ reasoningEffort: "medium", temperature: 0.3 }), { baseURL: "https://x" });
    expect(medium.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(medium.max_tokens).toBe(16000);
    expect(medium).not.toHaveProperty("temperature");

    // default max_tokens is raised above the budget
    const high = buildAnthropicBody(request({ reasoningEffort: "high" }), { baseURL: "https://x" });
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(high.max_tokens as number).toBeGreaterThan(16384);

    // an explicit max_tokens (the model's limit) is kept and the budget shrinks under it
    const capped = buildAnthropicBody(request({ reasoningEffort: "xhigh", maxTokens: 32000 }), { baseURL: "https://x" });
    expect(capped.max_tokens).toBe(32000);
    expect((capped.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(32000);
    expect((capped.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThanOrEqual(1024);

    const tiny = buildAnthropicBody(request({ reasoningEffort: "low", maxTokens: 1000 }), { baseURL: "https://x" });
    expect(tiny.max_tokens as number).toBeGreaterThan((tiny.thinking as { budget_tokens: number }).budget_tokens);

    const plain = buildAnthropicBody(request({ temperature: 0.3 }), { baseURL: "https://x" });
    expect(plain.temperature).toBe(0.3);
  });
});

describe("anthropic stream", () => {
  it("streams thinking, text and tool calls with arguments split across chunks", async () => {
    const { fetch } = fakeFetch(sseResponse(toolStream(), [5, 1, 12, 3, 40]));
    const out = await collect(createAnthropicClient({ baseURL: "https://api.anthropic.com/v1", apiKey: "k" }, fetch).stream(request()));

    expect(reasoningOf(out)).toBe("The typo is in README.");
    expect(textOf(out)).toBe("Fixing \u00e9\u00e8 it now.");
    const calls = out.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls).toEqual([
      { id: "toolu_01A", name: "edit_file", arguments: { path: "README.md", old: "teh", new: "the" } },
      { id: "toolu_01B", name: "bash", arguments: { command: "git diff --stat" } },
    ]);
    expect(out.slice(-2).map((e) => e.type)).toEqual(["usage", "done"]);
    expect(out.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      inputTokens: 312 + 9000 + 2048,
      outputTokens: 187,
      cacheReadTokens: 9000,
      cacheWriteTokens: 2048,
    });
    const done = doneOf(out);
    expect(done.stopReason).toBe("tool_use");
    expect(done.message.content).toBe("Fixing \u00e9\u00e8 it now.");
    expect(done.message.reasoning).toBe("The typo is in README.");
    expect(done.message.toolCalls).toEqual(calls);
    expect(done.message.raw).toEqual({
      wire: "anthropic",
      data: [
        { type: "thinking", thinking: "The typo is in README.", signature: "ErUBCkYIBRgCIkD..." },
        { type: "text", text: "Fixing \u00e9\u00e8 it now." },
        { type: "tool_use", id: "toolu_01A", name: "edit_file", input: { path: "README.md", old: "teh", new: "the" } },
        { type: "tool_use", id: "toolu_01B", name: "bash", input: { command: "git diff --stat" } },
      ],
    });
  });

  it("round-trips: the raw blocks of an answer go back verbatim on the next request", async () => {
    const first = fakeFetch(sseResponse(toolStream()));
    const out = await collect(createAnthropicClient({ baseURL: "https://api.anthropic.com/v1" }, first.fetch).stream(request()));
    const assistant = doneOf(out).message;
    const second = fakeFetch(sseResponse(toolStream()));
    await collect(
      createAnthropicClient({ baseURL: "https://api.anthropic.com/v1" }, second.fetch).stream(
        request({
          messages: [
            { role: "user", content: "Fix the typo" },
            assistant,
            { role: "tool", toolCallId: "toolu_01A", name: "edit_file", content: "ok" },
            { role: "tool", toolCallId: "toolu_01B", name: "bash", content: " README.md | 2 +-" },
          ],
        }),
      ),
    );
    const sent = second.calls[0].body.messages;
    expect(sent[1]).toEqual({ role: "assistant", content: assistant.raw?.data });
    expect(sent[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(["toolu_01A", "toolu_01B"]);
  });

  it("handles an empty tool input, redacted thinking, and a missing message_stop", async () => {
    const text = sse([
      ev("message_start", { message: { usage: { input_tokens: 20, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "EmwKAhgBEgy..." } }),
      ev("content_block_stop", { index: 0 }),
      ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_X", name: "list_agents", input: {} } }),
      ev("content_block_stop", { index: 1 }),
      ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }),
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const out = await collect(createAnthropicClient({ baseURL: "https://api.minimax.io/anthropic/v1" }, fetch).stream(request()));
    const done = doneOf(out);
    expect(done.message.toolCalls).toEqual([{ id: "toolu_X", name: "list_agents", arguments: {} }]);
    expect(done.message.raw?.data).toEqual([
      { type: "redacted_thinking", data: "EmwKAhgBEgy..." },
      { type: "tool_use", id: "toolu_X", name: "list_agents", input: {} },
    ]);
    expect(done.message.content).toBe("");
    expect(out.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 20, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("reports max_tokens and finishes a cut-off tool call", async () => {
    const text = sse([
      ev("message_start", { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_C", name: "bash", input: {} } }),
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"command": "npm' } }),
      ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 64 } }),
      ev("message_stop"),
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const out = await collect(createAnthropicClient({ baseURL: "https://x/v1" }, fetch).stream(request()));
    const done = doneOf(out);
    expect(done.stopReason).toBe("max_tokens");
    expect(done.message.toolCalls).toEqual([{ id: "toolu_C", name: "bash", arguments: { command: "npm" } }]);
  });

  it("separates text blocks around a tool call", async () => {
    const text = sse([
      ev("message_start", { message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Checking." } }),
      ev("content_block_stop", { index: 0 }),
      ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Done." } }),
      ev("content_block_stop", { index: 1 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
      ev("message_stop"),
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const out = await collect(createAnthropicClient({ baseURL: "https://x/v1" }, fetch).stream(request()));
    expect(textOf(out)).toBe("Checking.\n\nDone.");
    expect(doneOf(out).message.content).toBe("Checking.\n\nDone.");
    expect(doneOf(out).stopReason).toBe("end_turn");
  });
});

describe("anthropic errors", () => {
  it("maps an overloaded error event to a retryable 529", async () => {
    const text = sse([
      ev("message_start", { message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const { events, error } = await collectUntilError(createAnthropicClient({ baseURL: "https://x/v1" }, fetch).stream(request()));
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 529, message: "Overloaded" });
    expect((error as ProviderError).retryable).toBe(true);
  });

  it("maps other in-stream errors by type, unknown ones to 500", async () => {
    const run = async (type: string) => {
      const { fetch } = fakeFetch(sseResponse(sse([{ event: "error", data: { type: "error", error: { type, message: "x" } } }])));
      return (await collectUntilError(createAnthropicClient({ baseURL: "https://x/v1" }, fetch).stream(request()))).error as ProviderError;
    };
    expect((await run("rate_limit_error")).status).toBe(429);
    expect((await run("invalid_request_error")).status).toBe(400);
    expect((await run("api_error")).status).toBe(500);
    expect((await run("brand_new_error")).status).toBe(500);
  });

  it("maps a 401 JSON error and a 429 with Retry-After", async () => {
    const unauthorized = fakeFetch(
      jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_1" }),
    );
    const a = await collectUntilError(createAnthropicClient({ baseURL: "https://x/v1", apiKey: "bad" }, unauthorized.fetch).stream(request()));
    expect(a.error).toMatchObject({ status: 401, message: "invalid x-api-key", retryAfterMs: null });
    expect((a.error as ProviderError).retryable).toBe(false);

    const limited = fakeFetch(
      jsonResponse(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }, { "retry-after": "21" }),
    );
    const b = await collectUntilError(createAnthropicClient({ baseURL: "https://x/v1" }, limited.fetch).stream(request()));
    expect(b.error).toMatchObject({ status: 429, retryAfterMs: 21_000 });
  });

  it("fails when the stream ends mid-message", async () => {
    const text = sse([
      ev("message_start", { message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Half a sen" } }),
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const { events, error } = await collectUntilError(createAnthropicClient({ baseURL: "https://x/v1" }, fetch).stream(request()));
    expect(textOf(events)).toBe("Half a sen");
    expect(error).toMatchObject({ status: 502 });
  });
});
