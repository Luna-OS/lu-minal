import { describe, expect, it } from "vitest";
import { ProviderError, type ChatMessage, type ChatRequest, type ToolSpec } from "../../src/providers/types.js";
import { createOpenAIResponsesClient } from "../../src/providers/wire/openai-responses.js";
import { collect, collectUntilError, doneOf, fakeFetch, jsonResponse, reasoningOf, sse, sseResponse, textOf } from "./helpers.js";

const grep: ToolSpec = {
  name: "grep",
  description: "Search files",
  parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
};

function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "gpt-5.1-codex",
    system: "You are vega, a worker.",
    messages: [{ role: "user", content: "Find the TODOs" }],
    tools: [grep],
    ...over,
  };
}

const ev = (type: string, fields: Record<string, unknown>) => ({ event: type, data: { type, ...fields } });

const reasoningItem = {
  id: "rs_68f1",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "**Searching**\n\nLooking for TODO markers." }],
  encrypted_content: "gAAAAABo8...encrypted...",
};
const callItem = (id: string, callId: string, args: string) => ({
  id,
  type: "function_call",
  status: "completed",
  arguments: args,
  call_id: callId,
  name: "grep",
});
const messageItem = {
  id: "msg_68f2",
  type: "message",
  status: "completed",
  role: "assistant",
  content: [{ type: "output_text", annotations: [], logprobs: [], text: "Searching now." }],
};

function completedStream(): string {
  const args1 = '{"pattern":"TODO","path":"src"}';
  const args2 = '{"pattern":"FIXME"}';
  const response = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "resp_1",
    object: "response",
    status,
    model: "gpt-5.1-codex",
    ...extra,
  });
  return sse([
    ev("response.created", { sequence_number: 0, response: response("in_progress", { output: [] }) }),
    ev("response.in_progress", { sequence_number: 1, response: response("in_progress", { output: [] }) }),
    ev("response.output_item.added", { output_index: 0, item: { id: "rs_68f1", type: "reasoning", summary: [] } }),
    ev("response.reasoning_summary_part.added", { item_id: "rs_68f1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
    ev("response.reasoning_summary_text.delta", { item_id: "rs_68f1", output_index: 0, summary_index: 0, delta: "**Searching**" }),
    ev("response.reasoning_summary_text.done", { item_id: "rs_68f1", output_index: 0, summary_index: 0, text: "**Searching**" }),
    ev("response.reasoning_summary_text.delta", { item_id: "rs_68f1", output_index: 0, summary_index: 1, delta: "Looking for " }),
    ev("response.reasoning_summary_text.delta", { item_id: "rs_68f1", output_index: 0, summary_index: 1, delta: "TODO markers." }),
    ev("response.output_item.done", { output_index: 0, item: reasoningItem }),
    ev("response.output_item.added", { output_index: 1, item: { ...messageItem, status: "in_progress", content: [] } }),
    ev("response.content_part.added", { item_id: "msg_68f2", output_index: 1, content_index: 0, part: { type: "output_text", text: "" } }),
    ev("response.output_text.delta", { item_id: "msg_68f2", output_index: 1, content_index: 0, delta: "Searching " }),
    ev("response.output_text.delta", { item_id: "msg_68f2", output_index: 1, content_index: 0, delta: "now." }),
    ev("response.output_text.done", { item_id: "msg_68f2", output_index: 1, content_index: 0, text: "Searching now." }),
    ev("response.output_item.done", { output_index: 1, item: messageItem }),
    ev("response.output_item.added", { output_index: 2, item: callItem("fc_1", "call_A", "") }),
    ...args1.match(/[\s\S]{1,5}/g)!.map((d) => ev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: d })),
    ev("response.function_call_arguments.done", { item_id: "fc_1", output_index: 2, arguments: args1 }),
    ev("response.output_item.done", { output_index: 2, item: callItem("fc_1", "call_A", args1) }),
    ev("response.output_item.added", { output_index: 3, item: callItem("fc_2", "call_B", "") }),
    ev("response.function_call_arguments.delta", { item_id: "fc_2", output_index: 3, delta: args2 }),
    ev("response.output_item.done", { output_index: 3, item: callItem("fc_2", "call_B", args2) }),
    ev("response.completed", {
      sequence_number: 40,
      response: response("completed", {
        output: [reasoningItem, messageItem, callItem("fc_1", "call_A", args1), callItem("fc_2", "call_B", args2)],
        usage: {
          input_tokens: 5120,
          input_tokens_details: { cached_tokens: 4096 },
          output_tokens: 310,
          output_tokens_details: { reasoning_tokens: 192 },
          total_tokens: 5430,
        },
      }),
    }),
  ]);
}

