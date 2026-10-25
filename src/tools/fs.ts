// The file tools: read_file, write_file, edit_file, list_files and grep, plus the path helpers the
// other tools share. Paths resolve against the project folder (ctx.cwd) and are shown relative to
// it; writing outside it is a riskier kind of action that always says so in its approval.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { DiffLine } from "../core/types.js";
import { expandHome, fromMsysPath } from "../platform/paths.js";
import { findProgram, spawnProgram } from "../platform/process.js";
import { describeChange, makeDiff } from "./diff.js";
import { GitIgnore, looksBinary, patternMatcher, readHead, SKIP_DIRS, toPosix, walkFiles } from "./glob.js";
import { assessRead, assessWrite, writeNote, type WriteAssessment } from "./sensitive.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

// ---- shared helpers -----------------------------------------------------------------------------

/**
 * Types a tool by its arguments and hands it on as a plain `Tool` (the arrays of tools mix argument
 * types; the runtime validates nothing beyond what each tool checks itself).
 */
export function defineTool<A extends Record<string, unknown>>(tool: Tool<A>): Tool {
  return tool as unknown as Tool;
}

/**
 * An absolute path for what the model wrote: relative to `cwd`, "~" expanded, quotes dropped. On
 * Windows a Git Bash path ("/c/Users/ada/app", what `pwd` prints in the bash tool there) is read
 * as the Windows path it names instead of a folder "c" on the current drive.
 */
export function resolvePath(cwd: string, p: string, platform: NodeJS.Platform = process.platform): string {
  let t = String(p ?? "").trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) t = t.slice(1, -1);
  const full = expandHome(fromMsysPath(t || ".", platform));
  return (platform === "win32" ? path.win32 : path.posix).resolve(cwd, full);
}

/**
 * Every file a path may name for an agent that resolves it itself (Claude Code, ACP agents), so a
 * check can keep the strictest answer: Claude Code's reading first (its expandPath trims, expands
 * "~" and "~/", reads "/c/..." as C:\... on Windows and normalizes to NFC), then resolvePath's
 * (quotes dropped too) and the path as written.
 */
export function pathReadings(cwd: string, p: string, platform: NodeJS.Platform = process.platform): string[] {
  const text = String(p ?? "");
  const api = platform === "win32" ? path.win32 : path.posix;
  const claude = api.resolve(cwd, expandHome(fromMsysPath(text.trim(), platform))).normalize("NFC");
  return [...new Set([claude, resolvePath(cwd, text, platform), api.resolve(cwd, text)])];
}

