import { describe, expect, it } from "vitest";
import { createLineParser, eventsFrom, type ClaudeEvent } from "../../src/agents/claude-code/events.js";

// Lines in the shapes Claude Code 2.1 prints with --output-format stream-json --verbose
// --include-partial-messages (trimmed to the fields that matter, plus some that don't).
const LINES: unknown[] = [
  { type: "active_goal", value: null, uuid: "a", session_id: "s-1" },
  {
    type: "autocompact_state",
    value: { enabled: true, effective_window: 980000, threshold: 784000, enforced: true, source: "model-default" },
    session_id: "s-1",
  },
  {
    type: "system",
    subtype: "init",
    cwd: "/work/moon",
    session_id: "s-1",
    tools: ["Bash", "Edit", "mcp__luminal__send_message"],
    mcp_servers: [
      { name: "luminal", status: "connected" },
      { name: "github", status: "failed" },
    ],
    model: "claude-opus-5-5",
    permissionMode: "acceptEdits",
    apiKeySource: "none",
    claude_code_version: "2.1.310",
    uuid: "i",
  },
  { type: "system", subtype: "status", status: "requesting", session_id: "s-1" },
  {
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        usage: { input_tokens: 10, cache_creation_input_tokens: 120, cache_read_input_tokens: 4141, output_tokens: 1 },
      },
    },
    parent_tool_use_id: null,
    session_id: "s-1",
  },
  {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user greets me." } },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQB" } },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
    parent_tool_use_id: null,
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "there!" } },
    parent_tool_use_id: null,
  },
  // A subagent's stream: skipped.
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "inner" } },
    parent_tool_use_id: "toolu_task",
  },
  {
    type: "assistant",
    message: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "Hello there!" }] },
    parent_tool_use_id: null,
    session_id: "s-1",
  },
  {
    type: "stream_event",
    event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } },
    parent_tool_use_id: null,
  },
  { type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null },
  {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: 1791504000,
      rateLimitType: "seven_day",
      utilization: 0.66,
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.48, resetsAt: 1791081600 },
        seven_day: { utilization: 0.66, resetsAt: 1791504000 },
      },
    },
    session_id: "s-1",
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1500,
    duration_api_ms: 1400,
    num_turns: 1,
    result: "Hello there!",
    session_id: "s-1",
    total_cost_usd: 0.0008891,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 120,
      cache_read_input_tokens: 4141,
      output_tokens: 42,
      server_tool_use: { web_search_requests: 0 },
      service_tier: "standard",
    },
    modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 42 } },
    permission_denials: [],
    uuid: "r",
  },
];

function parseAll(text: string, chunk = 37): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  const parser = createLineParser((e) => events.push(e));
  // In pieces that cut lines (and multi-byte characters' strings) in half, as stdout delivers them.
  for (let i = 0; i < text.length; i += chunk) parser.push(text.slice(i, i + chunk));
  parser.end();
  return events;
}

