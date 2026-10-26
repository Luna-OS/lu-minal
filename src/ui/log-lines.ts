// Turns an agent's log into the rows its panel draws, like the reference look:
//   ▸ read PLAN.md
//     └ 94 lines
//    54 + moon = 'full'        (a green row)
//   ✦ Charting… (23m 9s · ↓ 72.6k)
// Tool output and code (diffs, multi-line results, fenced blocks) collapse to their first lines
// with "… 120 more lines (ctrl+f to expand)"; the agent's own prose never does.
// Pure (no React), so it is tested on its own.
import type { DiffLine, LogEntry } from "../core/types.js";
import type { Theme } from "../themes/types.js";
import { truncate, width, wrap } from "./text.js";

export interface Seg {
  text: string;
  color?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export interface Row {
  key: string;
  segs: Seg[];
  /** Fill the whole row with this background (diff rows, the approval bar). */
  fill?: string;
}

export interface LogRenderOptions {
  width: number;
  theme: Theme;
  /** The colour of a teammate's name. */
  colorOf: (name: string) => string;
  /** Diff rows per tool call (more when zoomed). */
  maxDiffLines: number;
  /**
   * Compact mode (non-zero): teammates' messages and notes keep their last lines. The agent's own
   * answers are never cut.
   */
  maxTextLines: number;
  /** Show reasoning in full (zoomed) or as one faint line. */
  fullReasoning: boolean;
  /** Lines a tool's multi-line result or a fenced code block keeps (0 or unset = all). */
  maxCodeLines?: number;
  /** How to see what was collapsed, added to the "… N more lines" rows ("ctrl+f to expand"). */
  expandHint?: string;
  /**
   * The entry the panel's question card shows in full: a pending approval keeps only its first
   * row here, a question (the last answer) is left out.
   */
  pinned?: string;
}

/** "… 120 more lines (ctrl+f to expand)" */
export function moreLines(n: number, hint?: string): string {
  return `… ${n} more line${n === 1 ? "" : "s"}${hint ? ` (${hint})` : ""}`;
}

/**
 * The first `max` items, or all of them when `max` is 0 or only one would be hidden (a "1 more
 * line" row saves nothing).
 */
export function collapse<T>(items: T[], max: number): { shown: T[]; hidden: number } {
  if (max <= 0 || items.length <= max + 1) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, max), hidden: items.length - max };
}

/** How prose treats fenced code blocks. */
export interface ProseCode {
  /** Lines a fenced block keeps (0 = all). */
  maxLines?: number;
  /** Wrap long code lines instead of cutting them (the question card). */
  wrap?: boolean;
  /** Added to the "… N more lines" row. */
  hint?: string;
}

/** Inline markdown-lite: `code` and **bold**. */
function inline(text: string, base: Seg, theme: Theme): Seg[] {
  const out: Seg[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ ...base, text: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith("`")) out.push({ ...base, text: token.slice(1, -1), color: theme.colors.accent2 });
    else out.push({ ...base, text: token.slice(2, -2), bold: true });
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out;
}

/**
 * Rows for a block of prose with a first-line prefix and an indent for the rest. `maxLines` keeps
 * the last lines of the block; `code` collapses (or wraps) its fenced code blocks.
 */
