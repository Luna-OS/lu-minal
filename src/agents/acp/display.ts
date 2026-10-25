// How an ACP agent's activity shows up in an agent's panel: tool calls become tool rows (verb and
// target from the call's kind, title, locations and raw input; a diff from its diff content),
// permission requests become approvals (risk from the tool kind), and stop reasons, plans and
// permission modes are mapped to lu-minal's terms. Pure functions, so they are easy to test.
import path from "node:path";
import type { DiffLine, PermissionMode, RiskKind } from "../../core/types.js";
import { describeChange, makeDiff } from "../../tools/diff.js";
import { clip, displayPath, firstLine } from "../claude-code/display.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** ACP's tool kinds. */
export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
/** ACP's tool call statuses. */
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

const KINDS = new Set<AcpToolKind>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);

export function toolKind(v: unknown): AcpToolKind | null {
  return typeof v === "string" && KINDS.has(v as AcpToolKind) ? (v as AcpToolKind) : null;
}

/** The panel verb for each tool kind ("other" takes the title's first word instead). */
export const KIND_VERBS: Record<AcpToolKind, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "grep",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
};

/** The approval risk for each tool kind. */
export const KIND_RISKS: Record<AcpToolKind, RiskKind> = {
  read: "read",
  search: "read",
  think: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  execute: "exec",
  fetch: "network",
  switch_mode: "other",
  other: "other",
};

/** A tool row's status for an ACP status (pending and in_progress both run). */
export function rowStatus(status: unknown): "running" | "ok" | "error" {
  if (status === "completed") return "ok";
  if (status === "failed") return "error";
  return "running";
}

export function riskFor(kind: AcpToolKind | null): RiskKind {
  return kind ? KIND_RISKS[kind] : "other";
}

/** A location's path, if any. */
function firstLocation(locations: unknown): { path: string; line: number | null } | null {
  if (!Array.isArray(locations)) return null;
  for (const l of locations) {
    if (isObj(l) && typeof l.path === "string" && l.path) return { path: l.path, line: typeof l.line === "number" ? l.line : null };
  }
  return null;
}

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return clip(`${u.host}${u.pathname === "/" ? "" : u.pathname}`, 60);
  } catch {
    return clip(url, 60);
  }
}

function inputPath(input: Obj): string {
  return str(input.filePath) || str(input.file_path) || str(input.path) || str(input.filepath) || str(input.absolute_path) || str(input.notebook_path);
}

/** The title when it says more than the tool's name or kind. */
function meaningfulTitle(title: string, kind: AcpToolKind | null, name: string): string {
  const t = title.trim();
  if (!t) return "";
  const lower = t.toLowerCase();
  if (lower === name.toLowerCase() || (kind && lower === kind) || (kind && lower === KIND_VERBS[kind])) return "";
  return t;
}

export interface ToolCallView {
  kind: AcpToolKind | null;
  title: string;
  /** The tool's programmatic name when the agent sends one. */
  name: string;
  rawInput: Obj;
  locations: unknown;
}

