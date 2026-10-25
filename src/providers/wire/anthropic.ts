// The Anthropic Messages wire ("anthropic"): POST {baseURL}/messages with `stream: true`. Used for
// Anthropic itself and the providers that copy its API (MiniMax, OpenCode Zen's Claude models,
// ...). Messages must alternate user / assistant, so tool results are folded into user messages;
// thinking blocks go back with their signatures; the system prompt and the newest user turn carry
// cache breakpoints.
import {
  ProviderError,
  type AssistantMessage,
  type ChatClient,
  type ChatMessage,
  type ChatRequest,
  type FetchLike,
  type StreamEvent,
  type ToolCall,
  type WireEndpoint,
} from "../types.js";
import { isRecord, num, parseToolArguments, str } from "./convert.js";
import { defaultFetch, joinURL, mergeHeaders, openStream, statusForErrorCode } from "./http.js";

/** The `anthropic-version` header every request sends. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** max_tokens when the request names none. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;

type Block = Record<string, unknown>;

/** One message as the Messages API takes it. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

/** Thinking budget (tokens) for a reasoning effort; null turns thinking off. */
export function thinkingBudget(effort: string | undefined): number | null {
  if (effort === undefined) return null;
  switch (effort.trim().toLowerCase()) {
    case "":
    case "none":
    case "off":
      return null;
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    case "xhigh":
    case "max":
      return 32000;
    default:
      return 8192;
  }
}

/**
 * The conversation as Anthropic messages. Consecutive tool results become one user message with
 * several `tool_result` blocks, and user text that follows them joins that message (tool results
 * first, as the API wants). Messages of the same role are merged, so the roles always alternate.
 * The last block of the last user message gets `cache_control`.
 */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const append = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (!last || last.role !== role) {
      out.push({ role, content: [...blocks] });
      return;
    }
    if (role === "user") {
      // tool_result blocks must come before any other content of a user message.
      const results = blocks.filter((b) => b.type === "tool_result");
      const others = blocks.filter((b) => b.type !== "tool_result");
      const firstOther = last.content.findIndex((b) => b.type !== "tool_result");
      if (results.length && firstOther !== -1) last.content.splice(firstOther, 0, ...results);
      else last.content.push(...results);
      last.content.push(...others);
    } else {
      last.content.push(...blocks);
    }
  };

  for (const m of messages) {
    if (m.role === "user") {
      append("user", m.content ? [{ type: "text", text: m.content }] : []);
    } else if (m.role === "tool") {
      append("user", [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          // An empty result is refused when is_error is set; say so instead.
          content: m.content || "(no output)",
          is_error: Boolean(m.isError),
        },
      ]);
    } else if (m.raw?.wire === "anthropic" && Array.isArray(m.raw.data) && m.raw.data.length) {
      append("assistant", m.raw.data.filter(isRecord).map((b) => ({ ...b })));
    } else {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
      append("assistant", blocks);
    }
  }

  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user") continue;
    const content = out[i].content;
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
    break;
  }
  return out;
}

