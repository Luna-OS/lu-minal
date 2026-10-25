// Fast chalk painting for pre-rendered rows (the sky, Axo): the escape codes for a colour pair are
// asked from chalk once and cached, so a row is plain string concatenation. Chalk picks the codes
// for the terminal's colour level (truecolor, 256 colours on macOS Terminal, 16, none), and the
// cache is dropped when that level changes.
import chalk from "chalk";

/** The escape codes around a run of text in one style. Both are "" at colour level 0. */
export interface Paint {
  open: string;
  close: string;
}

const cache = new Map<string, Paint>();
let cachedLevel = chalk.level;

/** Codes for text in `fg` (null: the terminal's default) on `bg` (null: no background). */
export function paintOf(fg: string | null, bg: string | null): Paint {
  if (chalk.level !== cachedLevel) {
    cache.clear();
    cachedLevel = chalk.level;
  }
  const key = `${fg ?? ""}|${bg ?? ""}`;
  let p = cache.get(key);
  if (!p) {
    let builder = chalk;
    if (bg) builder = builder.bgHex(bg);
    if (fg) builder = builder.hex(fg);
    // The sentinel never occurs inside an escape code.
    const s = builder("X");
    const i = s.indexOf("X");
    p = i < 0 ? { open: "", close: "" } : { open: s.slice(0, i), close: s.slice(i + 1) };
    if (cache.size > 4096) cache.clear();
    cache.set(key, p);
  }
  return p;
}

/** `text` painted in `fg` on `bg` (text must not contain newlines or escape codes). */
export function paint(text: string, fg: string | null, bg: string | null): string {
  if (!text) return "";
  const p = paintOf(fg, bg);
  return p.open + text + p.close;
}

/** The chalk colour level the cached codes were made for (0 none, 1 basic, 2 256, 3 truecolor). */
export function colorLevel(): number {
  return chalk.level;
}

const spaces: string[] = [""];

/** `n` spaces, from a cache (rows are built from many runs of spaces). */
export function spaceRun(n: number): string {
  if (n <= 0) return "";
  if (n < 512) {
    let s = spaces[n];
    if (s === undefined) {
      s = " ".repeat(n);
      spaces[n] = s;
    }
    return s;
  }
  return " ".repeat(n);
}
