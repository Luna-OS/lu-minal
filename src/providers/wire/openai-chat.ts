// The OpenAI chat completions wire ("openai-chat"): POST {baseURL}/chat/completions with
// `stream: true`. Most providers speak it (OpenRouter, OpenCode Zen, Groq, DeepSeek, MiniMax,
// Gemini's OpenAI endpoint, Ollama, ...), each with small quirks the stream parser smooths over:
// tool calls without ids or indexes, reasoning as `reasoning_content`, `reasoning` or
// `reasoning_details`, usage in a last chunk with no choices, errors inside the stream.
import {
  ProviderError,
  type AssistantMessage,
  type ChatClient,
  type ChatMessage,
  type ChatRequest,
  type FetchLike,
  type StreamEvent,
  type TokenUsage,
  type ToolCall,
  type WireEndpoint,
} from "../types.js";
import { isRecord, num, parseToolArguments, str } from "./convert.js";
import { defaultFetch, errorMessageFrom, joinURL, mergeHeaders, openStream, statusForErrorCode } from "./http.js";

/** The raw fields an assistant message keeps for the next request (`AssistantMessage.raw.data`). */
export interface OpenAIChatRaw {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Array<Record<string, unknown>>;
}

const RAW_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"] as const;

/** The conversation as chat completions messages: system first, then one entry per message. */
export function toOpenAIChatMessages(system: string, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      if (m.images?.length) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
          ],
        });
      } else {
        out.push({ role: "user", content: m.content });
      }
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else {
      const calls = m.toolCalls ?? [];
      const msg: Record<string, unknown> = {
        role: "assistant",
        // null is only valid next to tool calls; a bare empty answer stays "".
        content: m.content ? m.content : calls.length ? null : "",
      };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      if (m.raw?.wire === "openai-chat" && isRecord(m.raw.data)) {
        for (const key of RAW_FIELDS) {
          if (m.raw.data[key] !== undefined) msg[key] = m.raw.data[key];
        }
      }
      out.push(msg);
    }
  }
  return out;
}

/** The request body for `request` (endpoint.body is merged in last). */
export function buildOpenAIChatBody(request: ChatRequest, endpoint: WireEndpoint): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOpenAIChatMessages(request.system, request.messages),
  };
  if (request.tools.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  body.stream = true;
  body.stream_options = { include_usage: true };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoningEffort !== undefined) body.reasoning_effort = request.reasoningEffort;
  return { ...body, ...endpoint.body };
}

