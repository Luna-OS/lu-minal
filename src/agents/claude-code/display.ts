// How Claude Code's own tool calls (Read, Edit, Bash, ...) and MCP calls show up in an agent's
// panel: the short verb and target while a call runs ("▸ read src/App.tsx"), and the one-line
// result and diff once it finished ("└ 94 lines", the green and red rows of an edit).
import fs from "node:fs";
import path from "node:path";
import type { DiffLine } from "../../core/types.js";
import { tildify } from "../../platform/paths.js";
import { describeChange, lineOf, makeDiff, type DiffSummary } from "../../tools/diff.js";
import type { ToolDisplay } from "../../tools/types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The prefix of lu-minal's own tools as Claude Code names them. */
export const LUMINAL_TOOL_PREFIX = "mcp__luminal__";

/** Cuts `text` to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** The first non-empty line of `text`, cut to `max`. */
export function firstLine(text: string, max = 80): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return clip(line.trim(), max);
}

/** A path for display: relative to the project when inside it, "~/..." or absolute otherwise. */
export function displayPath(file: string, cwd: string): string {
  if (!file) return "";
  const abs = path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  if (!rel) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return tildify(abs);
  return rel;
}

/** "github.com/owner/repo" from a URL (or the text itself when it is none). */
function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return clip(`${u.host}${u.pathname === "/" ? "" : u.pathname}`, 60);
  } catch {
    return clip(url, 60);
  }
}

const words = (name: string) => name.replace(/[_-]+/g, " ").trim();

/** The verb and target of one of lu-minal's own tools when the MCP server can't say. */
function describeLuminalTool(tool: string, input: Obj): { verb: string; target?: string } {
  switch (tool) {
    case "send_message":
      return { verb: "message", target: `→ ${str(input.to) || "?"}` };
    case "spawn_agent": {
      const who = str(input.name) || str(input.label) || firstLine(str(input.task), 50);
      return who ? { verb: "spawn", target: who } : { verb: "spawn" };
    }
    default: {
      const target = str(input.title) || str(input.name) || str(input.theme) || str(input.id) || str(input.command);
      return target ? { verb: words(tool), target: firstLine(target, 60) } : { verb: words(tool) };
    }
  }
}

/** The panel's verb and target for a Claude Code tool call, from its name and input. */
export function describeClaudeTool(name: string, input: Record<string, unknown>, cwd: string): { verb: string; target?: string } {
  const filePath = str(input.file_path) || str(input.path) || str(input.notebook_path);
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { verb: "read", target: displayPath(filePath, cwd) };
    case "Write": {
      let exists = false;
      try {
        exists = Boolean(filePath) && fs.existsSync(path.resolve(cwd, filePath));
      } catch {
        exists = false;
      }
      return { verb: exists ? "write" : "new", target: displayPath(filePath, cwd) };
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { verb: "edit", target: displayPath(filePath, cwd) };
    case "Bash":
    case "PowerShell":
      return { verb: "run", target: firstLine(str(input.command), 60) };
    case "BashOutput":
      return { verb: "check", target: str(input.bash_id) || str(input.shell_id) || undefined };
    case "KillShell":
    case "KillBash":
      return { verb: "stop", target: str(input.shell_id) || str(input.bash_id) || undefined };
    case "Grep": {
      const where = str(input.path) ? ` in ${displayPath(str(input.path), cwd)}` : str(input.glob) ? ` in ${str(input.glob)}` : "";
      return { verb: "grep", target: clip(str(input.pattern) + where, 70) };
    }
    case "Glob":
      return { verb: "glob", target: str(input.pattern) };
    case "LS":
      return { verb: "list", target: displayPath(filePath, cwd) || "." };
    case "WebFetch":
      return { verb: "fetch", target: hostPath(str(input.url)) };
    case "WebSearch":
      return { verb: "search", target: clip(str(input.query), 60) };
    case "Task":
    case "Agent":
      return { verb: "delegate", target: firstLine(str(input.description) || str(input.prompt), 60) };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos.length : 0;
      return todos ? { verb: "todo", target: plural(todos, "item") } : { verb: "todo" };
    }
    case "ExitPlanMode":
      return { verb: "plan", target: "ready" };
    case "Skill":
      return { verb: "skill", target: str(input.skill) || str(input.name) || undefined };
    case "SlashCommand":
      return { verb: "command", target: str(input.command) || undefined };
    default:
      break;
  }
  if (name.startsWith(LUMINAL_TOOL_PREFIX)) return describeLuminalTool(name.slice(LUMINAL_TOOL_PREFIX.length), input);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { verb: mcp[1], target: words(mcp[2]) };
  return { verb: name };
}

// ---- results -----------------------------------------------------------------------------------

/** Removes the CLI's notes to the model (<system-reminder>) and unwraps <tool_use_error>. */
export function cleanResultText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<\/?tool_use_error>/g, "")
    .trim();
}