/** The verb and target of a tool row, from what the agent said about the call. */
export function describeAcpTool(call: ToolCallView, cwd: string, isNewFile = false): { verb: string; target?: string } {
  const { kind, rawInput: input } = call;
  const loc = firstLocation(call.locations);
  const title = meaningfulTitle(call.title, kind, call.name);
  const file = loc?.path || inputPath(input);
  const shownFile = file ? displayPath(file, cwd) : "";
  const pick = (...candidates: string[]) => {
    const t = candidates.find((c) => c && c.trim());
    return t ? firstLine(t, 70) : undefined;
  };
  switch (kind) {
    case "read":
      return { verb: "read", target: pick(shownFile, title) };
    case "edit":
      return { verb: isNewFile ? "new" : "edit", target: pick(shownFile, title) };
    case "delete":
      return { verb: "delete", target: pick(shownFile, title) };
    case "move": {
      const to = str(input.destination) || str(input.newPath) || str(input.to) || str(input.movePath);
      return { verb: "move", target: pick(shownFile && to ? `${shownFile} → ${displayPath(to, cwd)}` : "", shownFile, title) };
    }
    case "search": {
      const pattern = str(input.pattern) || str(input.query) || str(input.regex);
      const where = str(input.path) ? ` in ${displayPath(str(input.path), cwd)}` : str(input.include) ? ` in ${str(input.include)}` : "";
      return { verb: "grep", target: pick(pattern ? clip(pattern + where, 70) : "", title) };
    }
    case "execute": {
      const command = str(input.command) || str(input.cmd) || (Array.isArray(input.command) ? input.command.filter((c) => typeof c === "string").join(" ") : "");
      return { verb: "run", target: pick(command, title) };
    }
    case "fetch": {
      const url = str(input.url) || str(input.uri);
      return { verb: "fetch", target: pick(url ? hostPath(url) : "", str(input.query), title) };
    }
    case "think":
      return { verb: "think", target: pick(str(input.description), title) };
    case "switch_mode":
      return { verb: "mode", target: pick(str(input.mode), str(input.modeId), title) };
    case "other":
    case null:
    default: {
      // "todowrite", "Searching the web", "luminal_send_message": the first word is the verb.
      const text = call.title.trim() || call.name.trim();
      if (!text) return { verb: "tool" };
      const [head, ...rest] = text.split(/\s+/);
      const verb = clip(head.toLowerCase().replace(/[_-]+/g, " ").trim() || "tool", 24);
      const target = rest.join(" ").trim() || shownFile;
      return target ? { verb, target: firstLine(target, 70) } : { verb };
    }
  }
}

/** The text of a tool call's content blocks ("content" items with text). */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isObj(item) || item.type !== "content") continue;
    const block = isObj(item.content) ? item.content : null;
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && isObj(block.resource) && typeof block.resource.text === "string") parts.push(block.resource.text);
    else if (block.type === "resource_link" && typeof block.uri === "string") parts.push(block.uri);
  }
  return parts.join("\n");
}

export interface AcpDiffItem {
  path: string;
  oldText: string | null;
  newText: string;
}

/** The diff items of a tool call's content. */
export function diffItems(content: unknown): AcpDiffItem[] {
  if (!Array.isArray(content)) return [];
  const out: AcpDiffItem[] = [];
  for (const item of content) {
    if (!isObj(item) || item.type !== "diff" || typeof item.newText !== "string") continue;
    out.push({ path: str(item.path), oldText: typeof item.oldText === "string" ? item.oldText : null, newText: item.newText });
  }
  return out;
}

/** The panel diff of a call's diff items (several files are separated by a gap row). */
export function diffDisplay(items: AcpDiffItem[], cwd: string): { lines: DiffLine[]; added: number; removed: number; isNew: boolean } | null {
  if (!items.length) return null;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  items.forEach((item, i) => {
    const d = makeDiff(item.oldText ?? "", item.newText);
    if (items.length > 1) {
      if (i > 0) lines.push({ kind: "gap", line: null, text: "…" });
      lines.push({ kind: "gap", line: null, text: displayPath(item.path, cwd) || path.basename(item.path) });
    }
    lines.push(...d.lines);
    added += d.added;
    removed += d.removed;
  });
  // A missing or empty old text: the file is new (OpenCode sends "" for a file it creates).
  return { lines, added, removed, isNew: items.length === 1 && !items[0].oldText };
}

/** The one-line result under a finished row. */
export function resultDetail(kind: AcpToolKind | null, status: "ok" | "error", text: string, rawOutput: unknown, diff: { added: number; removed: number } | null): string {
  const out = isObj(rawOutput) ? rawOutput : {};
  if (status === "error") {
    const err = text || str(out.error) || str(out.message);
    return firstLine(err) || "failed";
  }
  if (diff) return describeChange(diff.added, diff.removed);
  const body = text || str(out.output) || (typeof rawOutput === "string" ? rawOutput : "");
  if (kind === "read" && body) {
    const n = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
    return plural(n, "line");
  }
  if (kind === "execute") {
    const meta = isObj(out.metadata) ? out.metadata : {};
    const exit = typeof meta.exit === "number" ? meta.exit : typeof out.exitCode === "number" ? out.exitCode : null;
    const line = firstLine(body);
    if (exit !== null && exit !== 0) return line ? `exit ${exit} · ${line}` : `exit ${exit}`;
    return line || "done";
  }
  return firstLine(body) || "done";
}