export function prose(
  key: string,
  text: string,
  w: number,
  prefix: Seg[],
  base: Seg,
  theme: Theme,
  maxLines = 0,
  code: ProseCode = {},
): Row[] {
  const prefixW = prefix.reduce((n, s) => n + width(s.text), 0);
  const room = Math.max(4, w - prefixW);
  const rows: Row[] = [];
  let inFence = false;
  const lines: Array<{ text: string; code: boolean; more?: number }> = [];
  // Where the open code block's lines start in `lines`.
  let blockAt = -1;
  const closeBlock = () => {
    if (blockAt < 0) return;
    const { hidden } = collapse(lines.slice(blockAt), code.maxLines ?? 0);
    if (hidden) lines.splice(lines.length - hidden, hidden, { text: "", code: false, more: hidden });
    blockAt = -1;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      if (inFence) closeBlock();
      else blockAt = lines.length;
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const line = raw.replace(/\t/g, "  ");
      if (code.wrap) for (const l of wrap(line, room)) lines.push({ text: l, code: true });
      else lines.push({ text: truncate(line, room), code: true });
      continue;
    }
    for (const l of wrap(raw.replace(/^(\s*)[-*] /, "$1• "), room)) lines.push({ text: l, code: false });
  }
  // A block still open (the answer is streaming) collapses too.
  closeBlock();
  while (lines.length && !lines[lines.length - 1].more && !lines[lines.length - 1].text.trim()) lines.pop();
  let shown = lines;
  let hidden = 0;
  if (maxLines > 0 && lines.length > maxLines) {
    hidden = lines.length - maxLines;
    shown = lines.slice(-maxLines);
  }
  if (hidden) {
    rows.push({ key: `${key}:more`, segs: [...prefix, { text: `… ${hidden} more lines`, color: theme.colors.faint }] });
  }
  shown.forEach((line, i) => {
    const lead: Seg[] = i === 0 && !hidden ? prefix : [{ text: " ".repeat(prefixW) }];
    const heading = /^#{1,4}\s+/.exec(line.text);
    let segs: Seg[];
    if (line.more) segs = [{ text: moreLines(line.more, code.hint), color: theme.colors.faint }];
    else if (line.code) segs = [{ ...base, text: line.text, color: theme.colors.accent2 }];
    else if (heading) segs = [{ ...base, text: line.text.slice(heading[0].length), bold: true, color: theme.colors.accent }];
    else segs = inline(line.text, base, theme);
    rows.push({ key: `${key}:${i}`, segs: [...lead, ...segs] });
  });
  return rows;
}

function diffRows(key: string, diff: DiffLine[], w: number, theme: Theme, max: number, hint?: string): Row[] {
  const c = theme.colors;
  const rows: Row[] = [];
  const numW = Math.max(2, ...diff.map((d) => String(d.line ?? "").length));
  const visible = diff.filter((d) => d.kind !== "ctx" || diff.length <= max);
  const { shown, hidden } = collapse(visible, max);
  shown.forEach((d, i) => {
    if (d.kind === "gap") {
      rows.push({ key: `${key}:d${i}`, segs: [{ text: `${" ".repeat(numW + 1)}⋯`, color: c.faint }] });
      return;
    }
    const num = String(d.line ?? "").padStart(numW);
    const mark = d.kind === "add" ? "+" : d.kind === "del" ? "-" : " ";
    const body = truncate(`${num} ${mark} ${d.text.replace(/\t/g, "  ")}`, w);
    if (d.kind === "ctx") {
      rows.push({ key: `${key}:d${i}`, segs: [{ text: body, color: c.faint }] });
    } else {
      const bg = d.kind === "add" ? c.diffAddBg : c.diffDelBg;
      const fg = d.kind === "add" ? c.diffAddFg : c.diffDelFg;
      rows.push({ key: `${key}:d${i}`, segs: [{ text: body, color: fg, bg }], fill: bg });
    }
  });
  if (hidden) {
    rows.push({
      key: `${key}:dmore`,
      segs: [{ text: truncate(`${" ".repeat(numW + 1)}${moreLines(hidden, hint)}`, w), color: c.faint }],
    });
  }
  return rows;
}

