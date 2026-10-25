// Turns an agent's log into the rows its panel draws, like the reference look:
//   ▸ read PLAN.md
//     └ 94 lines
//    54 + moon = 'full'        (a green row)
//   ✦ Charting… (23m 9s · ↓ 72.6k)
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
  /** Lines of a long answer to keep per block when compact (0 = all). */
  maxTextLines: number;
  /** Show reasoning in full (zoomed) or as one faint line. */
  fullReasoning: boolean;
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

/** Rows for a block of prose with a first-line prefix and an indent for the rest. */
function prose(
  key: string,
  text: string,
  w: number,
  prefix: Seg[],
  base: Seg,
  theme: Theme,
  maxLines = 0,
): Row[] {
  const prefixW = prefix.reduce((n, s) => n + width(s.text), 0);
  const rows: Row[] = [];
  let inFence = false;
  const lines: Array<{ text: string; code: boolean }> = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push({ text: truncate(raw.replace(/\t/g, "  "), Math.max(4, w - prefixW)), code: true });
      continue;
    }
    for (const l of wrap(raw.replace(/^(\s*)[-*] /, "$1• "), Math.max(4, w - prefixW))) lines.push({ text: l, code: false });
  }
  while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop();
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
    if (line.code) segs = [{ ...base, text: line.text, color: theme.colors.accent2 }];
    else if (heading) segs = [{ ...base, text: line.text.slice(heading[0].length), bold: true, color: theme.colors.accent }];
    else segs = inline(line.text, base, theme);
    rows.push({ key: `${key}:${i}`, segs: [...lead, ...segs] });
  });
  return rows;
}

function diffRows(key: string, diff: DiffLine[], w: number, theme: Theme, max: number): Row[] {
  const c = theme.colors;
  const rows: Row[] = [];
  const numW = Math.max(2, ...diff.map((d) => String(d.line ?? "").length));
  const visible = diff.filter((d) => d.kind !== "ctx" || diff.length <= max);
  const shown = visible.slice(0, max);
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
  if (visible.length > shown.length) {
    rows.push({
      key: `${key}:dmore`,
      segs: [{ text: `${" ".repeat(numW + 1)}… ${visible.length - shown.length} more`, color: c.faint }],
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
      return prose(key, entry.text, w, prefix, { text: "", color: mine ? c.text : c.muted }, theme, opts.maxTextLines ? 4 : 0);
    }
    case "text":
      return prose(key, entry.text, w, [], { text: "", color: c.text }, theme, opts.maxTextLines);
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
      if (entry.diff?.length) rows.push(...diffRows(key, entry.diff, w, theme, opts.maxDiffLines));
      if (entry.detail) {
        rows.push({
          key: `${key}:detail`,
          segs: [
            { text: "  └ ", color: c.faint },
            {
              text: truncate(entry.detail, Math.max(4, w - 4)),
              color: entry.status === "error" ? c.error : c.muted,
            },
          ],
        });
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

/**
 * The last rows of the log: walks back from the newest entry until `needed` rows are collected, so
 * long logs cost only what is visible.
 */
export function logTail(log: LogEntry[], needed: number, opts: LogRenderOptions): Row[] {
  const chunks: Row[][] = [];
  let count = 0;
  for (let i = log.length - 1; i >= 0 && count < needed; i--) {
    const rows = entryRows(log[i], opts);
    chunks.push(rows);
    count += rows.length;
  }
  const rows = chunks.reverse().flat();
  return rows.length > needed ? rows.slice(rows.length - needed) : rows;
}
