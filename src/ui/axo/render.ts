// Draws Axo in the terminal with half blocks: two pixel rows become one terminal row ("▀" with
// the top pixel as foreground and the bottom pixel as background), so the 26 x 20 sprite is
// 26 columns x 10 rows. Also picks Axo's pose for a mood and a moment (blinking, typing, hopping,
// snoring z's), as pure functions the component and the tests share.
import { isHex, mixHex } from "../../themes/color.js";
import { colorLevel, paintOf } from "../sky/ansi.js";
import { AXO_COLORS, AXO_FRAMES, AXO_HEIGHT, AXO_WIDTH, AXO_Z_COLOR, type AxoFrame, type AxoMood } from "./frames.js";

/** Terminal rows Axo takes (without the caption). */
export const AXO_ROWS = AXO_HEIGHT / 2;
/** Terminal columns Axo takes. */
export const AXO_COLUMNS = AXO_WIDTH;

/** One frame tick of the component, in ms. */
export const AXO_TICK_MS = 250;

/** A character drawn over the sprite (the snoring z's), in cells, fading with `alpha` (0..1). */
export interface AxoOverlay {
  x: number;
  y: number;
  char: string;
  alpha: number;
}

/** What to draw: a frame, an optional vertical shift in pixels (hops) and overlays. */
export interface AxoPose {
  frame: AxoFrame;
  /** Pixels up (1 = half a cell). */
  lift: number;
  overlays: AxoOverlay[];
}

const rendered = new WeakMap<AxoFrame, Map<string, string[]>>();

interface Cell {
  ch: string;
  fg: string | null;
  bg: string;
}

function colorOf(key: string | undefined, colors: Readonly<Record<string, string>>): string | null {
  return key === undefined || key === "." ? null : (colors[key] ?? null);
}