/** The rows for one log entry. */
export function entryRows(entry: LogEntry, opts: LogRenderOptions): Row[] {
  const { theme, width: w } = opts;
  const c = theme.colors;
  const key = entry.id;
  switch (entry.kind) {
    case "user": {
      const mine = entry.from === "you";
      const prefix: Seg[] = mine
        ? [{ text: "› ", color: c.accent, bold: true }]
        : [
            { text: "◂ ", color: opts.colorOf(entry.from) },
            { text: `${entry.from} `, color: opts.colorOf(entry.from), bold: true },
          ];
      const rows = prose(key, entry.text, w, prefix, { text: "", color: mine ? c.text : c.muted }, theme, opts.maxTextLines ? 4 : 0);
      if (entry.attachments?.length) {
        rows.push({
          key: `${key}:att`,
          segs: [
            { text: "  ▣ ", color: c.accent2 },
            { text: truncate(entry.attachments.join(" · "), Math.max(4, w - 4)), color: c.muted },
          ],
        });
      }
      return rows;
    }
    case "text":
      // The agent's own answer is never cut; the question card shows the one it asks with.
      if (opts.pinned === key) return [];
      return prose(key, entry.text, w, [], { text: "", color: c.text }, theme, 0, { maxLines: opts.maxCodeLines, hint: opts.expandHint });
    case "reasoning": {
      if (opts.fullReasoning) {
        return prose(key, entry.text, w, [{ text: "∴ ", color: c.faint }], { text: "", color: c.faint, italic: true }, theme, 12);
      }
      const last = entry.text.trim().split(/\n/).filter(Boolean).pop() ?? "";
      return [
        {
          key,
          segs: [
            { text: "∴ ", color: c.faint },
            { text: truncate(last || "thinking", Math.max(4, w - 2)), color: c.faint, italic: true },
          ],
        },
      ];
    }
    case "tool": {
      const markColor = entry.status === "error" ? c.error : entry.status === "running" ? c.accent2 : c.accent;
      const mark = entry.status === "error" ? "✗ " : "▸ ";
      const verbW = width(entry.verb) + 3;
      const target = entry.target ? truncate(entry.target, Math.max(4, w - verbW - (entry.status === "running" ? 2 : 0))) : "";
      const rows: Row[] = [
        {
          key,
          segs: [
            { text: mark, color: markColor },
            { text: entry.verb, color: c.text, bold: true },
            ...(target ? [{ text: ` ${target}`, color: c.muted } as Seg] : []),
            ...(entry.status === "running" ? [{ text: " …", color: c.faint } as Seg] : []),
          ],
        },
      ];
      if (entry.diff?.length) rows.push(...diffRows(key, entry.diff, w, theme, opts.maxDiffLines, opts.expandHint));
      if (entry.detail) {
        // A result of several lines: its first lines, the rest collapsed.
        const lines = entry.detail.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
        const { shown, hidden } = collapse(lines, opts.maxCodeLines ?? 0);
        const color = entry.status === "error" ? c.error : c.muted;
        shown.forEach((line, i) =>
          rows.push({
            key: i ? `${key}:detail${i}` : `${key}:detail`,
            segs: [
              { text: i ? "    " : "  └ ", color: c.faint },
              { text: truncate(line.replace(/\t/g, "  "), Math.max(4, w - 4)), color },
            ],
          }),
        );
        if (hidden) {
          rows.push({ key: `${key}:rmore`, segs: [{ text: truncate(`    ${moreLines(hidden, opts.expandHint)}`, w), color: c.faint }] });
        }
      }
      return rows;
    }
    case "message":
      return prose(
        key,
        entry.text,
        w,
        [
          { text: "◆ ", color: c.accent2 },
          { text: `→ ${entry.to} `, color: entry.to === "*" ? c.accent2 : opts.colorOf(entry.to), bold: true },
        ],
        { text: "", color: c.muted },
        theme,
        opts.maxTextLines ? 3 : 0,
        { maxLines: opts.maxCodeLines, hint: opts.expandHint },
      );
    case "info":
      return prose(key, entry.text, w, [{ text: "· ", color: c.faint }], { text: "", color: c.faint }, theme, 3);
    case "error":
      return prose(key, entry.text, w, [{ text: "✗ ", color: c.error }], { text: "", color: c.error }, theme, 6);
    case "approval": {
      const r = entry.request;
      if (entry.decision) {
        const verdict = entry.decision === "deny" ? "denied" : entry.decision === "always" ? "always allowed" : "allowed";
        return [
          {
            key,
            segs: [
              { text: "▲ ", color: entry.decision === "deny" ? c.error : c.faint },
              { text: truncate(r.summary, Math.max(4, w - verdict.length - 6)), color: c.muted },
              { text: ` · ${verdict}`, color: entry.decision === "deny" ? c.error : c.faint },
            ],
          },
        ];
      }
      const rows: Row[] = [
        {
          key,
          segs: [
            { text: "▲ ", color: c.warning, bold: true },
            { text: truncate(r.summary, Math.max(4, w - 2)), color: c.text, bold: true },
          ],
        },
      ];
      // The question card under the log shows it in full, with the keys.
      if (opts.pinned === key) return rows;
      if (r.detail && r.detail.trim() !== r.summary.trim()) {
        const detail = r.detail.split(/\r?\n/).slice(0, 4);
        detail.forEach((line, i) =>
          rows.push({ key: `${key}:x${i}`, segs: [{ text: `  ${truncate(line, Math.max(4, w - 2))}`, color: c.muted }] }),
        );
      }
      rows.push({
        key: `${key}:keys`,
        segs: [
          { text: "  " },
          { text: " y ", color: c.bg, bg: c.success, bold: true },
          { text: " allow  ", color: c.muted },
          { text: " a ", color: c.bg, bg: c.accent, bold: true },
          { text: " always  ", color: c.muted },
          { text: " n ", color: c.bg, bg: c.error, bold: true },
          { text: " deny", color: c.muted },
        ],
      });
      return rows;
    }
    default:
      return [];
  }
}