describe("openai-responses request", () => {
  it("posts to /responses with instructions, input items and tools", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(completedStream()));
    const client = createOpenAIResponsesClient(
      { baseURL: "https://api.openai.com/v1/", apiKey: "sk-proj-1", body: { service_tier: "flex" } },
      fetch,
    );
    const messages: ChatMessage[] = [
      { role: "user", content: "Find the TODOs" },
      {
        role: "assistant",
        content: "Searching now.",
        toolCalls: [{ id: "call_A", name: "grep", arguments: { pattern: "TODO" } }],
        raw: {
          wire: "openai-responses",
          data: [
            reasoningItem,
            { id: "rs_none", type: "reasoning", summary: [] }, // no encrypted_content: left out
            messageItem,
            callItem("fc_1", "call_A", '{"pattern":"TODO"}'),
          ],
        },
      },
      { role: "tool", toolCallId: "call_A", name: "grep", content: "src/a.ts:3: // TODO" },
      // from another provider: rebuilt from content and tool calls
      {
        role: "assistant",
        content: "One more search.",
        toolCalls: [{ id: "toolu_1", name: "grep", arguments: { pattern: "FIXME" } }],
        raw: { wire: "anthropic", data: [] },
      },
      { role: "tool", toolCallId: "toolu_1", name: "grep", content: "no matches", isError: false },
      { role: "assistant", content: "", toolCalls: [{ id: "c9", name: "grep", arguments: {} }] },
      { role: "tool", toolCallId: "c9", name: "grep", content: "" },
      { role: "user", content: "Thanks" },
    ];
    await collect(client.stream(request({ messages, maxTokens: 8000, reasoningEffort: "medium" })));

    const call = calls[0];
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: "Bearer sk-proj-1",
    });
    const { id: _r, ...reasoningReplay } = reasoningItem;
    const { id: _m, ...messageReplay } = messageItem;
    const { id: _f, ...callReplay } = callItem("fc_1", "call_A", '{"pattern":"TODO"}');
    expect(call.body).toEqual({
      model: "gpt-5.1-codex",
      instructions: "You are vega, a worker.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Find the TODOs" }] },
        reasoningReplay,
        messageReplay,
        callReplay,
        { type: "function_call_output", call_id: "call_A", output: "src/a.ts:3: // TODO" },
        { role: "assistant", content: [{ type: "output_text", text: "One more search." }] },
        { type: "function_call", call_id: "toolu_1", name: "grep", arguments: '{"pattern":"FIXME"}' },
        { type: "function_call_output", call_id: "toolu_1", output: "no matches" },
        { type: "function_call", call_id: "c9", name: "grep", arguments: "{}" },
        { type: "function_call_output", call_id: "c9", output: "" },
        { role: "user", content: [{ type: "input_text", text: "Thanks" }] },
      ],
      tools: [{ type: "function", name: "grep", description: "Search files", parameters: grep.parameters, strict: false }],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 8000,
      reasoning: { effort: "medium", summary: "auto" },
      service_tier: "flex",
    });
    expect(reasoningReplay).not.toHaveProperty("id");
  });

  it("leaves out reasoning, tools, max_output_tokens and Authorization when not set", async () => {
    const { fetch, calls } = fakeFetch(sseResponse(completedStream()));
    await collect(createOpenAIResponsesClient({ baseURL: "https://api.openai.com/v1" }, fetch).stream(request({ tools: [], system: "" })));
    const { body, headers } = calls[0];
    expect(headers.Authorization).toBeUndefined();
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("openai-responses stream", () => {
  it("streams reasoning summaries, text and tool calls; keeps the output items", async () => {
    const { fetch } = fakeFetch(sseResponse(completedStream(), [9, 2, 31, 4]));
    const out = await collect(createOpenAIResponsesClient({ baseURL: "https://api.openai.com/v1" }, fetch).stream(request()));

    expect(reasoningOf(out)).toBe("**Searching**\n\nLooking for TODO markers.");
    expect(textOf(out)).toBe("Searching now.");
    const calls = out.flatMap((e) => (e.type === "tool_call" ? [e.call] : []));
    expect(calls).toEqual([
      { id: "call_A", name: "grep", arguments: { pattern: "TODO", path: "src" } },
      { id: "call_B", name: "grep", arguments: { pattern: "FIXME" } },
    ]);
    expect(out.slice(-2).map((e) => e.type)).toEqual(["usage", "done"]);
    expect(out.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 5120, outputTokens: 310, cacheReadTokens: 4096 });
    const done = doneOf(out);
    expect(done.stopReason).toBe("tool_use");
    expect(done.message.content).toBe("Searching now.");
    expect(done.message.reasoning).toBe("**Searching**\n\nLooking for TODO markers.");
    expect(done.message.toolCalls).toEqual(calls);
    expect(done.message.raw).toEqual({
      wire: "openai-responses",
      data: [reasoningItem, messageItem, callItem("fc_1", "call_A", '{"pattern":"TODO","path":"src"}'), callItem("fc_2", "call_B", '{"pattern":"FIXME"}')],
    });
  });

  it("ends a plain answer with end_turn", async () => {
    const text = sse([
      ev("response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "All " }),
      ev("response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "clear." }),
      ev("response.completed", {
        response: { status: "completed", output: [{ ...messageItem, content: [{ type: "output_text", text: "All clear." }] }], usage: { input_tokens: 9, output_tokens: 3 } },
      }),
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const out = await collect(createOpenAIResponsesClient({ baseURL: "https://x.test/v1" }, fetch).stream(request()));
    expect(textOf(out)).toBe("All clear.");
    expect(doneOf(out).stopReason).toBe("end_turn");
    expect(out.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 9, outputTokens: 3 });
  });

  it("treats incomplete with max_output_tokens as a normal end", async () => {
    const text = sse([
      ev("response.output_text.delta", { item_id: "msg_1", delta: "Long answer that got cu" }),
      ev("response.incomplete", {
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ ...messageItem, status: "incomplete" }],
          usage: { input_tokens: 100, output_tokens: 8000 },
        },
      }),
    ]);
    const { fetch } = fakeFetch(sseResponse(text));
    const out = await collect(createOpenAIResponsesClient({ baseURL: "https://x.test/v1" }, fetch).stream(request()));
    const done = doneOf(out);
    expect(done.stopReason).toBe("max_tokens");
    expect(done.message.content).toBe("Long answer that got cu");
  });

  it("fails on incomplete for other reasons, response.failed and error events", async () => {
    const run = async (events: Array<{ event?: string; data: unknown }>) => {
      const { fetch } = fakeFetch(sseResponse(sse(events)));
      return collectUntilError(createOpenAIResponsesClient({ baseURL: "https://x.test/v1" }, fetch).stream(request()));
    };
    const filtered = await run([
      ev("response.output_text.delta", { item_id: "m", delta: "Hm" }),
      ev("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] } }),
    ]);
    expect(textOf(filtered.events)).toBe("Hm");
    expect(filtered.error).toBeInstanceOf(ProviderError);
    expect(filtered.error).toMatchObject({ status: 400 });
    expect((filtered.error as Error).message).toContain("content_filter");

    const failed = await run([
      ev("response.created", { response: { status: "in_progress" } }),
      ev("response.failed", { response: { status: "failed", error: { code: "rate_limit_exceeded", message: "Rate limit reached for gpt-5.1-codex" } } }),
    ]);
    expect(failed.error).toMatchObject({ status: 429, message: "Rate limit reached for gpt-5.1-codex" });
    expect((failed.error as ProviderError).retryable).toBe(true);

    const errored = await run([{ event: "error", data: { type: "error", code: "server_error", message: "The server had an error", param: null, sequence_number: 3 } }]);
    expect(errored.error).toMatchObject({ status: 500, message: "The server had an error" });
  });

  it("fails when the stream ends before the response is complete", async () => {
    const { fetch } = fakeFetch(sseResponse(sse([ev("response.output_text.delta", { item_id: "m", delta: "Half" })])));
    const { events, error } = await collectUntilError(createOpenAIResponsesClient({ baseURL: "https://x.test/v1" }, fetch).stream(request()));
    expect(textOf(events)).toBe("Half");
    expect(error).toMatchObject({ status: 502 });
  });

  it("maps HTTP errors", async () => {
    const { fetch } = fakeFetch(
      jsonResponse(
        400,
        { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error", param: "temperature", code: "unsupported_parameter" } },
      ),
    );
    const { error } = await collectUntilError(createOpenAIResponsesClient({ baseURL: "https://x.test/v1" }, fetch).stream(request({ temperature: 0.5 })));
    expect(error).toMatchObject({ status: 400, message: "Unsupported parameter: 'temperature' is not supported with this model." });
  });
});
