// Turns the lines Claude Code prints with `--output-format stream-json --verbose
// --include-partial-messages` into the few events the driver needs. Pure, so it is tested on its
// own with lines in the shapes the CLI really prints.
//
// A subagent's own stream (lines with a `parent_tool_use_id`) is skipped: only the main
// conversation reaches the panel. Line types the driver has no use for (active_goal,
// system/post_turn_summary, system/task_summary, system/thinking_tokens, ...) give no events.
//
// test/claude-code/fixtures/*.jsonl are real transcripts (trimmed, anonymised) that the tests replay.
import type { UsageWindow } from "../../core/types.js";

/** Token counts as the CLI reports them for a turn. */
export interface ClaudeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ClaudeDenial {
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
}

export type ClaudeInitEvent = {
  kind: "init";
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
  permissionMode: string | null;
  version: string | null;
  /** The MCP servers and whether they connected ("connected", "failed", "needs-auth", ...). */
  mcpServers: Array<{ name: string; status: string }>;
  /** The tools the model can use ("Bash", "Edit", "mcp__luminal__send_message", ...). */
  tools: string[];
  /** What the CLI's stream-json protocol supports ("interrupt_receipt_v1", ...). */
  capabilities: string[];
};

export type ClaudeRateLimitEvent = {
  kind: "rate-limit";
  /** "allowed" | "allowed_warning" | "rejected". */
  status: string | null;
  /** The window the status is about: "five_hour", "seven_day", "seven_day_opus", ... */
  type: string | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Per-model weekly windows ("Opus", "Sonnet") when the line carries them. */
  models?: Array<{ name: string } & UsageWindow>;
  usingOverage: boolean;
};

export type ClaudeResultEvent = {
  kind: "result";
  ok: boolean;
  subtype: string | null;
  /** The final answer, or the error text. */
  text: string;
  /** What the process has cost so far (Claude Code reports a running total). */
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  usage: ClaudeUsage | null;
  denials: ClaudeDenial[];
  sessionId: string | null;
  /** Why the turn ended: "completed", "aborted_tools" (an interrupt), ...; null when not given. */
  terminalReason: string | null;
};

export type ClaudeEvent =
  | ClaudeInitEvent
  /** The CLI's status: "requesting", "compacting", "compacted" (a compaction ended), "" (none). */
  | { kind: "status"; status: string }
  | { kind: "text-delta"; messageId: string | null; text: string }
  /** The whole text of an answer block (closes the streamed one). */
  | { kind: "text"; messageId: string | null; text: string }
  | { kind: "thinking-delta"; messageId: string | null; text: string }
  | { kind: "tool-use"; id: string; name: string; input: Record<string, unknown> }
  | {
      kind: "tool-result";
      toolUseId: string;
      isError: boolean;
      text: string;
      /** The CLI's structured result (`tool_use_result`: a Edit's structuredPatch, ...), if any. */
      meta?: unknown;
    }
  /** Tokens the conversation takes up now (the input side of the latest request). */
  | { kind: "context"; tokens: number }
  /** Output tokens of one finished model response. */
  | { kind: "output"; tokens: number }
  /** Where Claude Code compacts the conversation. */
  | { kind: "context-window"; tokens: number }
  | ClaudeRateLimitEvent
  | ClaudeResultEvent
  /** The answer to one of our control requests (interrupt, set_permission_mode). */
  | { kind: "control-response"; requestId: string | null; ok: boolean; error: string | null }
  /**
   * A request from the CLI to its host, e.g. { subtype: "can_use_tool", tool_name, input } when it
   * asks for a permission without a permission-prompt tool. It waits for a control response.
   */
  | { kind: "control-request"; requestId: string; subtype: string; request: Record<string, unknown> }
  /** The CLI withdrew one of its control requests (an interrupt while it asked for a permission). */
  | { kind: "control-cancel"; requestId: string }
  /** A line that is not JSON (a warning, a crash), or a line of stderr. */
  | { kind: "stderr"; text: string };

export type ClaudeEventKind = ClaudeEvent["kind"];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A time in ms from seconds or ms (the stream sends seconds). */
function epochMs(v: unknown): number | null {
  const n = num(v);
  if (n === null) {
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  }
  return n < 1e12 ? n * 1000 : n;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && Boolean(s)) : []);

/**
 * A rate-limit window as { utilization 0..1, resetsAt ms }, or null. The stream sends
 * `utilization` as a fraction (0.15); a `percent` field (0..100) is read too. A window that is
 * "rejected" without a number is full.
 */
function rateWindow(w: unknown, status: string | null = null): UsageWindow | null {
  if (!isObj(w)) return null;
  let u = num(w.utilization);
  if (u === null) {
    const p = num(w.percent);
    if (p !== null) u = p / 100;
  }
  if (u === null && (str(w.status) ?? status) === "rejected") u = 1;
  if (u === null) return null;
  return { utilization: u, resetsAt: epochMs(w.resetsAt ?? w.resets_at) };
}