// ---- permissions ---------------------------------------------------------------------------------

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export function permissionOptions(v: unknown): AcpPermissionOption[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((o): o is Obj => isObj(o) && typeof o.optionId === "string")
    .map((o) => ({ optionId: o.optionId as string, name: str(o.name), kind: str(o.kind) }));
}

/**
 * The option that answers lu-minal's decision: "always" takes allow_always (else allow_once),
 * "allow" allow_once (else allow_always), "deny" reject_once (else reject_always). Null when the
 * agent offered nothing that fits (the request is then answered as cancelled).
 */
export function pickPermissionOption(options: AcpPermissionOption[], decision: "allow" | "always" | "deny"): string | null {
  const byKind = (kind: string) => options.find((o) => o.kind === kind)?.optionId ?? null;
  if (decision === "always") return byKind("allow_always") ?? byKind("allow_once");
  if (decision === "allow") return byKind("allow_once") ?? byKind("allow_always");
  return byKind("reject_once") ?? byKind("reject_always");
}

// ---- turns ---------------------------------------------------------------------------------------

/** A line for the log when a turn ended for another reason than end_turn / cancelled, else null. */
export function stopReasonNote(reason: unknown, agentName: string): { level: "info" | "error"; text: string } | null {
  switch (reason) {
    case "end_turn":
    case "cancelled":
    case undefined:
    case null:
      return null;
    case "max_tokens":
      return { level: "info", text: `${agentName} stopped: the model reached its output limit.` };
    case "max_turn_requests":
      return { level: "info", text: `${agentName} stopped: it reached its limit of model requests for one turn.` };
    case "refusal":
      return { level: "error", text: `${agentName}'s model refused to continue.` };
    default:
      return { level: "info", text: `${agentName} stopped (${String(reason)}).` };
  }
}

export interface PlanEntry {
  content: string;
  status: string;
}

export function planEntries(v: unknown): PlanEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is Obj => isObj(e) && typeof e.content === "string").map((e) => ({ content: e.content as string, status: str(e.status) }));
}

/** "plan 1/3 · ▸ write the tests" – the plan's progress and the step being worked on. */
export function planSummary(entries: PlanEntry[]): string {
  if (!entries.length) return "plan cleared";
  const done = entries.filter((e) => e.status === "completed").length;
  const current = entries.find((e) => e.status === "in_progress") ?? entries.find((e) => e.status !== "completed");
  const head = `plan ${done}/${entries.length}`;
  return current ? `${head} · ▸ ${firstLine(current.content, 70)}` : `${head} · done`;
}

// ---- modes ---------------------------------------------------------------------------------------

export interface AcpMode {
  id: string;
  name: string;
}

/**
 * The agent's session mode for lu-minal's permission mode. Only "plan" has a counterpart that is
 * safe to pick (a read-only mode); every other mode keeps the agent's default mode, so the agent
 * keeps asking and lu-minal decides by its own rules. Null when nothing should change.
 */
export function modeFor(permissionMode: PermissionMode, modes: AcpMode[], defaultMode: string | null): string | null {
  if (!modes.length) return null;
  if (permissionMode === "plan") {
    const plan = modes.find((m) => /^plan$/i.test(m.id) || /^plan$/i.test(m.name)) ?? modes.find((m) => /plan|read.?only/i.test(`${m.id} ${m.name}`));
    if (plan) return plan.id;
  }
  return defaultMode && modes.some((m) => m.id === defaultMode) ? defaultMode : null;
}