/** The request body for `request` (endpoint.body is merged in last). */
export function buildAnthropicBody(request: ChatRequest, endpoint: WireEndpoint): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model };
  if (request.system) {
    body.system = [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
  }
  body.messages = toAnthropicMessages(request.messages);
  if (request.tools.length) {
    body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  let maxTokens = request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  let budget = thinkingBudget(request.reasoningEffort);
  if (budget !== null) {
    if (budget >= maxTokens) {
      if (request.maxTokens !== undefined) {
        // The caller's max_tokens is usually the model's limit: keep it, shrink the budget.
        budget = Math.max(1024, maxTokens - 4096);
        if (budget >= maxTokens) maxTokens = budget + 1024;
      } else {
        maxTokens = budget + 8192;
      }
    }
    body.thinking = { type: "enabled", budget_tokens: budget };
  }
  body.max_tokens = maxTokens;
  body.stream = true;
  // With thinking on, the API only accepts the default temperature.
  if (request.temperature !== undefined && budget === null) body.temperature = request.temperature;
  return { ...body, ...endpoint.body };
}

/** The request headers: x-api-key (never Authorization), endpoint.headers win. */
export function buildAnthropicHeaders(endpoint: WireEndpoint): Record<string, string> {
  return mergeHeaders(
    {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(endpoint.apiKey ? { "x-api-key": endpoint.apiKey } : {}),
    },
    endpoint.headers,
  );
}

/** A content block while it streams. */
interface OpenBlock {
  block: Block;
  json: string;
  stopped: boolean;
}

/** Folds the events of one streamed message into stream events and the final message. */
class AnthropicStream {
  blocks = new Map<number, OpenBlock>();
  text = "";
  reasoning = "";
  calls: ToolCall[] = [];
  textBlock: number | null = null;
  thinkingBlock: number | null = null;
  inputTokens = 0;
  outputTokens = 0;
  cacheRead = 0;
  cacheWrite = 0;
  sawUsage = false;
  stopReason: string | null = null;
  done = false;

  handle(type: string, data: Record<string, unknown>): StreamEvent[] {
    switch (type) {
      case "message_start": {
        const message = isRecord(data.message) ? data.message : {};
        if (isRecord(message.usage)) this.readUsage(message.usage);
        return [];
      }
      case "content_block_start": {
        const index = num(data.index) ?? this.blocks.size;
        const start: Block = isRecord(data.content_block) ? { ...data.content_block } : { type: "text", text: "" };
        if (start.type === "tool_use" || start.type === "server_tool_use") start.input = {};
        this.blocks.set(index, { block: start, json: "", stopped: false });
        // Text that comes with the start (rare) streams like a delta.
        if (start.type === "text" && str(start.text)) {
          const text = str(start.text) ?? "";
          start.text = "";
          return this.textDelta(index, text);
        }
        if (start.type === "thinking" && str(start.thinking)) {
          const text = str(start.thinking) ?? "";
          start.thinking = "";
          return this.thinkingDelta(index, text);
        }
        return [];
      }
      case "content_block_delta": {
        const index = num(data.index) ?? -1;
        const delta = isRecord(data.delta) ? data.delta : {};
        const open = this.blocks.get(index);
        if (!open) return [];
        switch (delta.type) {
          case "text_delta":
            return this.textDelta(index, str(delta.text) ?? "");
          case "thinking_delta":
            return this.thinkingDelta(index, str(delta.thinking) ?? "");
          case "input_json_delta":
            open.json += str(delta.partial_json) ?? "";
            return [];
          case "signature_delta":
            open.block.signature = (str(open.block.signature) ?? "") + (str(delta.signature) ?? "");
            return [];
          case "citations_delta":
            if (delta.citation !== undefined) {
              const list = Array.isArray(open.block.citations) ? open.block.citations : [];
              open.block.citations = [...list, delta.citation];
            }
            return [];
          default:
            return [];
        }
      }
      case "content_block_stop": {
        const open = this.blocks.get(num(data.index) ?? -1);
        return open ? this.stopBlock(open) : [];
      }
      case "message_delta": {
        const delta = isRecord(data.delta) ? data.delta : {};
        const reason = str(delta.stop_reason);
        if (reason) this.stopReason = reason;
        if (isRecord(data.usage)) this.readUsage(data.usage);
        return [];
      }
      case "message_stop":
        this.done = true;
        return [];
      case "error": {
        const err = isRecord(data.error) ? data.error : data;
        const errType = str(err.type);
        throw new ProviderError(
          str(err.message) ?? `The provider reported an error (${errType ?? "unknown"}).`,
          statusForErrorCode(errType),
          null,
          JSON.stringify(data),
        );
      }
      default:
        return []; // ping and future events
    }
  }

  private textDelta(index: number, text: string): StreamEvent[] {
    const open = this.blocks.get(index);
    if (!text || !open) return [];
    // A new text block after earlier text (e.g. around a tool call) starts a new paragraph.
    const sep = this.text && this.textBlock !== null && this.textBlock !== index ? "\n\n" : "";
    this.textBlock = index;
    open.block.text = (str(open.block.text) ?? "") + text;
    this.text += sep + text;
    return [{ type: "text", text: sep + text }];
  }

  private thinkingDelta(index: number, text: string): StreamEvent[] {
    const open = this.blocks.get(index);
    if (!text || !open) return [];
    const sep = this.reasoning && this.thinkingBlock !== null && this.thinkingBlock !== index ? "\n\n" : "";
    this.thinkingBlock = index;
    open.block.thinking = (str(open.block.thinking) ?? "") + text;
    this.reasoning += sep + text;
    return [{ type: "reasoning", text: sep + text }];
  }

  private stopBlock(open: OpenBlock): StreamEvent[] {
    if (open.stopped) return [];
    open.stopped = true;
    const block = open.block;
    if (block.type !== "tool_use" && block.type !== "server_tool_use") return [];
    block.input = parseToolArguments(open.json);
    if (block.type !== "tool_use") return [];
    const call: ToolCall = {
      id: str(block.id) || `toolu_${this.calls.length}`,
      name: str(block.name) ?? "",
      arguments: block.input as Record<string, unknown>,
    };
    block.id = call.id;
    this.calls.push(call);
    return [{ type: "tool_call", call }];
  }

  private readUsage(u: Record<string, unknown>): void {
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    const read = num(u.cache_read_input_tokens);
    const write = num(u.cache_creation_input_tokens);
    // message_delta repeats the counts cumulatively; some compatible servers only send them there.
    if (input !== undefined && (input > 0 || !this.sawUsage)) this.inputTokens = input;
    if (output !== undefined) this.outputTokens = output;
    if (read !== undefined && (read > 0 || !this.sawUsage)) this.cacheRead = read;
    if (write !== undefined && (write > 0 || !this.sawUsage)) this.cacheWrite = write;
    this.sawUsage = true;
  }

  finish(): StreamEvent[] {
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, open]) => open);
    const events: StreamEvent[] = [];
    for (const open of ordered) events.push(...this.stopBlock(open));
    if (this.sawUsage) {
      events.push({
        type: "usage",
        inputTokens: this.inputTokens + this.cacheRead + this.cacheWrite,
        outputTokens: this.outputTokens,
        cacheReadTokens: this.cacheRead,
        cacheWriteTokens: this.cacheWrite,
      });
    }
    // Empty text blocks are refused when sent back.
    const blocks = ordered
      .map((open) => open.block)
      .filter((b) => !(b.type === "text" && !str(b.text)));
    const message: AssistantMessage = { role: "assistant", content: this.text };
    if (this.calls.length) message.toolCalls = this.calls;
    if (this.reasoning) message.reasoning = this.reasoning;
    if (blocks.length) message.raw = { wire: "anthropic", data: blocks };
    events.push({
      type: "done",
      stopReason: this.stopReason ?? (this.calls.length ? "tool_use" : "end_turn"),
      message,
    });
    return events;
  }
}

/** A chat client for the Anthropic Messages API (and compatible endpoints). */
export function createAnthropicClient(endpoint: WireEndpoint, fetchImpl: FetchLike = defaultFetch): ChatClient {
  return {
    wire: "anthropic",
    async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      const opened = await openStream({
        fetchImpl,
        url: joinURL(endpoint.baseURL, "messages"),
        headers: buildAnthropicHeaders(endpoint),
        body: buildAnthropicBody(request, endpoint),
        signal: request.signal,
      });
      if (opened.kind === "json") {
        throw new ProviderError("The provider answered with JSON instead of an event stream.", 502, null, opened.text);
      }
      const state = new AnthropicStream();
      for await (const message of opened.events) {
        if (!message.data) continue;
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          continue;
        }
        if (!isRecord(data)) continue;
        yield* state.handle(str(data.type) ?? message.event ?? "", data);
        if (state.done) break;
      }
      // message_stop ends a message; a stop_reason without it (some compatible servers) is enough.
      if (!state.done && state.stopReason === null) {
        throw new ProviderError("The stream ended before the message was complete.", 502);
      }
      yield* state.finish();
    },
  };
}