/** Per-model weekly windows by their key. */
const MODEL_WINDOWS: Array<[string, string]> = [
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
];

/** "fiveHour" for "five_hour". */
const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The text of a tool result's content (a string or a list of blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!isObj(b)) return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function contextTokens(u: Obj): number {
  return (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
}

function usageOf(u: unknown): ClaudeUsage | null {
  if (!isObj(u)) return null;
  return {
    input: num(u.input_tokens) ?? 0,
    output: num(u.output_tokens) ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  };
}

/** Internal: a message_start, so deltas can be tied to their message. */
type StreamStart = { kind: "stream-start"; messageId: string | null };

function streamEvents(msg: Obj): Array<ClaudeEvent | StreamStart> {
  const ev = isObj(msg.event) ? msg.event : {};
  if (ev.type === "message_start" && isObj(ev.message)) {
    const out: Array<ClaudeEvent | StreamStart> = [{ kind: "stream-start", messageId: str(ev.message.id) }];
    if (isObj(ev.message.usage)) out.push({ kind: "context", tokens: contextTokens(ev.message.usage) });
    return out;
  }
  if (ev.type === "content_block_delta" && isObj(ev.delta)) {
    const d = ev.delta;
    if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
      return [{ kind: "text-delta", messageId: null, text: d.text }];
    }
    if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
      return [{ kind: "thinking-delta", messageId: null, text: d.thinking }];
    }
    return [];
  }
  if (ev.type === "message_delta" && isObj(ev.usage)) {
    const out = num(ev.usage.output_tokens);
    return out !== null ? [{ kind: "output", tokens: out }] : [];
  }
  return [];
}

/**
 * A rate_limit_event. Claude Code 2.1.310 prints
 *   { rate_limit_info: { status, resetsAt, rateLimitType: "five_hour", overageStatus, isUsingOverage,
 *                        unifiedWindows: { five_hour: { utilization, resetsAt, status }, seven_day: {...} } } }
 * while the SDK documents only the window the status is about:
 *   { rate_limit_info: { status, resetsAt?, utilization?, rateLimitType? } }
 * Both are read (snake_case spellings too); the unified windows win over the single one.
 */
function rateLimitEvent(msg: Obj): ClaudeRateLimitEvent {
  const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : isObj(msg.rateLimitInfo) ? msg.rateLimitInfo : msg;
  const unified = info.unifiedWindows ?? info.unified_windows;
  const windows = isObj(unified) ? unified : {};
  const type = str(info.rateLimitType) ?? str(info.rate_limit_type);
  const status = str(info.status);
  const windowAt = (key: string) => rateWindow(windows[key] ?? windows[camel(key)]);
  let fiveHour = windowAt("five_hour");
  let sevenDay = windowAt("seven_day");
  const models: Array<{ name: string } & UsageWindow> = [];
  for (const [key, name] of MODEL_WINDOWS) {
    const w = windowAt(key);
    if (w) models.push({ name, ...w });
  }
  // The documented shape: only the window the status is about, at the top level.
  const single = rateWindow(info, status);
  if (single && type === "five_hour" && !fiveHour) fiveHour = single;
  if (single && type === "seven_day" && !sevenDay) sevenDay = single;
  const model = MODEL_WINDOWS.find(([key]) => key === type);
  if (single && model && !models.some((m) => m.name === model[1])) models.push({ name: model[1], ...single });
  const ev: ClaudeRateLimitEvent = {
    kind: "rate-limit",
    status,
    type,
    fiveHour,
    sevenDay,
    usingOverage: Boolean(info.isUsingOverage ?? info.is_using_overage),
  };
  if (models.length) ev.models = models;
  return ev;
}

/** Lines of the CLI's own diagnostics that it adds to `errors` (not meant for people). */
const DIAGNOSTIC = /^\[[a-z_]+_diagnostic\]/i;

function resultEvent(msg: Obj): ClaudeResultEvent {
  const ok = !msg.is_error && msg.subtype === "success";
  let text = typeof msg.result === "string" ? msg.result : "";
  if (!text && Array.isArray(msg.errors)) {
    text = msg.errors.filter((e): e is string => typeof e === "string" && !DIAGNOSTIC.test(e.trim())).join("\n");
  }
  const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
  return {
    kind: "result",
    ok,
    subtype: str(msg.subtype),
    text,
    costUsd: num(msg.total_cost_usd),
    durationMs: num(msg.duration_ms),
    turns: num(msg.num_turns),
    usage: usageOf(msg.usage),
    denials: denials.filter(isObj).map((d) => ({
      tool: str(d.tool_name) ?? "tool",
      input: isObj(d.tool_input) ? d.tool_input : {},
      toolUseId: str(d.tool_use_id),
    })),
    sessionId: str(msg.session_id),
    terminalReason: str(msg.terminal_reason),
  };
}

