// Line diffs for the panels: the green "54 + moon = 'full'" and red "88 - warmth = 0.4" rows.
import { structuredPatch } from "diff";
import type { DiffLine } from "../core/types.js";

export interface DiffSummary {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Normalizes line endings so CRLF files diff by content. */
function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The diff between two versions of a file, with `context` unchanged lines around each change.
 * `lineOffset` shifts the line numbers (for diffs of a fragment that starts at line offset + 1).
 */
export function makeDiff(
  oldText: string,
  newText: string,
  opts: { context?: number; lineOffset?: number; maxLines?: number } = {},
): DiffSummary {
  const context = opts.context ?? 1;
  const offset = opts.lineOffset ?? 0;
  const maxLines = opts.maxLines ?? 400;
  const patch = structuredPatch("a", "b", lf(oldText), lf(newText), undefined, undefined, { context });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  patch.hunks.forEach((hunk, i) => {
    if (i > 0) lines.push({ kind: "gap", line: null, text: "…" });
    let oldLine = hunk.oldStart + offset;
    let newLine = hunk.newStart + offset;
    for (const raw of hunk.lines) {
      const mark = raw[0];
      const text = raw.slice(1);
      if (mark === "\\") continue; // "\ No newline at end of file"
      if (mark === "+") {
        added++;
        if (lines.length < maxLines) lines.push({ kind: "add", line: newLine, text });
        newLine++;
      } else if (mark === "-") {
        removed++;
        if (lines.length < maxLines) lines.push({ kind: "del", line: oldLine, text });
        oldLine++;
      } else {
        if (lines.length < maxLines) lines.push({ kind: "ctx", line: newLine, text });
        oldLine++;
        newLine++;
      }
    }
  });
  return { lines, added, removed };
}

/** The 1-based line on which `needle` starts in `haystack`, or null. */
export function lineOf(haystack: string, needle: string): number | null {
  if (!needle) return null;
  const at = lf(haystack).indexOf(lf(needle));
  if (at < 0) return null;
  let line = 1;
  const text = lf(haystack);
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** "1 line added", "3 lines changed", "2 lines removed". */
export function describeChange(added: number, removed: number): string {
  const plural = (n: number) => (n === 1 ? "line" : "lines");
  if (added && removed) {
    const changed = Math.min(added, removed);
    const rest = Math.abs(added - removed);
    const extra = rest ? `, ${rest} ${plural(rest)} ${added > removed ? "added" : "removed"}` : "";
    return `${changed} ${plural(changed)} changed${extra}`;
  }
  if (added) return `${added} ${plural(added)} added`;
  if (removed) return `${removed} ${plural(removed)} removed`;
  return "no changes";
}
