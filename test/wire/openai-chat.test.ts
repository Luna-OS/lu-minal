import { describe, expect, it } from "vitest";
import { ProviderError, type ChatMessage, type ChatRequest, type ToolSpec } from "../../src/providers/types.js";
import { createOpenAIChatClient } from "../../src/providers/wire/openai-chat.js";
import {
  collect,
  collectUntilError,
  doneOf,
  fakeFetch,
  jsonResponse,
  reasoningOf,
  sse,
  sseResponse,
  textOf,
} from "./helpers.js";

const readFile: ToolSpec = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const bash: ToolSpec = {
  name: "bash",
  description: "Run a command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "deepseek/deepseek-v3.2",
    system: "You are luna, the lead.",
    messages: [{ role: "user", content: "Read PLAN.md" }],
    tools: [readFile, bash],
    ...over,
  };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  data: {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1761390000,
    model: "deepseek-chat",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  },
});

const usageChunk = (usage: Record<string, unknown>) => ({
  data: { id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage },
});

const DONE = { data: "[DONE]" };

describe("openai-chat request", () => {
  it("posts to /chat/completions with the converted conversation", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(sse([chunk({ content: "ok" }, "stop"), DONE])));
    const client = createOpenAIChatClient(
      {
        baseURL: "https://openrouter.ai/api/v1/",
        apiKey: "sk-or-123",
        headers: { "HTTP-Referer": "https://github.com/Luna-OS/lu-minal", "X-Title": "lu-minal" },
        body: { provider: { sort: "throughput" } },
      },
      fetch,
    );
    const messages: ChatMessage[] = [
      { role: "user", content: "Read PLAN.md and run the tests" },
      {
        role: "assistant",
        content: "",
        reasoning: "I should read the plan first.",
        toolCalls: [
          { id: "call_a", name: "read_file", arguments: { path: "PLAN.md" } },
          { id: "call_b", name: "bash", arguments: { command: "npm test" } },
        ],
        raw: {
          wire: "openai-chat",
          data: {
            reasoning_content: "I should read the plan first.",
            reasoning_details: [{ type: "reasoning.text", text: "I should read the plan first.", index: 0 }],
          },
        },
      },
      { role: "tool", toolCallId: "call_a", name: "read_file", content: "# Plan\n- tests" },
      { role: "tool", toolCallId: "call_b", name: "bash", content: "1 failing", isError: true },
      { role: "assistant", content: "One test fails.", raw: { wire: "anthropic", data: [{ type: "text", text: "x" }] } },
      { role: "user", content: "Fix it" },
    ];
    const signal = new AbortController().signal;
    await collect(
      client.stream(request({ messages, maxTokens: 4096, reasoningEffort: "high", signal })),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.signal).toBe(signal);
    expect(call.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer sk-or-123",
      "HTTP-Referer": "https://github.com/Luna-OS/lu-minal",
      "X-Title": "lu-minal",
    });
    expect(call.body).toEqual({
      model: "deepseek/deepseek-v3.2",
      messages: [
        { role: "system", content: "You are luna, the lead." },
        { role: "user", content: "Read PLAN.md and run the tests" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"PLAN.md"}' } },
            { id: "call_b", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } },
          ],
          reasoning_content: "I should read the plan first.",
          reasoning_details: [{ type: "reasoning.text", text: "I should read the plan first.", index: 0 }],
        },
        { role: "tool", tool_call_id: "call_a", content: "# Plan\n- tests" },
        { role: "tool", tool_call_id: "call_b", content: "1 failing" },
        // raw from another wire is ignored
        { role: "assistant", content: "One test fails." },
        { role: "user", content: "Fix it" },
      ],
      tools: [
        { type: "function", function: { name: "read_file", description: "Read a file", parameters: readFile.parameters } },
        { type: "function", function: { name: "bash", description: "Run a command", parameters: bash.parameters } },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
      reasoning_effort: "high",
      provider: { sort: "throughput" },
    });
  });

  it("leaves out tools, temperature, reasoning_effort and Authorization when not set", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(sse([chunk({ content: "hi" }, "stop"), DONE])));
    const client = createOpenAIChatClient({ baseURL: "http://127.0.0.1:11434/v1" }, fetch);
    await collect(client.stream(request({ tools: [], system: "" })));
    const { body, headers } = calls[0];
    expect(headers.Authorization).toBeUndefined();
    expect(body).toEqual({
      model: "deepseek/deepseek-v3.2",
      messages: [{ role: "user", content: "Read PLAN.md" }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("sends temperature when set and lets endpoint.headers replace Authorization", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(sse([chunk({ content: "hi" }, "stop")])));
    const client = createOpenAIChatClient(
      { baseURL: "https://x.test/v1", apiKey: "k", headers: { authorization: "Token zzz" } },
      fetch,
    );
    await collect(client.stream(request({ temperature: 0.2 })));
    expect(calls[0].body.temperature).toBe(0.2);
    expect(calls[0].headers).toMatchObject({ authorization: "Token zzz" });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
});

describe("openai-chat stream", () => {
  it("streams text, parallel tool calls split across many chunks, usage and done", async () => {
    const args0 = '{"path": "src/core/hub.ts", "limit": 200}';
    const args1 = '{"command": "npm test -- --run \\"hub\\""}';
    const pieces = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, "g")) ?? [];
    const events = [
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Let me look " }),
      chunk({ content: "at the hub \u{1F319}." }),
      chunk({
        tool_calls: [{ index: 0, id: "call_9f2", type: "function", function: { name: "read_file", arguments: "" } }],
      }),
      ...pieces(args0, 3).map((p) => chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] })),
      chunk({ tool_calls: [{ index: 1, id: "call_7c1", type: "function", function: { name: "bash", arguments: "" } }] }),
      // interleaved: the second call streams while the first is not done yet
      ...pieces(args1, 4).flatMap((p, i) => [
        chunk({ tool_calls: [{ index: 1, function: { arguments: p } }] }),
        ...(i === 0 ? [chunk({ tool_calls: [{ index: 0, function: { arguments: "" } }] })] : []),
      ]),
      chunk({}, "tool_calls"),
      usageChunk({
        prompt_tokens: 1834,
        completion_tokens: 97,
        total_tokens: 1931,
        prompt_tokens_details: { cached_tokens: 1536 },
      }),
      DONE,
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events)));
    const client = createOpenAIChatClient({ baseURL: "https://api.deepseek.com/v1", apiKey: "k" }, fetch);
    const out = await collect(client.stream(request()));

    expect(textOf(out)).toBe("Let me look at the hub \u{1F319}.");
    const types = out.map((e) => e.type);
    expect(types.slice(-4)).toEqual(["tool_call", "tool_call", "usage", "done"]);
    const calls = out.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls).toEqual([
      { id: "call_9f2", name: "read_file", arguments: { path: "src/core/hub.ts", limit: 200 } },
      { id: "call_7c1", name: "bash", arguments: { command: 'npm test -- --run "hub"' } },
    ]);
    expect(out.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      inputTokens: 1834,
      outputTokens: 97,
      cacheReadTokens: 1536,
    });
    const done = doneOf(out);
    expect(done.stopReason).toBe("tool_use");
    expect(done.message).toEqual({
      role: "assistant",
      content: "Let me look at the hub \u{1F319}.",
      toolCalls: calls,
    });
  });

  it("keeps DeepSeek's reasoning_content for the next request", async () => {
    const events = [
      chunk({ role: "assistant", content: null, reasoning_content: "" }),
      chunk({ content: null, reasoning_content: "The user wants " }),
      chunk({ content: null, reasoning_content: "a greeting." }),
      chunk({ content: "Hello!", reasoning_content: null }),
      chunk({ content: "" }, "stop", { usage: { prompt_tokens: 12, completion_tokens: 30, prompt_cache_hit_tokens: 0 } }),
      DONE,
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events)));
    const out = await collect(createOpenAIChatClient({ baseURL: "https://api.deepseek.com" }, fetch).stream(request()));
    expect(reasoningOf(out)).toBe("The user wants a greeting.");
    expect(out.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text)).toEqual([
      "The user wants ",
      "a greeting.",
    ]);
    const done = doneOf(out);
    expect(done.stopReason).toBe("end_turn");
    expect(done.message).toEqual({
      role: "assistant",
      content: "Hello!",
      reasoning: "The user wants a greeting.",
      raw: { wire: "openai-chat", data: { reasoning_content: "The user wants a greeting." } },
    });
    expect(out.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 12, outputTokens: 30, cacheReadTokens: 0 });
  });

  it("merges OpenRouter reasoning_details by index and does not double the reasoning text", async () => {
    const detail = (text: string, extra: Record<string, unknown> = {}) => ({
      type: "reasoning.text",
      text,
      format: "anthropic-claude-v1",
      index: 0,
      ...extra,
    });
    const events = [
      chunk({ role: "assistant", content: "", reasoning: "Plan: ", reasoning_details: [detail("Plan: ")] }),
      chunk({ content: "", reasoning: "check tests.", reasoning_details: [detail("check tests.")] }),
      chunk({ content: "", reasoning: null, reasoning_details: [detail("", { signature: "EqQBCkgIBxABGAIiQL..." })] }),
      chunk({ content: "Running them." }),
      chunk({ content: "" }, "stop"),
      usageChunk({ prompt_tokens: 50, completion_tokens: 20 }),
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events), [11, 5, 2]));
    const out = await collect(createOpenAIChatClient({ baseURL: "https://openrouter.ai/api/v1" }, fetch).stream(request()));
    expect(reasoningOf(out)).toBe("Plan: check tests.");
    const done = doneOf(out);
    expect(done.message.raw).toEqual({
      wire: "openai-chat",
      data: {
        reasoning: "Plan: check tests.",
        reasoning_details: [
          { type: "reasoning.text", text: "Plan: check tests.", format: "anthropic-claude-v1", index: 0, signature: "EqQBCkgIBxABGAIiQL..." },
        ],
      },
    });
  });

  it("reads reasoning from reasoning_details alone (MiniMax)", async () => {
    const events = [
      chunk({ content: "", reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "Think" }] }),
      chunk({ content: "", reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "ing..." }] }),
      chunk({ content: "Done." }, "stop"),
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events)));
    const out = await collect(createOpenAIChatClient({ baseURL: "https://api.minimax.io/v1" }, fetch).stream(request()));
    expect(reasoningOf(out)).toBe("Thinking...");
    expect(doneOf(out).message.raw).toEqual({
      wire: "openai-chat",
      data: {
        reasoning_details: [{ type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text: "Thinking..." }],
      },
    });
  });

  it("copes with provider quirks: whole calls without index, empty ids, repeated ids", async () => {
    const events = [
      // Gemini-style: each call complete in one chunk, no index, empty id
      chunk({ tool_calls: [{ id: "", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] }),
      chunk({ tool_calls: [{ id: "", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } }] }),
      chunk({}, "stop"),
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events)));
    const out = await collect(createOpenAIChatClient({ baseURL: "https://g.test" }, fetch).stream(request()));
    const done = doneOf(out);
    expect(done.stopReason).toBe("tool_use");
    expect(done.message.toolCalls).toEqual([
      { id: "call_0", name: "read_file", arguments: { path: "a.ts" } },
      { id: "call_1", name: "read_file", arguments: { path: "b.ts" } },
    ]);

    const repeated = [
      chunk({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "bash", arguments: '{"comm' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "bash", arguments: 'and":"ls"}' } }] }),
      // same index, different id: a second call
      chunk({ tool_calls: [{ index: 0, id: "call_y", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }),
      chunk({}, "tool_calls"),
    ];
    const second = fakeFetch(sseResponse(sse(repeated)));
    const out2 = await collect(createOpenAIChatClient({ baseURL: "https://q.test" }, second.fetch).stream(request()));
    expect(doneOf(out2).message.toolCalls).toEqual([
      { id: "call_x", name: "bash", arguments: { command: "ls" } },
      { id: "call_y", name: "bash", arguments: { command: "pwd" } },
    ]);
  });

  it("repairs broken arguments and never throws on them", async () => {
    const events = [
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command":"ls"}}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"x.ts"' } }] }),
      chunk({ tool_calls: [{ index: 2, id: "c3", function: { name: "bash", arguments: "rm -rf" } }] }),
      chunk({ tool_calls: [{ index: 3, id: "c4", function: { name: "bash", arguments: "" } }] }),
      chunk({}, "tool_calls"),
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events)));
    const out = await collect(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(doneOf(out).message.toolCalls?.map((c) => c.arguments)).toEqual([{ command: "ls" }, { path: "x.ts" }, {}, {}]);
  });

  it("maps finish reasons", async () => {
    const run = async (finish: string | null, delta: Record<string, unknown> = { content: "x" }) => {
      const { fetch } = fakeFetch(sseResponse(sse([chunk(delta, finish), DONE])));
      return doneOf(await collect(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()))).stopReason;
    };
    expect(await run("stop")).toBe("end_turn");
    expect(await run("length")).toBe("max_tokens");
    expect(await run("content_filter")).toBe("content_filter");
    expect(await run(null)).toBe("end_turn");
    expect(await run("stop", { tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{}" } }] })).toBe("tool_use");
  });

  it("stops at [DONE] and ignores keep-alive comments and junk lines", async () => {
    const text =
      ": OPENROUTER PROCESSING\n\n" +
      sse([chunk({ content: "a" })]) +
      "data: not json\n\n" +
      sse([chunk({ content: "b" }, "stop"), DONE, chunk({ content: "after done" })]);
    const { fetch } = fakeFetch(sseResponse(text));
    const out = await collect(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(textOf(out)).toBe("ab");
    expect(out.find((e) => e.type === "usage")).toBeUndefined();
  });

  it("converts a non-streamed JSON completion", async () => {
    const { fetch } = fakeFetch(
      jsonResponse(200, {
        id: "chatcmpl-2",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Reading it.",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"PLAN.md"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const out = await collect(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(out.map((e) => e.type)).toEqual(["text", "tool_call", "usage", "done"]);
    expect(doneOf(out).message).toEqual({
      role: "assistant",
      content: "Reading it.",
      toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "PLAN.md" } }],
    });
  });
});

describe("openai-chat errors", () => {
  it("maps 429 with Retry-After to a retryable ProviderError", async () => {
    const { fetch } = fakeFetch(
      jsonResponse(429, { error: { message: "Rate limit exceeded: free-models-per-min", code: 429 } }, { "Retry-After": "7" }),
    );
    const err = await collectUntilError(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(err.events).toEqual([]);
    expect(err.error).toBeInstanceOf(ProviderError);
    expect(err.error).toMatchObject({ status: 429, retryAfterMs: 7000, message: "Rate limit exceeded: free-models-per-min" });
    expect((err.error as ProviderError).retryable).toBe(true);
  });

  it("maps a 401 JSON error to a non-retryable ProviderError", async () => {
    const { fetch } = fakeFetch(
      jsonResponse(401, { error: { message: "Incorrect API key provided: sk-abc***.", type: "invalid_request_error", code: "invalid_api_key" } }),
    );
    const { error } = await collectUntilError(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(error).toMatchObject({ status: 401, retryAfterMs: null, message: "Incorrect API key provided: sk-abc***." });
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).body).toContain("invalid_api_key");
  });

  it("throws an in-stream error after the events before it", async () => {
    const events = [
      chunk({ content: "Partial " }),
      { data: { id: "gen-1", object: "chat.completion.chunk", error: { code: 502, message: "Provider disconnected" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] } },
      chunk({ content: "never" }, "stop"),
    ];
    const { fetch } = fakeFetch(sseResponse(sse(events)));
    const { events: before, error } = await collectUntilError(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(textOf(before)).toBe("Partial ");
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 502, message: "Provider disconnected" });
  });

  it("rejects an empty stream as retryable", async () => {
    const { fetch } = fakeFetch(sseResponse(": just a comment\n\n"));
    const { error } = await collectUntilError(createOpenAIChatClient({ baseURL: "https://q.test" }, fetch).stream(request()));
    expect(error).toMatchObject({ status: 502 });
    expect((error as ProviderError).retryable).toBe(true);
  });
});