/** Whether `abs` is `cwd` or inside it. */
export function isInside(cwd: string, abs: string): boolean {
  const rel = path.relative(cwd, abs);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** How a path is shown: relative to `cwd` when inside it, absolute otherwise. */
export function displayPath(cwd: string, abs: string): string {
  if (!isInside(cwd, abs)) return abs;
  return path.relative(cwd, abs) || ".";
}

/** "1 line", "12 lines". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** The first `max` characters of a one-line text, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A diff as text for an approval's detail ("+ 12 text" / "- 13 text"). */
export function diffPreview(lines: DiffLine[], max = 40): string {
  const out = lines.slice(0, max).map((l) => {
    if (l.kind === "gap") return "  …";
    const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    return `${mark}${String(l.line ?? "").padStart(5)} ${l.text}`;
  });
  if (lines.length > max) out.push(`  … ${lines.length - max} more lines`);
  return out.join("\n");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function errorResult(content: string, detail?: string): ToolResult {
  return { content, isError: true, display: detail ? { detail } : undefined };
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Dice similarity of two strings by character pairs (0..1). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const p = a.slice(i, i + 2);
    pairs.set(p, (pairs.get(p) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const p = b.slice(i, i + 2);
    const n = pairs.get(p);
    if (n) {
      hits++;
      pairs.set(p, n - 1);
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

/** " Did you mean: src/App.tsx?" for a path that does not exist, or "". */
async function suggestSimilar(cwd: string, abs: string): Promise<string> {
  const dir = path.dirname(abs);
  const base = path.basename(abs).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, "");
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return ` (the folder ${displayPath(cwd, dir)} does not exist either)`;
  }
  const scored = names
    .map((name) => {
      const l = name.toLowerCase();
      const score = l === base ? 2 : l.replace(/\.[^.]+$/, "") === stem ? 1.5 : similarity(l, base);
      return { name, score };
    })
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!scored.length) return "";
  return ` Did you mean: ${scored.map((s) => displayPath(cwd, path.join(dir, s.name))).join(", ")}?`;
}

/** Whether a text mostly uses "\r\n" line endings. */
export function usesCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  if (!crlf) return false;
  const lf = text.split("\n").length - 1;
  return crlf >= lf - crlf;
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

const BOM = "﻿";

async function statOrNull(abs: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(abs);
  } catch {
    return null;
  }
}

function readTextSync(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// ---- read_file ----------------------------------------------------------------------------------

const READ_DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
/** Files up to this size are read whole; bigger ones are streamed up to the requested lines. */
const READ_WHOLE_BYTES = 16 * 1024 * 1024;

type ReadArgs = { path: string; offset?: number; limit?: number };

async function readLines(abs: string, size: number, start: number, limit: number): Promise<{ lines: string[]; total: number | null }> {
  if (size <= READ_WHOLE_BYTES) {
    let text = await fs.promises.readFile(abs, "utf8");
    if (text.startsWith(BOM)) text = text.slice(1);
    if (text === "") return { lines: [], total: 0 };
    const all = text.split(/\r?\n/);
    if (all[all.length - 1] === "") all.pop();
    return { lines: all.slice(start - 1, start - 1 + limit), total: all.length };
  }
  const stream = fs.createReadStream(abs, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let n = 0;
  let more = false;
  for await (const line of rl) {
    n++;
    if (n < start) continue;
    if (lines.length >= limit) {
      more = true;
      break;
    }
    lines.push(n === 1 && line.startsWith(BOM) ? line.slice(1) : line);
  }
  rl.close();
  stream.destroy();
  return { lines, total: more ? null : n };
}

export const readFileTool = defineTool<ReadArgs>({
  name: "read_file",
  description:
    "Reads a text file and returns it with line numbers (\"  12\\tcode\"). Reads up to 2000 lines; for " +
    "longer files pass `offset` (the 1-based line to start at) and `limit`. Lines longer than 2000 " +
    "characters are cut. Paths are relative to the project folder. Use list_files for folders.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file to read, relative to the project folder (or absolute)." },
      offset: { type: "integer", description: "The 1-based line number to start reading at (default 1)." },
      limit: { type: "integer", description: "How many lines to read (default and maximum 2000)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  // Reading is free, except in a secret store (~/.ssh, lu-minal's auth.json) or a network share.
  risk: (args, ctx) => assessRead(resolvePath(ctx.cwd, args.path), { cwd: ctx.cwd }),
  describe: (args, ctx) => ({ verb: "read", target: displayPath(ctx.cwd, resolvePath(ctx.cwd, args.path)) }),
  approval(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    return { risk: "other", summary: `read ${displayPath(ctx.cwd, abs)} (a credentials store or network share)`, allowKey: `read_file:${abs}` };
  },
  async run(args, ctx) {
    const p = str(args.path);
    if (!p?.trim()) return errorResult("read_file needs a `path`.");
    const abs = resolvePath(ctx.cwd, p);
    const shown = displayPath(ctx.cwd, abs);
    const st = await statOrNull(abs);
    if (!st) return errorResult(`File not found: ${shown}.${await suggestSimilar(ctx.cwd, abs)}`, "not found");
    if (st.isDirectory()) {
      return errorResult(`${shown} is a folder, not a file. Use list_files to see what is in it.`, "is a folder");
    }
    if (st.size > 0 && looksBinary(await readHead(abs))) {
      return errorResult(
        `${shown} is a binary file (${st.size} bytes); read_file only reads text.`,
        "binary file",
      );
    }
    const start = int(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = int(args.limit, READ_DEFAULT_LIMIT, 1, READ_DEFAULT_LIMIT);
    const { lines, total } = await readLines(abs, st.size, start, limit);
    if (total === 0) return { content: `(${shown} is empty)`, display: { detail: "empty file" } };
    if (!lines.length) {
      return errorResult(`${shown} has ${plural(total ?? 0, "line")}; offset ${start} is past the end.`, "past the end");
    }
    const end = start + lines.length - 1;
    const width = Math.max(4, String(end).length);
    let cut = false;
    const body = lines
      .map((line, i) => {
        let text = line;
        if (text.length > MAX_LINE_CHARS) {
          text = `${text.slice(0, MAX_LINE_CHARS)}… [line cut]`;
          cut = true;
        }
        return `${String(start + i).padStart(width)}\t${text}`;
      })
      .join("\n");
    const notes: string[] = [];
    if (total === null) {
      notes.push(`[Lines ${start}-${end}; the file goes on. Call read_file with offset ${end + 1} to read more.]`);
    } else if (end < total || start > 1) {
      const next = end < total ? ` Call read_file with offset ${end + 1} to read more.` : "";
      notes.push(`[Lines ${start}-${end} of ${total}.${next}]`);
    }
    if (cut) notes.push(`[Some lines were longer than ${MAX_LINE_CHARS} characters and were cut.]`);
    return {
      content: notes.length ? `${body}\n\n${notes.join("\n")}` : body,
      display: { detail: plural(lines.length, "line") },
    };
  },
});

// ---- write_file ---------------------------------------------------------------------------------

type WriteArgs = { path: string; content: string };

/** The text to write: keeps an existing file's CRLF line endings and its BOM. */
function adaptToExisting(oldText: string | null, content: string): string {
  if (oldText === null) return content;
  let next = content;
  if (usesCrlf(oldText) && !next.includes("\r\n")) next = toCrlf(next);
  if (oldText.startsWith(BOM) && !next.startsWith(BOM)) next = BOM + next;
  return next;
}

/**
 * What writing `abs` risks: "edit" for an ordinary file in the project, "other" (always asks) for a
 * file outside it once symlinks are followed, in a secret store, a home dotfile, or what git and
 * agents run on their own (.git, .claude, .mcp.json, ...).
 */
function writeAssessment(ctx: ToolContext, abs: string): WriteAssessment {
  return assessWrite(ctx.cwd, abs);
}

export const writeFileTool = defineTool<WriteArgs>({
  name: "write_file",
  description:
    "Creates a file or replaces its whole content (parent folders are created). Prefer edit_file for " +
    "changes to an existing file; read a file before overwriting it. Keeps the file's CRLF line " +
    "endings. Writing outside the project folder needs the user's OK.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file to write, relative to the project folder." },
      content: { type: "string", description: "The complete new content of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  risk: (args, ctx) => writeAssessment(ctx, resolvePath(ctx.cwd, args.path)).risk,
  describe(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    return { verb: fs.existsSync(abs) ? "write" : "new", target: displayPath(ctx.cwd, abs) };
  },
  approval(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    const assessed = writeAssessment(ctx, abs);
    const inside = assessed.risk === "edit";
    const old = readTextSync(abs);
    const content = typeof args.content === "string" ? args.content : "";
    const diff = makeDiff(old ?? "", adaptToExisting(old, content), { context: 1, maxLines: 60 });
    return {
      risk: assessed.risk,
      summary: `${old === null ? "create" : "overwrite"} ${displayPath(ctx.cwd, abs)}${writeNote(assessed)}`,
      detail: diffPreview(diff.lines),
      allowKey: inside ? "write_file" : `write_file:${abs}`,
    };
  },
  async run(args, ctx) {
    const p = str(args.path);
    if (!p?.trim()) return errorResult("write_file needs a `path`.");
    if (typeof args.content !== "string") return errorResult("write_file needs the file's `content` as a string.");
    const abs = resolvePath(ctx.cwd, p);
    const shown = displayPath(ctx.cwd, abs);
    const st = await statOrNull(abs);
    if (st?.isDirectory()) return errorResult(`${shown} is a folder; give a file path.`, "is a folder");
    let old: string | null = null;
    let oldBinary = false;
    if (st) {
      oldBinary = st.size > 0 && looksBinary(await readHead(abs));
      if (!oldBinary) old = await fs.promises.readFile(abs, "utf8");
    }
    const next = adaptToExisting(old, args.content);
    if (ctx.signal.aborted) return errorResult("Interrupted.");
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, next, "utf8");
    const created = !st;
    const diff = makeDiff(old ?? "", next, { context: 1, maxLines: created ? 200 : 400 });
    const change = created && !next ? "empty file" : describeChange(diff.added, diff.removed);
    const lineCount = next ? next.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
    return {
      content: created
        ? `Created ${shown} (${plural(lineCount, "line")}).`
        : oldBinary
          ? `Replaced the binary file ${shown} with ${plural(lineCount, "line")} of text.`
          : `Wrote ${shown}: ${change}.`,
      display: {
        verb: created ? "new" : "write",
        target: shown,
        detail: change,
        diff: diff.lines,
        added: diff.added,
        removed: diff.removed,
      },
    };
  },
});

// ---- edit_file ----------------------------------------------------------------------------------

type EditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean };

type EditPlan = { ok: true; next: string; count: number } | { ok: false; error: string; detail: string };

function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    at.push(i);
    i = text.indexOf(needle, i + needle.length);
  }
  return at;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The file line most like the first line of `needle`, for "not found" errors. */
function closestLine(text: string, needle: string): { line: number; text: string } | null {
  const want = needle.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!want) return null;
  let best: { line: number; text: string; score: number } | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const score = t === want ? 1 : similarity(t, want);
    if (!best || score > best.score) best = { line: i + 1, text: lines[i], score };
  }
  return best && best.score >= 0.3 ? { line: best.line, text: best.text } : null;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Works out an edit without touching the disk. */
function planEdit(text: string, args: EditArgs, shown: string): EditPlan {
  let oldS = args.old_string;
  let newS = args.new_string;
  if (usesCrlf(text)) {
    oldS = toCrlf(oldS);
    newS = toCrlf(newS);
  } else if (!text.includes("\r")) {
    oldS = oldS.replace(/\r\n/g, "\n");
    newS = newS.replace(/\r\n/g, "\n");
  }
  const at = occurrences(text, oldS);
  if (!at.length) {
    const near = closestLine(text, oldS);
    let hint = "";
    if (squash(text).includes(squash(oldS))) {
      hint = " It matches when whitespace is ignored: check the indentation (tabs or spaces) and line breaks.";
    }
    const closest = near ? ` The closest line is ${near.line}: ${JSON.stringify(clip(near.text, 160))}.` : "";
    return {
      ok: false,
      error:
        `old_string was not found in ${shown}.${hint}${closest} Read the file again and copy the text ` +
        "exactly, including indentation.",
      detail: "old_string not found",
    };
  }
  if (at.length > 1 && !args.replace_all) {
    const lines = at.slice(0, 10).map((i) => lineAt(text, i));
    return {
      ok: false,
      error:
        `old_string appears ${at.length} times in ${shown} (lines ${lines.join(", ")}${at.length > 10 ? ", …" : ""}). ` +
        "Add surrounding lines to make it unique, or set replace_all to change every one.",
      detail: `${at.length} matches`,
    };
  }
  const next = args.replace_all
    ? text.split(oldS).join(newS)
    : text.slice(0, at[0]) + newS + text.slice(at[0] + oldS.length);
  return { ok: true, next, count: args.replace_all ? at.length : 1 };
}

function checkEditArgs(args: EditArgs): string | null {
  if (!str(args.path)?.trim()) return "edit_file needs a `path`.";
  if (typeof args.old_string !== "string") return "edit_file needs `old_string` (the exact text to replace).";
  if (typeof args.new_string !== "string") return "edit_file needs `new_string` (the replacement text).";
  if (args.old_string === args.new_string) return "old_string and new_string are the same; nothing to change.";
  return null;
}

export const editFileTool = defineTool<EditArgs>({
  name: "edit_file",
  description:
    "Replaces exact text in a file: `old_string` must match the file exactly (indentation included) " +
    "and be unique, unless `replace_all` is set. Include a few lines of context to make it unique. " +
    "Read the file first. Keeps CRLF line endings. An empty old_string creates a new file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file to edit, relative to the project folder." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The text to put in its place." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  risk: (args, ctx) => writeAssessment(ctx, resolvePath(ctx.cwd, args.path)).risk,
  describe: (args, ctx) => ({ verb: "edit", target: displayPath(ctx.cwd, resolvePath(ctx.cwd, args.path)) }),
  approval(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    const assessed = writeAssessment(ctx, abs);
    const inside = assessed.risk === "edit";
    const shown = displayPath(ctx.cwd, abs);
    let detail: string | undefined;
    const text = readTextSync(abs);
    if (text !== null && !checkEditArgs(args) && args.old_string) {
      const plan = planEdit(text, args, shown);
      if (plan.ok) detail = diffPreview(makeDiff(text, plan.next, { context: 1, maxLines: 60 }).lines);
    }
    return {
      risk: assessed.risk,
      summary: `edit ${shown}${writeNote(assessed)}`,
      detail,
      allowKey: inside ? "edit_file" : `edit_file:${abs}`,
    };
  },
  async run(args, ctx) {
    const bad = checkEditArgs(args);
    if (bad) return errorResult(bad);
    const abs = resolvePath(ctx.cwd, args.path);
    const shown = displayPath(ctx.cwd, abs);
    const st = await statOrNull(abs);
    if (!st) {
      if (args.old_string === "") {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, args.new_string, "utf8");
        const diff = makeDiff("", args.new_string, { context: 1, maxLines: 200 });
        return {
          content: `Created ${shown}.`,
          display: { verb: "new", target: shown, detail: describeChange(diff.added, 0), diff: diff.lines, added: diff.added, removed: 0 },
        };
      }
      return errorResult(
        `File not found: ${shown}.${await suggestSimilar(ctx.cwd, abs)} Use write_file to create a new file.`,
        "not found",
      );
    }
    if (st.isDirectory()) return errorResult(`${shown} is a folder, not a file.`, "is a folder");
    if (st.size > 0 && looksBinary(await readHead(abs))) return errorResult(`${shown} is a binary file.`, "binary file");
    const text = await fs.promises.readFile(abs, "utf8");
    if (args.old_string === "") {
      if (text.trim()) {
        return errorResult(
          `${shown} already has content; old_string must name the text to replace (or use write_file to overwrite it).`,
          "empty old_string",
        );
      }
    }
    const plan: EditPlan = args.old_string === "" ? { ok: true, next: args.new_string, count: 1 } : planEdit(text, args, shown);
    if (!plan.ok) return errorResult(plan.error, plan.detail);
    if (ctx.signal.aborted) return errorResult("Interrupted.");
    await fs.promises.writeFile(abs, plan.next, "utf8");
    const diff = makeDiff(text, plan.next, { context: 1 });
    const change = describeChange(diff.added, diff.removed);
    // The edited region as it reads now, so the model can check it without another read.
    const snippet = diff.lines
      .filter((l) => l.kind === "add" || l.kind === "ctx")
      .slice(0, 30)
      .map((l) => `${String(l.line ?? "").padStart(4)}\t${l.text}`)
      .join("\n");
    const times = plan.count > 1 ? ` (${plan.count} replacements)` : "";
    return {
      content: `Edited ${shown}: ${change}${times}.${snippet ? `\n${snippet}` : ""}`,
      display: {
        verb: "edit",
        target: shown,
        detail: change,
        diff: diff.lines,
        added: diff.added,
        removed: diff.removed,
      },
    };
  },
});