function rawEvents(msg: unknown): Array<ClaudeEvent | StreamStart> {
  if (!isObj(msg)) return [];
  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
        return [
          {
            kind: "init",
            model: str(msg.model),
            sessionId: str(msg.session_id),
            cwd: str(msg.cwd),
            permissionMode: str(msg.permissionMode),
            version: str(msg.claude_code_version),
            mcpServers: servers
              .filter(isObj)
              .map((s) => ({ name: str(s.name) ?? "", status: str(s.status) ?? "unknown" }))
              .filter((s) => s.name),
            tools: strings(msg.tools),
            capabilities: strings(msg.capabilities),
          },
        ];
      }
      // "requesting", "compacting", ...; null when the CLI is back to normal.
      if (msg.subtype === "status" && (typeof msg.status === "string" || msg.status === null)) {
        return [{ kind: "status", status: msg.status ?? "" }];
      }
      if (msg.subtype === "compact_boundary") return [{ kind: "status", status: "compacted" }];
      return [];
    }

    case "autocompact_state": {
      const value = isObj(msg.value) ? msg.value : {};
      const tokens = num(value.effective_window);
      return tokens !== null ? [{ kind: "context-window", tokens }] : [];
    }

    case "stream_event":
      if (msg.parent_tool_use_id) return [];
      return streamEvents(msg);

    case "assistant": {
      if (msg.parent_tool_use_id) return [];
      const m = isObj(msg.message) ? msg.message : {};
      const content = Array.isArray(m.content) ? m.content : [];
      const out: ClaudeEvent[] = [];
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          out.push({ kind: "text", messageId: str(m.id), text: block.text });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          out.push({
            kind: "tool-use",
            id: block.id,
            name: str(block.name) ?? "tool",
            input: isObj(block.input) ? block.input : {},
          });
        }
      }
      return out;
    }

    case "user": {
      if (msg.parent_tool_use_id) return [];
      const m = isObj(msg.message) ? msg.message : {};
      if (!Array.isArray(m.content)) return [];
      const results = m.content.filter((b): b is Obj => isObj(b) && b.type === "tool_result");
      // The structured result belongs to the message; it is only unambiguous with one result.
      const meta = results.length === 1 ? (msg.tool_use_result ?? msg.toolUseResult) : undefined;
      return results.map((b) => {
        const ev: ClaudeEvent = {
          kind: "tool-result",
          toolUseId: str(b.tool_use_id) ?? "",
          isError: Boolean(b.is_error),
          text: resultText(b.content),
        };
        if (meta !== undefined) ev.meta = meta;
        return ev;
      });
    }

    case "rate_limit_event":
      return [rateLimitEvent(msg)];

    case "result":
      return [resultEvent(msg)];

    case "control_request": {
      const request = isObj(msg.request) ? msg.request : {};
      const requestId = str(msg.request_id);
      if (!requestId) return [];
      return [{ kind: "control-request", requestId, subtype: str(request.subtype) ?? "", request }];
    }

    case "control_cancel_request": {
      const requestId = str(msg.request_id);
      return requestId ? [{ kind: "control-cancel", requestId }] : [];
    }

    case "control_response": {
      const r = isObj(msg.response) ? msg.response : {};
      return [
        {
          kind: "control-response",
          requestId: str(r.request_id),
          ok: r.subtype === "success",
          error: str(r.error),
        },
      ];
    }

    default:
      return [];
  }
}

/** The events in one parsed stream-json message (often none). Deltas carry no message id here. */
export function eventsFrom(msg: unknown): ClaudeEvent[] {
  return rawEvents(msg).filter((e): e is ClaudeEvent => e.kind !== "stream-start");
}

/**
 * Splits a stdout stream into lines (LF or CRLF) and hands each parsed JSON line's events to
 * `emit`. Lines that are not JSON are passed on as { kind: "stderr", text }. Text and thinking
 * deltas get the id of the message they belong to (the last message_start).
 */
export function createLineParser(emit: (e: ClaudeEvent) => void): { push(chunk: string): void; end(): void } {
  let buffer = "";
  let streamMessageId: string | null = null;
  const handle = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      emit({ kind: "stderr", text: line });
      return;
    }
    for (const ev of rawEvents(msg)) {
      if (ev.kind === "stream-start") {
        streamMessageId = ev.messageId;
        continue;
      }
      if ((ev.kind === "text-delta" || ev.kind === "thinking-delta") && !ev.messageId) ev.messageId = streamMessageId;
      emit(ev);
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handle(line);
      }
    },
    end() {
      const rest = buffer;
      buffer = "";
      if (rest) handle(rest);
    },
  };
}
