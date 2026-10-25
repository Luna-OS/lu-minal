// The OpenAI Responses wire ("openai-responses"): POST {baseURL}/responses with `stream: true`
// and `store: false`. Nothing is kept on OpenAI's side, so every request carries the whole
// conversation; a previous answer's output items (reasoning with `encrypted_content`, function
// calls, messages) go back as they came, which keeps the model's reasoning across tool calls.
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
import { defaultFetch, joinURL, mergeHeaders, openStream, statusForErrorCode } from "./http.js";

/**
 * A stored output item for the next request. With `store: false` nothing can be looked up by id,
 * so item ids are dropped (as the Codex CLI does) and reasoning items without `encrypted_content`
 * (which would need such a lookup) are left out.
 */
function replayItem(item: unknown): unknown | null {
  if (!isRecord(item)) return null;
  if (item.type === "reasoning" && !str(item.encrypted_content)) return null;
  const { id: _id, ...rest } = item;
  return rest;
}

/** The conversation as Responses input items. */
export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: [
          { type: "input_text", text: m.content },
          ...(m.images ?? []).map((img) => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` })),
        ],
      });
    } else if (m.role === "tool") {
      out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    } else if (m.raw?.wire === "openai-responses" && Array.isArray(m.raw.data)) {
      for (const item of m.raw.data) {
        const replayed = replayItem(item);
        if (replayed) out.push(replayed);
      }
    } else {
      if (m.content) out.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
      }
    }
  }
  return out;
}

/** The request body for `request` (endpoint.body is merged in last). */
export function buildOpenAIResponsesBody(request: ChatRequest, endpoint: WireEndpoint): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model };
  if (request.system) body.instructions = request.system;
  body.input = toResponsesInput(request.messages);
  if (request.tools.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }
  body.stream = true;
  body.store = false;
  body.include = ["reasoning.encrypted_content"];
  if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.reasoningEffort !== undefined) {
    body.reasoning = { effort: request.reasoningEffort, summary: "auto" };
  }
  return { ...body, ...endpoint.body };
}

/** The request headers (endpoint.headers win, names compared without case). */
export function buildOpenAIResponsesHeaders(endpoint: WireEndpoint): Record<string, string> {
  return mergeHeaders(
    {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    endpoint.headers,
  );
}

function readUsage(u: Record<string, unknown>): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
  };
  const details = isRecord(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = num(details.cached_tokens);
  if (cached !== undefined) usage.cacheReadTokens = cached;
  return usage;
}

/** Folds the events of one streamed response into stream events and the final message. */
class ResponsesStream {
  text = "";
  reasoning = "";
  calls: ToolCall[] = [];
  seen = new Set<string>();
  textKey: string | null = null;
  reasoningKey: string | null = null;
  done = false;

  handle(type: string, data: Record<string, unknown>): StreamEvent[] {
    switch (type) {
      case "response.output_text.delta": {
        const delta = str(data.delta);
        if (!delta) return [];
        const key = `${str(data.item_id) ?? ""}:${num(data.content_index) ?? 0}`;
        const sep = this.text && this.textKey !== null && key !== this.textKey ? "\n\n" : "";
        this.textKey = key;
        this.text += sep + delta;
        return [{ type: "text", text: sep + delta }];
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const delta = str(data.delta);
        if (!delta) return [];
        const part = num(data.summary_index) ?? num(data.content_index) ?? 0;
        const key = `${type}:${str(data.item_id) ?? ""}:${part}`;
        const sep = this.reasoning && this.reasoningKey !== null && key !== this.reasoningKey ? "\n\n" : "";
        this.reasoningKey = key;
        this.reasoning += sep + delta;
        return [{ type: "reasoning", text: sep + delta }];
      }
      case "response.output_item.done": {
        const call = this.functionCall(data.item);
        return call ? [{ type: "tool_call", call }] : [];
      }
      case "response.completed":
        return this.finish(data.response, null);
      case "response.incomplete": {
        const response = isRecord(data.response) ? data.response : {};
        const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
        const reason = str(details.reason) ?? "unknown";
        if (reason === "max_output_tokens") return this.finish(response, "max_tokens");
        throw new ProviderError(
          `The response is incomplete (${reason}).`,
          reason === "content_filter" ? 400 : 500,
          null,
          JSON.stringify(data),
        );
      }
      case "response.failed": {
        const response = isRecord(data.response) ? data.response : {};
        const err = isRecord(response.error) ? response.error : {};
        throw new ProviderError(
          str(err.message) ?? "The response failed.",
          statusForErrorCode(err.code ?? err.type),
          null,
          JSON.stringify(data),
        );
      }
      case "error": {
        const err = isRecord(data.error) ? data.error : data;
        throw new ProviderError(
          str(err.message) ?? "The provider reported an error.",
          statusForErrorCode(err.code ?? err.type ?? err.status),
          null,
          JSON.stringify(data),
        );
      }
      default:
        return [];
    }
  }

  private functionCall(item: unknown): ToolCall | null {
    if (!isRecord(item) || item.type !== "function_call") return null;
    const id = str(item.call_id) || str(item.id) || `call_${this.calls.length}`;
    if (this.seen.has(id)) return null;
    this.seen.add(id);
    const call: ToolCall = { id, name: str(item.name) ?? "", arguments: parseToolArguments(str(item.arguments)) };
    this.calls.push(call);
    return call;
  }

  private finish(responseValue: unknown, stopReason: string | null): StreamEvent[] {
    this.done = true;
    const response = isRecord(responseValue) ? responseValue : {};
    const output = Array.isArray(response.output) ? response.output : [];
    const events: StreamEvent[] = [];
    // Calls (and text) the stream didn't deliver item by item still count.
    for (const item of output) {
      const call = this.functionCall(item);
      if (call) events.push({ type: "tool_call", call });
    }
    if (!this.text) {
      const text = output
        .filter((item) => isRecord(item) && item.type === "message" && Array.isArray(item.content))
        .flatMap((item) => (item as { content: unknown[] }).content)
        .map((part) => (isRecord(part) && part.type === "output_text" ? (str(part.text) ?? "") : ""))
        .join("");
      if (text) {
        this.text = text;
        events.unshift({ type: "text", text });
      }
    }
    if (isRecord(response.usage)) events.push({ type: "usage", ...readUsage(response.usage) });

    const message: AssistantMessage = { role: "assistant", content: this.text };
    if (this.calls.length) message.toolCalls = this.calls;
    if (this.reasoning) message.reasoning = this.reasoning;
    if (output.length) message.raw = { wire: "openai-responses", data: output };
    events.push({
      type: "done",
      stopReason: stopReason ?? (this.calls.length ? "tool_use" : "end_turn"),
      message,
    });
    return events;
  }
}

/** A chat client for the OpenAI Responses API. */
export function createOpenAIResponsesClient(endpoint: WireEndpoint, fetchImpl: FetchLike = defaultFetch): ChatClient {
  return {
    wire: "openai-responses",
    async *stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      const opened = await openStream({
        fetchImpl,
        url: joinURL(endpoint.baseURL, "responses"),
        headers: buildOpenAIResponsesHeaders(endpoint),
        body: buildOpenAIResponsesBody(request, endpoint),
        signal: request.signal,
      });
      const state = new ResponsesStream();
      if (opened.kind === "json") {
        // A server that ignored `stream`: the JSON is the finished response.
        const value = isRecord(opened.value) ? opened.value : {};
        const status = str(value.status);
        const type = status === "incomplete" ? "response.incomplete" : status === "failed" ? "response.failed" : "response.completed";
        yield* state.handle(type, { type, response: value });
        return;
      }
      for await (const message of opened.events) {
        if (!message.data || message.data === "[DONE]") continue;
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          continue;
        }
        if (!isRecord(data)) continue;
        const type = str(data.type) ?? message.event ?? "";
        yield* state.handle(type, data);
        if (state.done) return;
      }
      throw new ProviderError("The stream ended before the response was complete.", 502);
    },
  };
}