// ---- list_files ---------------------------------------------------------------------------------

type ListArgs = { path?: string; pattern?: string; limit?: number };

const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";

/** The ignore rules for a walk from `root`: the project's .gitignore, or root's own outside it. */
async function ignoreFor(ctx: ToolContext, root: string): Promise<{ ignore: GitIgnore; ignoreRoot: string }> {
  const ignoreRoot = isInside(ctx.cwd, root) ? ctx.cwd : root;
  return { ignore: await GitIgnore.load(ignoreRoot, { nocase: caseInsensitiveFs }), ignoreRoot };
}

export const listFilesTool = defineTool<ListArgs>({
  name: "list_files",
  description:
    "Lists files under a folder (default: the project), newest first. `pattern` is a glob: " +
    "\"src/**/*.ts\", \"*.{js,ts}\", \"test/?.json\"; a pattern without a \"/\" matches file names at any " +
    "depth. Skips .git, node_modules, dist, build and what .gitignore excludes. Up to 500 files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The folder to list, relative to the project folder (default \".\")." },
      pattern: { type: "string", description: "A glob the paths (relative to `path`) must match." },
      limit: { type: "integer", description: "At most this many files (default 500)." },
    },
    additionalProperties: false,
  },
  // Names only: free, except inside a secret store or on a network share.
  risk: (args, ctx) => assessRead(resolvePath(ctx.cwd, typeof args.path === "string" ? args.path : "."), { cwd: ctx.cwd }),
  approval(args, ctx) {
    const abs = resolvePath(ctx.cwd, typeof args.path === "string" ? args.path : ".");
    return { risk: "other", summary: `list ${displayPath(ctx.cwd, abs)} (a credentials store or network share)`, allowKey: `list_files:${abs}` };
  },
  describe(args, ctx) {
    const where = args.path ? displayPath(ctx.cwd, resolvePath(ctx.cwd, args.path)) : "";
    const target = [where && where !== "." ? where : "", args.pattern ?? ""].filter(Boolean).join(" ");
    return { verb: "list", target: target || "." };
  },
  async run(args, ctx) {
    const root = resolvePath(ctx.cwd, str(args.path) ?? ".");
    const shown = displayPath(ctx.cwd, root);
    const st = await statOrNull(root);
    if (!st) return errorResult(`No such folder: ${shown}.${await suggestSimilar(ctx.cwd, root)}`, "not found");
    if (!st.isDirectory()) return { content: shown, display: { detail: "1 file" } };
    const limit = int(args.limit, 500, 1, 5000);
    const match = patternMatcher(str(args.pattern) ?? "", { nocase: caseInsensitiveFs });
    const { ignore, ignoreRoot } = await ignoreFor(ctx, root);
    const { files, truncated } = await walkFiles(root, { ignore, ignoreRoot, signal: ctx.signal });
    if (ctx.signal.aborted) return errorResult("Interrupted.");
    const hits = files.filter((f) => match(f.rel));
    hits.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
    if (!hits.length) {
      return { content: args.pattern ? `No files match ${args.pattern} in ${shown}.` : `${shown} has no files.`, display: { detail: "0 files" } };
    }
    const shownHits = hits.slice(0, limit).map((f) => displayPath(ctx.cwd, f.abs));
    const notes: string[] = [];
    if (hits.length > limit) notes.push(`[Showing the ${limit} newest of ${hits.length} files; narrow the pattern or the path.]`);
    if (truncated) notes.push("[The folder is very large; the listing stopped early.]");
    return {
      content: shownHits.join("\n") + (notes.length ? `\n\n${notes.join("\n")}` : ""),
      display: { detail: plural(hits.length, "file") },
    };
  },
});