describe("Claude Code stream-json events", () => {
  it("turns a short answer's stream into the driver's events", () => {
    const events = parseAll(LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(events.map((e) => e.kind)).toEqual([
      "context-window",
      "init",
      "status",
      "context",
      "thinking-delta",
      "text-delta",
      "text-delta",
      "text",
      "output",
      "rate-limit",
      "result",
    ]);
    const [win, init, , context, thinking, d1, d2, text, output, limit, result] = events as any[];
    expect(win.tokens).toBe(980000);
    expect(init).toMatchObject({
      model: "claude-opus-5-5",
      sessionId: "s-1",
      cwd: "/work/moon",
      permissionMode: "acceptEdits",
      version: "2.1.310",
    });
    expect(init.mcpServers).toEqual([
      { name: "luminal", status: "connected" },
      { name: "github", status: "failed" },
    ]);
    expect(context.tokens).toBe(10 + 120 + 4141);
    expect(thinking).toEqual({ kind: "thinking-delta", messageId: "msg_1", text: "The user greets me." });
    expect(d1.messageId).toBe("msg_1");
    expect(d1.text + d2.text).toBe("Hello there!");
    expect(text).toEqual({ kind: "text", messageId: "msg_1", text: "Hello there!" });
    expect(output.tokens).toBe(42);
    expect(limit).toEqual({
      kind: "rate-limit",
      status: "allowed_warning",
      type: "seven_day",
      fiveHour: { utilization: 0.48, resetsAt: 1791081600000 },
      sevenDay: { utilization: 0.66, resetsAt: 1791504000000 },
      usingOverage: false,
    });
    expect(result).toEqual({
      kind: "result",
      ok: true,
      subtype: "success",
      text: "Hello there!",
      costUsd: 0.0008891,
      durationMs: 1500,
      turns: 1,
      usage: { input: 10, output: 42, cacheRead: 4141, cacheWrite: 120 },
      denials: [],
      sessionId: "s-1",
    });
  });

  it("handles CRLF line endings and a last line without a newline", () => {
    const text = LINES.slice(2, 4).map((l) => JSON.stringify(l)).join("\r\n");
    const events = parseAll(text, 5);
    expect(events.map((e) => e.kind)).toEqual(["init", "status"]);
    expect((events[1] as any).status).toBe("requesting");
  });

  it("reads tool calls and their results, with the structured result when unambiguous", () => {
    expect(
      eventsFrom({
        type: "assistant",
        message: {
          id: "m2",
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls", description: "List files" } },
          ],
        },
        parent_tool_use_id: null,
      }),
    ).toEqual([
      { kind: "text", messageId: "m2", text: "Let me look." },
      { kind: "tool-use", id: "toolu_1", name: "Bash", input: { command: "ls", description: "List files" } },
    ]);

    const patch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-a", "+b"] }];
    expect(
      eventsFrom({
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: "toolu_2", type: "tool_result", content: "The file x has been updated successfully." }],
        },
        parent_tool_use_id: null,
        tool_use_result: { filePath: "x", oldString: "a", newString: "b", structuredPatch: patch },
      }),
    ).toEqual([
      {
        kind: "tool-result",
        toolUseId: "toolu_2",
        isError: false,
        text: "The file x has been updated successfully.",
        meta: { filePath: "x", oldString: "a", newString: "b", structuredPatch: patch },
      },
    ]);

    // Two results in one message: the structured result can't be told apart, so none is attached.
    const two = eventsFrom({
      type: "user",
      message: {
        role: "user",
        content: [
          { tool_use_id: "a", type: "tool_result", content: [{ type: "text", text: "one" }, { type: "image", source: {} }] },
          { tool_use_id: "b", type: "tool_result", content: "Exit code 2\nboom", is_error: true },
        ],
      },
      tool_use_result: { stdout: "x" },
    });
    expect(two).toEqual([
      { kind: "tool-result", toolUseId: "a", isError: false, text: "one\n[image]" },
      { kind: "tool-result", toolUseId: "b", isError: true, text: "Exit code 2\nboom" },
    ]);
  });

  it("keeps a subagent's own messages out of the main conversation", () => {
    expect(
      eventsFrom({ type: "assistant", parent_tool_use_id: "tu9", message: { id: "x", content: [{ type: "text", text: "inner" }] } }),
    ).toEqual([]);
    expect(
      eventsFrom({
        type: "user",
        parent_tool_use_id: "tu9",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
      }),
    ).toEqual([]);
  });

  it("reports denied tools and failed results", () => {
    const [r] = eventsFrom({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Invalid API key · Please run /login",
      total_cost_usd: 0,
      permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_9", tool_input: { command: "rm -rf build" } }],
    }) as any[];
    expect(r.ok).toBe(false);
    expect(r.text).toBe("Invalid API key · Please run /login");
    expect(r.denials).toEqual([{ tool: "Bash", input: { command: "rm -rf build" }, toolUseId: "toolu_9" }]);
    expect(r.usage).toBeNull();

    const [max] = eventsFrom({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached max turns (3)"] }) as any[];
    expect(max).toMatchObject({ ok: false, subtype: "error_max_turns", text: "Reached max turns (3)", costUsd: null });
  });

  it("reads rate limits without unified windows and rejected ones", () => {
    const [only] = eventsFrom({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1791081600, rateLimitType: "five_hour", utilization: 0.2 },
    }) as any[];
    expect(only.fiveHour).toEqual({ utilization: 0.2, resetsAt: 1791081600000 });
    expect(only.sevenDay).toBeNull();

    const [rejected] = eventsFrom({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1791081600, rateLimitType: "five_hour", isUsingOverage: true },
    }) as any[];
    expect(rejected).toMatchObject({ status: "rejected", usingOverage: true, fiveHour: { utilization: 1, resetsAt: 1791081600000 } });
  });

  it("reads the CLI's status, including the end of a compaction", () => {
    expect(eventsFrom({ type: "system", subtype: "status", status: "compacting" })).toEqual([{ kind: "status", status: "compacting" }]);
    expect(eventsFrom({ type: "system", subtype: "status", status: null })).toEqual([{ kind: "status", status: "" }]);
    expect(eventsFrom({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 170000 } })).toEqual([
      { kind: "status", status: "compacted" },
    ]);
    expect(eventsFrom({ type: "system", subtype: "hook_response" })).toEqual([]);
  });

  it("reads control requests and responses", () => {
    expect(
      eventsFrom({
        type: "control_request",
        request_id: "req_1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm publish" } },
      }),
    ).toEqual([
      {
        kind: "control-request",
        requestId: "req_1",
        subtype: "can_use_tool",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm publish" } },
      },
    ]);
    expect(eventsFrom({ type: "control_response", response: { subtype: "success", request_id: "i1" } })).toEqual([
      { kind: "control-response", requestId: "i1", ok: true, error: null },
    ]);
    expect(eventsFrom({ type: "control_response", response: { subtype: "error", request_id: "m1", error: "nope" } })).toEqual([
      { kind: "control-response", requestId: "m1", ok: false, error: "nope" },
    ]);
  });

  it("passes lines that aren't JSON on as stderr and ignores junk", () => {
    const events = parseAll("Error: something broke\n\n   \n42\nnull\n{\"type\":\"keep_alive\"}\n");
    expect(events).toEqual([{ kind: "stderr", text: "Error: something broke" }]);
    expect(eventsFrom(null)).toEqual([]);
    expect(eventsFrom("text")).toEqual([]);
    expect(eventsFrom({ type: "assistant", message: { content: "not a list" } })).toEqual([]);
  });
});