/** The first line worth showing of a command's output (npm's "> script" banners skipped). */
function meaningfulLine(text: string, max = 70): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^>\s/.test(line)) continue;
    return clip(line, max);
  }
  return "";
}

/** The one-line form of a failed call. */
function errorDetail(name: string, text: string): string {
  const clean = cleanResultText(text);
  if (/denied this in lu-minal|haven't granted it yet|permission to use .* (was|has been) denied/i.test(clean)) return "denied";
  const exit = /^(?:Error: )?Exit code (\d+)\s*\n?([\s\S]*)$/.exec(clean);
  if (exit && (name === "Bash" || name === "PowerShell")) {
    const rest = meaningfulLine(exit[2], 60);
    return rest ? `exit ${exit[1]} · ${rest}` : `exit ${exit[1]}`;
  }
  return firstLine(clean) || "failed";
}

interface PatchHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

function patchHunks(value: unknown): PatchHunk[] | null {
  if (!Array.isArray(value)) return null;
  const hunks: PatchHunk[] = [];
  for (const h of value) {
    if (!isObj(h) || typeof h.oldStart !== "number" || typeof h.newStart !== "number" || !Array.isArray(h.lines)) return null;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines.filter((l): l is string => typeof l === "string") });
  }
  return hunks;
}

/**
 * Diff rows from unified-diff hunks (Claude Code's `structuredPatch`, which has the file's real line
 * numbers), with `context` unchanged lines kept around each change.
 */
export function hunksToDiff(hunks: PatchHunk[], opts: { context?: number; maxLines?: number } = {}): DiffSummary {
  const context = opts.context ?? 1;
  const maxLines = opts.maxLines ?? 400;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  const push = (l: DiffLine) => {
    if (lines.length < maxLines) lines.push(l);
  };
  for (const hunk of hunks) {
    const items: DiffLine[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      const mark = raw[0];
      const text = raw.slice(1).replace(/\r$/, "");
      if (mark === "\\") continue;
      if (mark === "+") {
        items.push({ kind: "add", line: newLine++, text });
        added++;
      } else if (mark === "-") {
        items.push({ kind: "del", line: oldLine++, text });
        removed++;
      } else {
        items.push({ kind: "ctx", line: newLine, text });
        oldLine++;
        newLine++;
      }
    }
    const changes = items.map((it, i) => (it.kind === "ctx" ? -1 : i)).filter((i) => i >= 0);
    if (!changes.length) continue;
    const keep = items.map((it, i) => it.kind !== "ctx" || changes.some((c) => Math.abs(c - i) <= context));
    if (lines.length) push({ kind: "gap", line: null, text: "…" });
    let skipped = false;
    items.forEach((it, i) => {
      if (!keep[i]) {
        skipped = true;
        return;
      }
      if (skipped && lines.length && lines[lines.length - 1].kind !== "gap") push({ kind: "gap", line: null, text: "…" });
      skipped = false;
      push(it);
    });
  }
  return { lines, added, removed };
}

function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The diff of one old_string → new_string replacement, numbered where new_string now sits in `current`. */
function replacementDiff(oldText: string, newText: string, current: string | null): DiffSummary {
  // A deletion (empty new_string) leaves nothing to find; it is numbered from 1.
  const at = current !== null ? lineOf(current, newText) : null;
  return makeDiff(oldText, newText, { lineOffset: at ? at - 1 : 0 });
}

function fromSummary(d: DiffSummary, extra = ""): ToolDisplay {
  return { diff: d.lines, added: d.added, removed: d.removed, detail: describeChange(d.added, d.removed) + extra };
}

const countLines = (text: string) => (text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0);

/** Extra facts about a call that the result text lacks. */
export interface ToolResultExtra {
  /**
   * The file's content before the call, read when the call started (Write): null when it did not
   * exist, undefined when unknown.
   */
  before?: string | null;
  /** The CLI's structured result (`tool_use_result`). */
  meta?: unknown;
}