// ---- grep ---------------------------------------------------------------------------------------

type GrepArgs = { pattern: string; path?: string; glob?: string; ignore_case?: boolean; max_results?: number };

interface GrepHit {
  file: string;
  line: number;
  text: string;
}

const GREP_MAX_FILE = 2 * 1024 * 1024;
const GREP_LINE_CHARS = 300;

let rgCache: string | null | undefined;

/** The ripgrep program, looked up once. */
function defaultRg(): string | null {
  if (rgCache === undefined) rgCache = findProgram("rg");
  return rgCache;
}

/** Runs ripgrep; resolves null when it could not run at all (then the JS search takes over). */
function grepWithRg(
  rg: string,
  opts: { cwd: string; root: string; pattern: string; glob?: string; ignoreCase: boolean; max: number; signal: AbortSignal },
): Promise<{ hits: GrepHit[]; more: boolean; error: string | null } | null> {
  const args = ["--json", "--hidden", "--max-filesize", "2M", opts.ignoreCase ? "-i" : "-s"];
  // Globs match names without regard to case where the file system does, as the built-in search does.
  if (caseInsensitiveFs) args.push("--glob-case-insensitive");
  // ripgrep reads .gitignore files only inside git repositories; name the project's own explicitly
  // (its rules are relative to rg's working folder, which is where it lives).
  const ignoreFile = path.join(opts.cwd, ".gitignore");
  if (fs.existsSync(ignoreFile)) args.push("--ignore-file", ignoreFile);
  const rootRel = toPosix(path.relative(opts.cwd, opts.root));
  const insideSkipped = rootRel.split("/").some((seg) => SKIP_DIRS.has(seg));
  if (!insideSkipped) for (const dir of SKIP_DIRS) args.push("--glob", `!${dir}`);
  if (opts.glob) args.push("--glob", opts.glob);
  args.push("-e", opts.pattern, "--", opts.root);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProgram>;
    try {
      child = spawnProgram(rg, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const hits: GrepHit[] = [];
    let more = false;
    let stderr = "";
    let buffer = "";
    let done = false;
    const stop = () => {
      if (!done) child.kill();
    };
    opts.signal.addEventListener("abort", stop, { once: true });
    const onLine = (line: string) => {
      if (!line.startsWith('{"type":"match"')) return;
      if (hits.length >= opts.max) {
        more = true;
        stop();
        return;
      }
      try {
        const ev = JSON.parse(line) as {
          data: { path: { text?: string; bytes?: string }; lines: { text?: string; bytes?: string }; line_number: number };
        };
        const file = ev.data.path.text ?? Buffer.from(ev.data.path.bytes ?? "", "base64").toString("utf8");
        const text = ev.data.lines.text ?? Buffer.from(ev.data.lines.bytes ?? "", "base64").toString("utf8");
        hits.push({ file: path.resolve(opts.cwd, file), line: ev.data.line_number, text: text.replace(/\r?\n$/, "") });
      } catch {
        // A line we can't read; skip it.
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < 4000) stderr += d;
    });
    child.on("error", () => {
      done = true;
      opts.signal.removeEventListener("abort", stop);
      resolve(null);
    });
    child.on("close", (code) => {
      done = true;
      opts.signal.removeEventListener("abort", stop);
      if (buffer) onLine(buffer);
      const error = code === 2 && !hits.length ? stderr.trim() || "ripgrep failed" : null;
      resolve({ hits, more, error });
    });
  });
}

