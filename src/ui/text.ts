// Column-aware string helpers: terminals count cells, not characters (wide CJK, emoji, combining
// marks), so every width here goes through string-width.
import stringWidth from "string-width";

export const width = (s: string): number => stringWidth(s);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(s)) out.push(segment);
  return out;
}

/** Cuts `s` to at most `max` columns, ending in `ellipsis` when it had to cut. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (stringWidth(s) <= max) return s;
  const room = max - stringWidth(ellipsis);
  let out = "";
  let used = 0;
  for (const g of graphemes(s)) {
    const w = stringWidth(g);
    if (used + w > room) break;
    out += g;
    used += w;
  }
  return out + (room >= 0 ? ellipsis : "");
}

/** Cuts from the left: "…/src/ui/App.tsx". */
export function truncateStart(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (stringWidth(s) <= max) return s;
  const gs = graphemes(s);
  const room = max - stringWidth(ellipsis);
  let out = "";
  let used = 0;
  for (let i = gs.length - 1; i >= 0; i--) {
    const w = stringWidth(gs[i]);
    if (used + w > room) break;
    out = gs[i] + out;
    used += w;
  }
  return ellipsis + out;
}

/** Pads `s` with spaces to exactly `w` columns (truncating when longer). */
export function fit(s: string, w: number): string {
  const t = truncate(s, w);
  return t + " ".repeat(Math.max(0, w - stringWidth(t)));
}

export function padStart(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - stringWidth(s))) + s;
}

/** Splits a word that is wider than `w` into pieces of at most `w` columns. */
function hardSplit(word: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  let used = 0;
  for (const g of graphemes(word)) {
    const gw = stringWidth(g);
    if (used + gw > w && cur) {
      out.push(cur);
      cur = "";
      used = 0;
    }
    cur += g;
    used += gw;
  }
  if (cur) out.push(cur);
  return out;
}

/** Word-wraps `text` to `w` columns; keeps blank lines; tabs become two spaces. */
export function wrap(text: string, w: number): string[] {
  if (w <= 0) return [];
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n")) {
    if (!rawLine.trim()) {
      out.push("");
      continue;
    }
    const indentW = Math.min(stringWidth(/^\s*/.exec(rawLine)?.[0] ?? ""), Math.floor(w / 2));
    const lead = " ".repeat(indentW);
    const avail = Math.max(1, w - indentW);
    let line = "";
    let lineW = 0;
    const flush = () => {
      out.push(lead + line.trimEnd());
      line = "";
      lineW = 0;
    };
    for (const token of rawLine.trimStart().split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        if (lineW > 0) {
          line += token;
          lineW += stringWidth(token);
        }
        continue;
      }
      const tw = stringWidth(token);
      if (lineW > 0 && lineW + tw > avail) flush();
      if (tw > avail) {
        const parts = hardSplit(token, avail);
        for (let i = 0; i < parts.length - 1; i++) {
          line = parts[i];
          flush();
        }
        line = parts[parts.length - 1];
        lineW = stringWidth(line);
      } else {
        line += token;
        lineW += tw;
      }
    }
    if (line) flush();
  }
  return out;
}

/** Removes ANSI escape sequences (tool output, CLI stderr). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, "");
}