/** How a finished Claude Code tool call shows in the panel: the result line, and a diff for edits. */
export function toolResultDisplay(
  name: string,
  input: Record<string, unknown>,
  resultText: string,
  isError: boolean,
  cwd: string,
  extra: ToolResultExtra = {},
): ToolDisplay {
  if (isError) return { detail: errorDetail(name, resultText) };
  const meta = isObj(extra.meta) ? extra.meta : null;
  const text = cleanResultText(resultText);
  const filePath = str(input.file_path) || str(input.notebook_path);
  const abs = filePath ? path.resolve(cwd, filePath) : "";

  switch (name) {
    case "Read":
    case "NotebookRead": {
      const file = meta && isObj(meta.file) ? meta.file : null;
      if (meta?.type === "image" || /^\[image\]$/.test(text)) return { detail: "image" };
      if (file && typeof file.numLines === "number") return { detail: file.numLines ? plural(file.numLines, "line") : "empty" };
      const numbered = text.split(/\r?\n/).filter((l) => /^\s*\d+(\t|→)/.test(l)).length;
      if (numbered) return { detail: plural(numbered, "line") };
      if (!text || /contents are empty/i.test(resultText)) return { detail: "empty" };
      return { detail: plural(countLines(text), "line") };
    }

    case "Edit":
    case "MultiEdit": {
      const hunks = meta ? patchHunks(meta.structuredPatch) : null;
      const all = input.replace_all === true ? " (every occurrence)" : "";
      if (hunks && hunks.length) return fromSummary(hunksToDiff(hunks), all);
      const current = abs ? readText(abs) : null;
      const edits =
        name === "MultiEdit" && Array.isArray(input.edits)
          ? input.edits.filter(isObj).map((e) => ({ old: str(e.old_string), next: str(e.new_string) }))
          : [{ old: str(input.old_string), next: str(input.new_string) }];
      const lines: DiffLine[] = [];
      let added = 0;
      let removed = 0;
      for (const e of edits) {
        const d = replacementDiff(e.old, e.next, current);
        if (!d.lines.length) continue;
        if (lines.length) lines.push({ kind: "gap", line: null, text: "…" });
        lines.push(...d.lines);
        added += d.added;
        removed += d.removed;
      }
      return fromSummary({ lines, added, removed }, all);
    }

    case "Write": {
      const content = str(input.content);
      const n = countLines(content);
      const hunks = meta ? patchHunks(meta.structuredPatch) : null;
      if (meta?.type === "update" && hunks) {
        return hunks.length ? fromSummary(hunksToDiff(hunks)) : { detail: "no changes" };
      }
      if (meta?.type === "create") return { detail: `wrote ${plural(n, "line")}`, added: n };
      if (typeof extra.before === "string" && extra.before !== content) return fromSummary(makeDiff(extra.before, content));
      if (extra.before === null) return { detail: `wrote ${plural(n, "line")}`, added: n };
      return { detail: `wrote ${plural(n, "line")}` };
    }

    case "NotebookEdit": {
      const mode = str(input.edit_mode) || "replace";
      return { detail: mode === "insert" ? "cell inserted" : mode === "delete" ? "cell deleted" : "cell replaced" };
    }

    case "Bash":
    case "PowerShell": {
      if (meta?.interrupted === true) return { detail: "interrupted" };
      const line = meaningfulLine(text);
      return { detail: line ? `✓ ${line}` : "✓ exit 0" };
    }

    case "Grep": {
      if (meta && typeof meta.numFiles === "number" && (meta.mode === "files_with_matches" || meta.mode === undefined)) {
        return { detail: meta.numFiles ? plural(meta.numFiles, "file") : "no matches" };
      }
      if (meta && typeof meta.numLines === "number" && meta.mode === "content") {
        return { detail: meta.numLines ? plural(meta.numLines, "hit") : "no matches" };
      }
      if (!text || /^No (files|matches) found/i.test(text)) return { detail: "no matches" };
      const found = /^Found (\d+) files?/i.exec(text);
      if (found) return { detail: plural(Number(found[1]), "file") };
      const rows = text.split(/\r?\n/).filter((l) => l.trim() && !/^\(Results are truncated/i.test(l.trim()));
      if (input.output_mode === "count") {
        const total = rows.reduce((sum, l) => sum + (Number(/:(\d+)\s*$/.exec(l)?.[1]) || 0), 0);
        if (total) return { detail: plural(total, "hit") };
      }
      return { detail: plural(rows.length, "hit") };
    }

    case "Glob": {
      if (meta && typeof meta.numFiles === "number") return { detail: meta.numFiles ? plural(meta.numFiles, "file") : "no files" };
      if (!text || /^No files found/i.test(text)) return { detail: "no files" };
      const files = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("("));
      return { detail: plural(files.length, "file") };
    }

    case "LS": {
      const entries = text.split(/\r?\n/).filter((l) => /^\s*- /.test(l)).length;
      return { detail: plural(Math.max(0, entries - 1), "entry", "entries") };
    }

    case "WebFetch": {
      if (meta && typeof meta.code === "number") {
        const size = typeof meta.bytes === "number" ? ` · ${formatBytes(meta.bytes)}` : "";
        return { detail: `${meta.code}${meta.codeText ? ` ${String(meta.codeText)}` : ""}${size}` };
      }
      return { detail: firstLine(text) || "fetched" };
    }

    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos.filter(isObj) : [];
      if (!todos.length) return { detail: "updated" };
      const done = todos.filter((t) => t.status === "completed").length;
      return { detail: `${done}/${todos.length} done` };
    }

    default:
      return { detail: firstLine(text) || "done" };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The content of the file a Write call is about to replace (read when the call starts, so the
 * result can show a diff): null when there is none, undefined when it can't be read.
 */
export function contentBefore(name: string, input: Record<string, unknown>, cwd: string): string | null | undefined {
  if (name !== "Write") return undefined;
  const file = str(input.file_path);
  if (!file) return undefined;
  const abs = path.resolve(cwd, file);
  try {
    if (!fs.existsSync(abs)) return null;
  } catch {
    return undefined;
  }
  return readText(abs) ?? undefined;
}