/** The search without ripgrep: walks the folder and tests each line with a JS RegExp. */
async function grepWithJs(
  ctx: ToolContext,
  opts: { root: string; isFile: boolean; pattern: string; glob?: string; ignoreCase: boolean; max: number },
): Promise<{ hits: GrepHit[]; more: boolean; error: string | null }> {
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
  } catch (err) {
    return { hits: [], more: false, error: `Invalid regular expression: ${(err as Error).message}` };
  }
  let files: Array<{ abs: string; rel: string; size: number }>;
  if (opts.isFile) {
    const st = await fs.promises.stat(opts.root);
    files = [{ abs: opts.root, rel: path.basename(opts.root), size: st.size }];
  } else {
    const { ignore, ignoreRoot } = await ignoreFor(ctx, opts.root);
    // Like ripgrep, links found on the way are not followed (the risk check can't see where they go).
    files = (await walkFiles(opts.root, { ignore, ignoreRoot, signal: ctx.signal, links: false })).files;
    if (opts.glob) {
      const match = patternMatcher(opts.glob, { nocase: caseInsensitiveFs });
      files = files.filter((f) => match(f.rel));
    }
  }
  const hits: GrepHit[] = [];
  for (const f of files) {
    if (ctx.signal.aborted) break;
    if (f.size > GREP_MAX_FILE || f.size === 0) continue;
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(f.abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (hits.length >= opts.max) return { hits, more: true, error: null };
      hits.push({ file: f.abs, line: i + 1, text: lines[i] });
    }
  }
  return { hits, more: false, error: null };
}