/** One terminal row of a frame (pixel rows 2*row and 2*row+1) as cells. */
function cellsOf(frame: AxoFrame, row: number, width: number, bg: string, colors: Readonly<Record<string, string>>, level: number): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x < width; x++) {
    const top = colorOf(frame[row * 2]?.[x], colors);
    const bottom = colorOf(frame[row * 2 + 1]?.[x], colors);
    if (level === 0) cells.push({ ch: top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ", fg: null, bg });
    else if (top && bottom) cells.push({ ch: "▀", fg: top, bg: bottom });
    else if (top) cells.push({ ch: "▀", fg: top, bg });
    else if (bottom) cells.push({ ch: "▄", fg: bottom, bg });
    else cells.push({ ch: " ", fg: null, bg });
  }
  return cells;
}

/** Cells as one string, with one escape sequence per run of equally styled cells. */
function joinCells(cells: readonly Cell[]): string {
  let out = "";
  let i = 0;
  while (i < cells.length) {
    const { fg, bg } = cells[i];
    let text = "";
    while (i < cells.length && cells[i].fg === fg && cells[i].bg === bg) text += cells[i++].ch;
    const p = paintOf(fg, bg);
    out += p.open + text + p.close;
  }
  return out;
}

/**
 * `frame` as AXO_ROWS strings of AXO_COLUMNS columns on `bg`. Transparent pixels (".") show `bg`;
 * a cell with both pixels transparent is a plain space on `bg`. Without colours (chalk level 0) the
 * silhouette is drawn with "█", "▀" and "▄". Results are cached per frame and background.
 */
export function renderAxo(frame: readonly string[], bg: string, colors: Readonly<Record<string, string>> = AXO_COLORS): string[] {
  const level = colorLevel();
  const key = `${bg}|${level}`;
  const useCache = colors === AXO_COLORS;
  if (useCache) {
    const hit = rendered.get(frame)?.get(key);
    if (hit) return hit;
  }
  const width = frame.reduce((w, row) => Math.max(w, row.length), 0);
  const rows: string[] = [];
  for (let y = 0; y < Math.ceil(frame.length / 2); y++) rows.push(joinCells(cellsOf(frame, y, width, bg, colors, level)));
  if (useCache) {
    let byBg = rendered.get(frame);
    if (!byBg) {
      byBg = new Map();
      rendered.set(frame, byBg);
    }
    if (byBg.size > 32) byBg.clear();
    byBg.set(key, rows);
  }
  return rows;
}

const lifted = new WeakMap<AxoFrame, Map<number, AxoFrame>>();

/** The frame moved up by `lift` pixels (rows fall off the top, transparent rows come in below). */
export function liftFrame(frame: AxoFrame, lift: number): AxoFrame {
  const n = Math.max(0, Math.min(frame.length, Math.floor(lift)));
  if (!n) return frame;
  let byLift = lifted.get(frame);
  if (!byLift) {
    byLift = new Map();
    lifted.set(frame, byLift);
  }
  let out = byLift.get(n);
  if (!out) {
    const blank = ".".repeat(frame[0]?.length ?? AXO_WIDTH);
    out = [...frame.slice(n), ...Array<string>(n).fill(blank)];
    byLift.set(n, out);
  }
  return out;
}

/** Ticks a done mood cheers before Axo goes back to idling (~2 s). */
export const DONE_TICKS = 8;
/** Ticks between blinks (~4 s). */
export const BLINK_EVERY = 16;
/** Ticks one snored z lives (3 s), and how far apart the three are (1 s). */
const Z_LIFE = 12;
const Z_GAP = 4;
/** Where a z drifts while it rises: up and to the right, through cells the sleep frame leaves empty. */
const Z_PATH: ReadonlyArray<{ x: number; y: number }> = [
  { x: 23, y: 2 },
  { x: 24, y: 2 },
  { x: 25, y: 1 },
  { x: 24, y: 0 },
  { x: 25, y: 0 },
];

/**
 * Axo's pose for `mood`, `tick` ticks (AXO_TICK_MS each) after the mood began.
 * - idle: eyes open, a blink every ~4 s
 * - work: the two typing frames, alternating every tick
 * - done: cheering with little hops for ~2 s, then idle
 * - sleep: still, with three z's rising one after another
 * Without `animate` every mood is a still frame (sleep keeps one "Z").
 */
export function axoPose(mood: AxoMood, tick: number, animate = true): AxoPose {
  const frames = AXO_FRAMES[mood] ?? AXO_FRAMES.idle;
  const t = animate ? Math.max(0, Math.floor(tick)) : 0;
  switch (mood) {
    case "work":
      return { frame: frames[t % frames.length], lift: 0, overlays: [] };
    case "done":
      if (!animate) return { frame: frames[0], lift: 0, overlays: [] };
      if (t < DONE_TICKS) return { frame: frames[0], lift: t % 4 === 1 || t % 4 === 2 ? 1 : 0, overlays: [] };
      return axoPose("idle", t - DONE_TICKS, animate);
    case "sleep": {
      if (!animate) return { frame: frames[0], lift: 0, overlays: [{ ...Z_PATH[Z_PATH.length - 1], char: "Z", alpha: 1 }] };
      const overlays: AxoOverlay[] = [];
      for (let n = 0; n < 3; n++) {
        const age = (t - n * Z_GAP + Z_LIFE * 3) % Z_LIFE;
        const f = age / (Z_LIFE - 1);
        const at = Z_PATH[Math.min(Z_PATH.length - 1, Math.floor(f * Z_PATH.length))];
        // Fades in over the first fifth, then out (Moon Code's mc-axo-z keyframes).
        const alpha = f < 0.2 ? f / 0.2 : 1 - (f - 0.2) / 0.8;
        if (alpha <= 0.05) continue;
        overlays.push({ x: at.x, y: at.y, char: n === 2 ? "Z" : "z", alpha });
      }
      // Two z's never share a cell: the brighter one wins.
      overlays.sort((a, b) => b.alpha - a.alpha);
      const seen = new Set<string>();
      const unique = overlays.filter((o) => {
        const key = `${o.x},${o.y}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { frame: frames[0], lift: 0, overlays: unique };
    }
    default: {
      const blink = animate && frames.length > 1 && t % BLINK_EVERY === BLINK_EVERY - 1;
      return { frame: frames[blink ? 1 : 0], lift: 0, overlays: [] };
    }
  }
}

/** The pose as AXO_ROWS strings of AXO_COLUMNS columns on `bg`, overlays drawn in. */
export function renderAxoPose(pose: AxoPose, bg: string): string[] {
  const frame = liftFrame(pose.frame, pose.lift);
  const rows = renderAxo(frame, bg);
  const overlays = pose.overlays.filter((o) => o.y >= 0 && o.y < rows.length && o.x >= 0 && o.x < AXO_COLUMNS);
  if (!overlays.length) return rows;
  const out = [...rows];
  const level = colorLevel();
  for (const y of new Set(overlays.map((o) => o.y))) {
    const cells = cellsOf(frame, y, AXO_COLUMNS, bg, AXO_COLORS, level);
    for (const o of overlays) {
      if (o.y !== y) continue;
      const a = Math.round(Math.max(0, Math.min(1, o.alpha)) * 8) / 8;
      cells[o.x] = { ch: o.char, fg: level === 0 ? null : isHex(bg) ? mixHex(bg, AXO_Z_COLOR, a) : AXO_Z_COLOR, bg };
    }
    out[y] = joinCells(cells);
  }
  return out;
}
