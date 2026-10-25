// Test helpers: strip ANSI escape codes and parse truecolor SGR output into cells, so the tests can
// check widths and colours of pre-rendered rows (the sky, Axo) without a terminal.
import stringWidth from "string-width";

const SGR = /\u001b\[([0-9;]*)m/g;

export function stripAnsi(s: string): string {
  return s.replace(SGR, "");
}

/** Terminal columns of a row, escape codes ignored. */
export function columns(s: string): number {
  return stringWidth(stripAnsi(s));
}

export interface ParsedCell {
  char: string;
  fg: string | null;
  bg: string | null;
}

const hex = (r: string, g: string, b: string): string =>
  `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;

/** One row of truecolor (chalk level 3) output as cells with their fg / bg colours. */
export function parseRow(row: string): ParsedCell[] {
  const cells: ParsedCell[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let i = 0;
  while (i < row.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(row);
    if (m && m.index === i) {
      const parts = m[1].split(";");
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        if (p === "38" && parts[k + 1] === "2") {
          fg = hex(parts[k + 2], parts[k + 3], parts[k + 4]);
          k += 4;
        } else if (p === "48" && parts[k + 1] === "2") {
          bg = hex(parts[k + 2], parts[k + 3], parts[k + 4]);
          k += 4;
        } else if (p === "39") fg = null;
        else if (p === "49") bg = null;
        else if (p === "0" || p === "") {
          fg = null;
          bg = null;
        }
      }
      i += m[0].length;
      continue;
    }
    const cp = row.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    cells.push({ char: ch, fg, bg });
    i += ch.length;
  }
  return cells;
}