/**
 * The grep tool. `rg` picks the ripgrep program: a path, null to always use the built-in search,
 * or undefined (the default) to look for `rg` on the PATH once.
 */
export function createGrepTool(opts: { rg?: string | null } = {}): Tool {
  return defineTool<GrepArgs>({
    name: "grep",
    description:
      "Searches file contents for a regular expression and returns \"path:line: text\" lines. `path` is " +
      "a folder or file (default: the project); `glob` filters files (\"*.ts\", \"src/**/*.tsx\"). Skips " +
      "binary files, files over 2 MB, node_modules, .git and what .gitignore excludes. Up to 200 results.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression to search for." },
        path: { type: "string", description: "A folder or file to search in (default: the project folder)." },
        glob: { type: "string", description: "Only search files matching this glob." },
        ignore_case: { type: "boolean", description: "Match without regard to case." },
        max_results: { type: "integer", description: "At most this many matching lines (default 200)." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    // Contents below a folder: a search from ~ would read ~/.ssh and auth.json, so that asks.
    risk: (args, ctx) => assessRead(resolvePath(ctx.cwd, typeof args.path === "string" ? args.path : "."), { recursive: true, cwd: ctx.cwd }),
    approval(args, ctx) {
      const abs = resolvePath(ctx.cwd, typeof args.path === "string" ? args.path : ".");
      return { risk: "other", summary: `grep ${String(args.pattern ?? "")} in ${displayPath(ctx.cwd, abs)} (it reaches a credentials store)`, allowKey: `grep:${abs}` };
    },
    describe(args, ctx) {
      const where = args.path ? ` in ${displayPath(ctx.cwd, resolvePath(ctx.cwd, args.path))}` : "";
      return { verb: "grep", target: `${args.pattern ?? ""}${where}` };
    },
    async run(args, ctx) {
      const pattern = str(args.pattern);
      if (!pattern) return errorResult("grep needs a `pattern`.");
      const root = resolvePath(ctx.cwd, str(args.path) ?? ".");
      const st = await statOrNull(root);
      if (!st) return errorResult(`No such file or folder: ${displayPath(ctx.cwd, root)}.`, "not found");
      const max = int(args.max_results, 200, 1, 2000);
      const ignoreCase = Boolean(args.ignore_case);
      const glob = str(args.glob)?.trim() || undefined;
      const rg = opts.rg === undefined ? defaultRg() : opts.rg;
      // rg runs where the ignore rules live: the project, or the searched folder when it is outside.
      const rgCwd = isInside(ctx.cwd, root) ? ctx.cwd : st.isFile() ? path.dirname(root) : root;
      let result = rg ? await grepWithRg(rg, { cwd: rgCwd, root, pattern, glob, ignoreCase, max, signal: ctx.signal }) : null;
      if (!result) result = await grepWithJs(ctx, { root, isFile: st.isFile(), pattern, glob, ignoreCase, max });
      if (ctx.signal.aborted) return errorResult("Interrupted.");
      if (result.error) return errorResult(result.error, clip(result.error, 60));
      const hits = result.hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
      if (!hits.length) return { content: "No matches.", display: { detail: "0 hits" } };
      const lines = hits.map((h) => {
        const text = h.text.length > GREP_LINE_CHARS ? `${h.text.slice(0, GREP_LINE_CHARS)}…` : h.text;
        return `${displayPath(ctx.cwd, h.file)}:${h.line}: ${text.trimEnd()}`;
      });
      const note = result.more ? `\n\n[Stopped at ${max} results; narrow the pattern, the path or the glob.]` : "";
      return { content: lines.join("\n") + note, display: { detail: plural(hits.length, "hit") } };
    },
  });
}

/** The grep tool with ripgrep when it is installed. */
export const grepTool = createGrepTool();

/** The file tools in the order the model sees them. */
export function fileTools(opts: { rg?: string | null } = {}): Tool[] {
  return [readFileTool, writeFileTool, editFileTool, listFilesTool, opts.rg === undefined ? grepTool : createGrepTool(opts)];
}