interface CachedRows {
  /** A shallow copy of the entry as it was laid out (agents change entries in place). */
  fields: Record<string, unknown>;
  key: string;
  theme: Theme;
  rows: Row[];
}

/** The rows each entry was last laid out to; an entry that is gone takes its rows with it. */
const laidOut = new WeakMap<LogEntry, CachedRows>();

function sameFields(was: Record<string, unknown>, entry: LogEntry): boolean {
  const now = entry as unknown as Record<string, unknown>;
  let n = 0;
  for (const k in now) {
    if (now[k] !== was[k]) return false;
    n++;
  }
  return n === Object.keys(was).length;
}

/**
 * entryRows, remembered per entry: a panel draws the same entries frame after frame and only the
 * newest one changes while an agent streams, so the others aren't wrapped again each frame. An entry
 * is laid out again when any of its fields, the width, the options, the theme or the colour of a
 * teammate it names changed.
 */
export function cachedEntryRows(entry: LogEntry, opts: LogRenderOptions): Row[] {
  const named = entry.kind === "user" && entry.from !== "you" ? entry.from : entry.kind === "message" ? entry.to : null;
  const key = `${opts.width}|${opts.maxDiffLines}|${opts.maxTextLines}|${opts.fullReasoning ? 1 : 0}|${named === null ? "" : opts.colorOf(named)}`;
  const hit = laidOut.get(entry);
  if (hit && hit.key === key && hit.theme === opts.theme && sameFields(hit.fields, entry)) return hit.rows;
  const rows = entryRows(entry, opts);
  laidOut.set(entry, { fields: { ...entry }, key, theme: opts.theme, rows });
  return rows;
}

/**
 * The last rows of the log: walks back from the newest entry until `needed` rows are collected, so
 * long logs cost only what is visible.
 */
export function logTail(log: LogEntry[], needed: number, opts: LogRenderOptions): Row[] {
  const chunks: Row[][] = [];
  let count = 0;
  for (let i = log.length - 1; i >= 0 && count < needed; i--) {
    const rows = cachedEntryRows(log[i], opts);
    chunks.push(rows);
    count += rows.length;
  }
  const rows = chunks.reverse().flat();
  return rows.length > needed ? rows.slice(rows.length - needed) : rows;
}
