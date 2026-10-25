// The native agent's conversation bookkeeping: what a turn costs, when the context gets too full
// and how old tool output is dropped to make room, how teammates' messages read, and the
// conversation as JSON for the session file.
import type { AgentInput } from "../../core/agent.js";
import { messageParts } from "../../core/attachments.js";
import type { ModelInfo } from "../../providers/models.js";
import type { ChatMessage, TokenUsage, ToolResultMessage, UserMessage } from "../../providers/types.js";

/** What an old tool result is replaced with once the context gets full. */
export const REMOVED_OUTPUT = "[output removed to save context]";

/** How many of the newest tool results are always kept whole. */
export const KEEP_TOOL_RESULTS = 6;

/** The context budget when the catalog doesn't know the model's window. */
export const UNKNOWN_CONTEXT_LIMIT = 120_000;

/** How a message reads in the conversation: the user's as is, a teammate's with "[message from x]". */
export function formatInput(input: AgentInput): string {
  const from = input.from.trim();
  if (!from || from === "you" || from === "user") return input.text;
  return `[message from ${from}] ${input.text}`;
}

/**
 * The conversation entry for an input: its text, the attached files listed (text files inlined),
 * and the pictures as images when the model can see them.
 */
export function userMessageFor(input: AgentInput, vision: boolean): UserMessage {
  const text = formatInput(input);
  if (!input.attachments?.length) return { role: "user", content: text };
  const parts = messageParts(text, input.attachments, { images: vision });
  const first = parts[0];
  const images = parts.flatMap((p) => (p.type === "image" ? [{ mediaType: p.mediaType, data: p.data }] : []));
  return { role: "user", content: first?.type === "text" ? first.text : text, ...(images.length ? { images } : {}) };
}

/** USD for one request: fresh input, cache reads and writes, and output, by the model's prices. */
export function costOf(usage: TokenUsage, cost: ModelInfo["cost"]): number {
  if (!cost) return 0;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  // Every wire reports inputTokens including the cached part.
  const fresh = Math.max(0, usage.inputTokens - read - write);
  const total =
    fresh * cost.input +
    read * (cost.cacheRead ?? cost.input) +
    write * (cost.cacheWrite ?? cost.input) +
    usage.outputTokens * cost.output;
  return total / 1_000_000;
}

/** Input tokens above which old tool output is dropped: 75% of the window, or ~120k when unknown. */
export function contextLimit(model: ModelInfo): number {
  return model.contextWindow && model.contextWindow > 0 ? Math.floor(model.contextWindow * 0.75) : UNKNOWN_CONTEXT_LIMIT;
}

/**
 * Replaces the content of all but the newest `keep` tool results with REMOVED_OUTPUT (in place).
 * Returns how many were replaced.
 */
export function trimToolResults(messages: ChatMessage[], keep = KEEP_TOOL_RESULTS): number {
  const results = messages.filter((m): m is ToolResultMessage => m.role === "tool");
  let trimmed = 0;
  for (const m of results.slice(0, Math.max(0, results.length - keep))) {
    if (m.content === REMOVED_OUTPUT || m.content.length <= REMOVED_OUTPUT.length) continue;
    m.content = REMOVED_OUTPUT;
    trimmed++;
  }
  return trimmed;
}

/** What `NativeDriver.snapshot()` returns. */
export interface SavedConversation {
  version: 1;
  messages: ChatMessage[];
}

const SAVED_MESSAGES = 300;
const SAVED_TOOL_CHARS = 10_000;

/** The conversation as JSON-safe data: the newest messages (from a user message on), long tool output cut. */
export function saveConversation(messages: ChatMessage[]): SavedConversation {
  let start = Math.max(0, messages.length - SAVED_MESSAGES);
  while (start > 0 && start < messages.length && messages[start].role !== "user") start++;
  if (start >= messages.length) start = Math.max(0, messages.length - SAVED_MESSAGES);
  const out = messages.slice(start).map((m): ChatMessage => {
    // Pictures stay out of the session file (they can be megabytes); the text keeps their paths.
    if (m.role === "user" && m.images?.length) {
      const { images: _images, ...rest } = m;
      return { ...rest, content: `${m.content}\n[${m.images.length} picture(s) not kept after the restart]` };
    }
    if (m.role === "tool" && m.content.length > SAVED_TOOL_CHARS) {
      return { ...m, content: `${m.content.slice(0, SAVED_TOOL_CHARS)}\n[cut when the session was saved]` };
    }
    return JSON.parse(JSON.stringify(m)) as ChatMessage;
  });
  return { version: 1, messages: out };
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (m.role === "user") return typeof m.content === "string";
  if (m.role === "assistant") return typeof m.content === "string" && (m.toolCalls === undefined || Array.isArray(m.toolCalls));
  if (m.role === "tool") return typeof m.content === "string" && typeof m.toolCallId === "string" && typeof m.name === "string";
  return false;
}

/**
 * A saved conversation back as messages, or null when it isn't one. Tool calls whose results are
 * missing get an "interrupted" result, so the next request is valid for every wire.
 */
export function loadConversation(state: unknown): ChatMessage[] | null {
  if (!state || typeof state !== "object") return null;
  const raw = (state as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return null;
  const messages = raw.filter(isMessage);
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
      answered.add((messages[j] as ToolResultMessage).toolCallId);
    }
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    // Results come right after their call; put placeholders after the ones that are there.
    let k = i + 1;
    while (k < messages.length && messages[k].role === "tool") out.push(messages[k++]);
    for (const c of missing) out.push({ role: "tool", toolCallId: c.id, name: c.name, content: "Interrupted.", isError: true });
    i = k - 1;
  }
  return out;
}