/** The request headers (endpoint.headers win, names compared without case). */
export function buildOpenAIChatHeaders(endpoint: WireEndpoint): Record<string, string> {
  return mergeHeaders(
    {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    endpoint.headers,
  );
}

/** finish_reason in the neutral vocabulary ("tool_calls" -> "tool_use", ...). */
export function mapOpenAIChatFinishReason(reason: string | null, hasToolCalls: boolean): string {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  // Some providers (Gemini, Ollama) say "stop" next to tool calls.
  if (hasToolCalls && (reason === null || reason === "stop" || reason === "")) return "tool_use";
  if (reason === null || reason === "stop" || reason === "") return "end_turn";
  return reason;
}

interface ToolSlot {
  id: string;
  name: string;
  args: string;
}

/** Folds the chunks of one streamed completion into events and the final message. */
class ChatStream {
  text = "";
  reasoning = "";
  reasoningField: "reasoning_content" | "reasoning" | null = null;
  details: Array<Record<string, unknown>> = [];
  slots: ToolSlot[] = [];
  byIndex = new Map<number, ToolSlot>();
  finishReason: string | null = null;
  usage: TokenUsage | null = null;
  chunks = 0;

  push(chunk: unknown): StreamEvent[] {
    if (!isRecord(chunk)) return [];
    this.chunks++;
    if (chunk.error !== undefined && chunk.error !== null) {
      const err = chunk.error;
      const text = JSON.stringify(chunk);
      const status = isRecord(err) ? statusForErrorCode(err.code ?? err.type ?? err.status) : 500;
      throw new ProviderError(errorMessageFrom(text) ?? "The provider reported an error.", status, null, text);
    }
    if (isRecord(chunk.usage)) this.usage = readUsage(chunk.usage);

    const events: StreamEvent[] = [];
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isRecord(choice)) return events;
    const finish = str(choice.finish_reason);
    if (finish) this.finishReason = finish;
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
    if (!delta) return events;

    let reasoning = "";
    const rc = str(delta.reasoning_content);
    const r = str(delta.reasoning);
    if (rc) {
      reasoning = rc;
      this.reasoningField ??= "reasoning_content";
    } else if (r) {
      reasoning = r;
      this.reasoningField ??= "reasoning";
    }
    if (Array.isArray(delta.reasoning_details)) {
      const fromDetails = this.mergeDetails(delta.reasoning_details);
      // OpenRouter sends both `reasoning` and `reasoning_details`; MiniMax only the details.
      if (!reasoning) reasoning = fromDetails;
    }
    if (reasoning) {
      this.reasoning += reasoning;
      events.push({ type: "reasoning", text: reasoning });
    }

    const content = str(delta.content);
    if (content) {
      this.text += content;
      events.push({ type: "text", text: content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) if (isRecord(tc)) this.toolDelta(tc);
    }
    return events;
  }

  /** Accumulates reasoning_details by index; returns the readable text this chunk added. */
  private mergeDetails(items: unknown[]): string {
    let text = "";
    for (const item of items) {
      if (!isRecord(item)) continue;
      const piece = str(item.text) ?? str(item.summary) ?? "";
      if (item.type !== "reasoning.encrypted") text += piece;
      const index = num(item.index);
      const existing = index === undefined
        ? undefined
        : this.details.find((d) => d.index === index && d.type === item.type);
      if (!existing) {
        this.details.push({ ...item });
        continue;
      }
      for (const [key, value] of Object.entries(item)) {
        if (key === "index" || key === "type" || value === undefined || value === null) continue;
        if ((key === "text" || key === "summary") && typeof value === "string") {
          existing[key] = (str(existing[key]) ?? "") + value;
        } else if (value !== "") {
          existing[key] = value;
        }
      }
    }
    return text;
  }

  private toolDelta(tc: Record<string, unknown>): void {
    const id = str(tc.id) ?? "";
    const fn = isRecord(tc.function) ? tc.function : {};
    const name = str(fn.name) ?? "";
    const index = num(tc.index);
    const last = this.slots[this.slots.length - 1];
    let slot: ToolSlot | undefined;
    if (index !== undefined) {
      slot = this.byIndex.get(index);
      // A different id at a used index is a new call (some providers number every call 0).
      if (slot && id && slot.id && id !== slot.id) slot = undefined;
      if (!slot) {
        slot = this.newSlot();
        this.byIndex.set(index, slot);
      }
    } else if (id) {
      slot = this.slots.find((s) => s.id === id) ?? this.newSlot();
    } else if (last && !(name && last.name)) {
      slot = last;
    } else {
      slot = this.newSlot();
    }
    if (id && !slot.id) slot.id = id;
    if (name && !slot.name) slot.name = name;
    if (typeof fn.arguments === "string") slot.args += fn.arguments;
    else if (isRecord(fn.arguments)) slot.args = JSON.stringify(fn.arguments);
  }

  private newSlot(): ToolSlot {
    const slot = { id: "", name: "", args: "" };
    this.slots.push(slot);
    return slot;
  }

  finish(): StreamEvent[] {
    const calls: ToolCall[] = [];
    const used = new Set<string>();
    this.slots.forEach((slot, n) => {
      if (!slot.name) return;
      let id = slot.id;
      if (!id || used.has(id)) {
        id = `call_${n}`;
        for (let k = 1; used.has(id); k++) id = `call_${n}_${k}`;
      }
      used.add(id);
      calls.push({ id, name: slot.name, arguments: parseToolArguments(slot.args) });
    });

    const events: StreamEvent[] = calls.map((call) => ({ type: "tool_call", call }));
    if (this.usage) events.push({ type: "usage", ...this.usage });

    const message: AssistantMessage = { role: "assistant", content: this.text };
    if (calls.length) message.toolCalls = calls;
    if (this.reasoning) message.reasoning = this.reasoning;
    const raw: OpenAIChatRaw = {};
    if (this.reasoning && this.reasoningField) raw[this.reasoningField] = this.reasoning;
    if (this.details.length) raw.reasoning_details = this.details;
    if (Object.keys(raw).length) message.raw = { wire: "openai-chat", data: raw };

    events.push({
      type: "done",
      stopReason: mapOpenAIChatFinishReason(this.finishReason, calls.length > 0),
      message,
    });
    return events;
  }
}

function readUsage(u: Record<string, unknown>): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0,
    outputTokens: num(u.completion_tokens) ?? num(u.output_tokens) ?? 0,
  };
  const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  // DeepSeek reports cache hits as prompt_cache_hit_tokens.
  const cached = num(details.cached_tokens) ?? num(u.prompt_cache_hit_tokens);
  if (cached !== undefined) usage.cacheReadTokens = cached;
  const written = num(details.cache_write_tokens) ?? num(u.cache_creation_input_tokens);
  if (written !== undefined) usage.cacheWriteTokens = written;
  return usage;
}

/** A non-streamed completion (some servers ignore `stream`) as one chunk for `ChatStream`. */
function completionAsChunk(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.choices)) return value;
  const choices = value.choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return choice;
    const message = choice.message;
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((tc, index) => (isRecord(tc) ? { ...tc, index } : tc))
      : undefined;
    return { ...choice, message: undefined, delta: { ...message, tool_calls: toolCalls } };
  });
  return { ...value, choices };
}

/** A chat client for an OpenAI-compatible chat completions endpoint. */
export function createOpenAIChatClient(endpoint: WireEndpoint, fetchImpl: FetchLike = defaultFetch): ChatClient {
  return {
    wire: "openai-chat",
    async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      const opened = await openStream({
        fetchImpl,
        url: joinURL(endpoint.baseURL, "chat/completions"),
        headers: buildOpenAIChatHeaders(endpoint),
        body: buildOpenAIChatBody(request, endpoint),
        signal: request.signal,
      });
      const state = new ChatStream();
      if (opened.kind === "json") {
        yield* state.push(completionAsChunk(opened.value));
      } else {
        for await (const message of opened.events) {
          const data = message.data.trim();
          if (data === "[DONE]") break;
          if (data === "") continue;
          let chunk: unknown;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // keep-alive junk some proxies interleave
          }
          yield* state.push(chunk);
        }
      }
      if (state.chunks === 0) {
        throw new ProviderError("The provider closed the stream without sending anything.", 502);
      }
      yield* state.finish();
    },
  };
}
