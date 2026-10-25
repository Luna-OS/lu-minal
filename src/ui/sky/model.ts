// The animated night sky behind the panels, as pure functions (no React): a seeded star field,
// and one frame of it as ANSI rows. Stars twinkle along the theme's star colours, a few big ones
// pulse in size, a crescent moon glows near the top right and now and then a shooting star
// crosses the top. Under the panels the sky turns to "glass": the panel's surface colour with the
// stars shining through, dimmed by theme.sky.glass.
//
// skyFrame runs about 8 times a second on screens up to 200 x 60 and more, so it fills reused
// typed-array buffers, looks every colour up in a per-theme palette made once, and merges each run
// of equally styled cells into a single escape sequence.
import { mixHex } from "../../themes/color.js";
import type { Theme } from "../../themes/types.js";
import { singleColumnGlyphs } from "../../themes/validate.js";
import { colorLevel, paintOf, spaceRun } from "./ansi.js";

/** A panel rectangle in cells. The sky draws glass under it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The focused panel's glass uses theme.colors.surfaceFocus. */
  focused?: boolean;
}

/** A star: its cell, its size rank 0 (tiny) .. 3 (big), and how it twinkles. */
export interface Star {
  x: number;
  y: number;
  size: number;
  /** Radians. */
  phase: number;
  /** Radians per second. */
  speed: number;
}

/** One cell of a frame (from skyCells): fg is null for cells without a glyph. */
export interface SkyCell {
  char: string;
  fg: string | null;
  bg: string;
}

export interface SkyFrameOptions {
  width: number;
  height: number;
  /** Animation time in ms; the same time (and stars) always gives the same frame. */
  timeMs: number;
  theme: Theme;
  stars: Star[];
  /** The panels, in cells. Overlaps are fine; a focused rect wins. */
  glass: Rect[];
  /** Static stars, a steady moon, no shooting stars. */
  reduceMotion?: boolean;
  /**
   * Where the crescent's top-left cell goes. Omitted: the first free spot near the top right
   * (see moonPlacement). null: no moon.
   */
  moonAt?: { x: number; y: number } | null;
}

// ---- seeded randomness ------------------------------------------------------------------------

/** A small, fast seeded PRNG (mulberry32): the same seed gives the same sequence in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(n: number): number {
  let h = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The seed the Sky component uses, so the stars stay put across theme switches. */
export const DEFAULT_STAR_SEED = 0x5eed;

/**
 * Stars for a width x height sky: about `density` per 100 cells, at distinct cells, sorted by row
 * then column. Deterministic for a seed; make a new field when the size changes.
 * Sizes: ~62 % tiny, 24 % small, 10 % medium, 4 % big.
 */
export function createStarField(width: number, height: number, density: number, seed = DEFAULT_STAR_SEED): Star[] {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const cells = w * h;
  const d = Number.isFinite(density) ? Math.max(0, density) : 0;
  const count = Math.min(cells, Math.round((cells * d) / 100));
  if (!count) return [];
  const rnd = mulberry32(hash32(seed) ^ hash32(w * 7919 + h));
  const used = new Set<number>();
  const stars: Star[] = [];
  for (let tries = 0; stars.length < count && tries < count * 4; tries++) {
    const x = Math.floor(rnd() * w);
    const y = Math.floor(rnd() * h);
    const r = rnd();
    const phase = rnd() * Math.PI * 2;
    const speed = 0.6 + rnd() * 1.8;
    const idx = y * w + x;
    if (used.has(idx)) continue;
    used.add(idx);
    stars.push({ x, y, size: r < 0.62 ? 0 : r < 0.86 ? 1 : r < 0.96 ? 2 : 3, phase, speed });
  }
  stars.sort((a, b) => a.y - b.y || a.x - b.x);
  return stars;
}

// ---- twinkling --------------------------------------------------------------------------------

/** How many brightness steps a star has (colours are precomputed per step). */
export const STAR_LEVELS = 12;
const BASE = [0.3, 0.45, 0.65, 0.82];
const AMP = [0.28, 0.3, 0.28, 0.18];

/** A star's brightness 0..1 at a time (static stars use time 0). */
export function starBrightness(star: Star, timeMs: number): number {
  const s = Math.max(0, Math.min(3, star.size | 0));
  const b = BASE[s] + AMP[s] * Math.sin((timeMs / 1000) * star.speed + star.phase);
  return b < 0 ? 0 : b > 1 ? 1 : b;
}

/** The glyph index of a size rank for a glyph list of `count`, with big stars pulsing. */
function glyphIndex(size: number, brightness: number, count: number): number {
  const s = Math.max(0, Math.min(3, size | 0));
  let i = Math.round((s / 3) * (count - 1));
  // Medium and big stars shrink a size while they are dim.
  if (s >= 2 && brightness < BASE[s] && i > 0) i--;
  return i;
}

// ---- shooting stars ---------------------------------------------------------------------------

/** The shooting star schedule: one per period, at a seeded offset (gaps of 10..20 s). */
export const SHOOTING_STAR = { periodMs: 15_000, jitterMs: 5_000, durationMs: 1_200, tail: 6 } as const;

/** One cell of a shooting star: its size rank (glyph) and fade (0 bright .. 1 gone). */
export interface ShootingStarCell {
  x: number;
  y: number;
  size: number;
  fade: number;
}

/** When the shooting star of the period containing `timeMs` flies: [start, end) in ms. */
export function shootingStarWindow(timeMs: number): { start: number; end: number } {
  const { start } = flight(timeMs);
  return { start, end: start + SHOOTING_STAR.durationMs };
}

/** The period's flight: its start and the seeded random numbers for its path. */
function flight(timeMs: number): { start: number; rnd: () => number } {
  const k = Math.floor(Math.max(0, timeMs) / SHOOTING_STAR.periodMs);
  const rnd = mulberry32(hash32(k + 0x51ab));
  return { start: k * SHOOTING_STAR.periodMs + rnd() * SHOOTING_STAR.jitterMs, rnd };
}

/**
 * The shooting star's cells at `timeMs` (empty between flights): a head moving down-left across
 * the top fifth of the sky over 1.2 s, with a fading tail behind it.
 */
export function shootingStarAt(timeMs: number, width: number, height: number): ShootingStarCell[] {
  if (width < 12 || height < 1) return [];
  const t = Math.max(0, timeMs);
  const { start, rnd } = flight(t);
  if (t < start || t >= start + SHOOTING_STAR.durationMs) return [];
  const p = (t - start) / SHOOTING_STAR.durationMs;
  const travel = Math.max(8, Math.min(30, Math.round(width * 0.22)));
  const x0 = Math.floor(width * (0.4 + rnd() * 0.55));
  const y0 = Math.floor(rnd() * Math.max(1, Math.ceil(height * 0.2)));
  // A shallow dive (cells are about twice as tall as wide), at most a quarter of the sky down.
  const slope = Math.min(0.3, Math.max(2, height * 0.25) / travel);
  const headX = x0 - p * travel;
  const headY = y0 + p * travel * slope;
  // Fades in and out over the flight; the tail grows out of the start point.
  const envelope = Math.sqrt(Math.sin(Math.PI * p));
  const tail = Math.min(SHOOTING_STAR.tail, Math.floor(p * travel) + 1);
  const out: ShootingStarCell[] = [];
  const seen = new Set<number>();
  for (let j = 0; j <= tail; j++) {
    const x = Math.round(headX + j);
    const y = Math.round(headY - j * slope);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const key = y * width + x;
    if (seen.has(key)) continue;
    seen.add(key);
    const fade = 1 - (1 - j / (SHOOTING_STAR.tail + 1)) * envelope;
    out.push({ x, y, size: j === 0 ? 3 : j <= 2 ? 1 : 0, fade: Math.max(0, Math.min(1, fade)) });
  }
  return out;
}

// ---- the crescent moon ------------------------------------------------------------------------

/**
 * The crescent as pixels (two per cell, drawn with half blocks): "#" lit, "+" the dimmer rim,
 * "." the dark side. The whole box hides the stars behind it.
 *
 *     large (7 x 3)   small (6 x 2)
 *       ▀▀██▄          ▀▀██▄
 *          ██          ▄▄██▀
 *       ▄▄██▀
 */
const MOON_LARGE = ["..++##.", "....###", ".....##", ".....##", "....###", "..++##."];
const MOON_SMALL = [".++##.", "...###", "...###", ".++##."];

export const MOON_SIZE = { large: { width: 7, height: 3 }, small: { width: 6, height: 2 } } as const;

/** Per cell: top pixel * 4 + bottom pixel, each 0 dark, 2 rim, 3 lit. */
function moonCells(shape: readonly string[]): number[][] {
  const px = (c: string | undefined): number => (c === "#" ? 3 : c === "+" ? 2 : 0);
  const rows: number[][] = [];
  for (let y = 0; y < shape.length; y += 2) {
    const row: number[] = [];
    for (let x = 0; x < shape[y].length; x++) row.push((px(shape[y][x]) << 2) | px(shape[y + 1]?.[x]));
    rows.push(row);
  }
  return rows;
}

const MOON_CELLS = { large: moonCells(MOON_LARGE), small: moonCells(MOON_SMALL) };

function boxFree(x: number, y: number, w: number, h: number, glass: Rect[]): boolean {
  for (const r of glass) {
    if (x < r.x + r.width && x + w > r.x && y < r.y + r.height && y + h > r.y) return false;
  }
  return true;
}

/**
 * Where the moon goes: the first spot in the top rows near the right edge that no glass rect
 * covers, preferring the 7 x 3 crescent, then the 6 x 2 one; when neither fits anywhere it sits
 * at the top right and the glass hides what it covers. null when the sky is too small.
 */
export function moonPlacement(width: number, height: number, glass: Rect[]): { x: number; y: number; size: "large" | "small" } | null {
  for (const size of ["large", "small"] as const) {
    const { width: mw, height: mh } = MOON_SIZE[size];
    if (width < mw + 4 || height < mh) continue;
    const right = width - mw - 2;
    for (let y = 0; y <= Math.min(3, height - mh); y++) {
      for (let x = right; x >= Math.max(0, right - 16); x--) {
        if (boxFree(x, y, mw, mh, glass)) return { x, y, size };
      }
    }
  }
  const { width: mw, height: mh } = MOON_SIZE.large;
  if (width < mw + 4 || height < mh) return null;
  return { x: width - mw - 2, y: 0, size: "large" };
}

/** How many glow steps the moon has. */
const MOON_LEVELS = 6;
/** One slow breath of the moon's glow. */
const MOON_GLOW_MS = 7_000;

// ---- per-theme palette ------------------------------------------------------------------------

interface Style {
  fg: string | null;
  bg: string;
  open: string;
  close: string;
}

interface Palette {
  sig: string;
  level: number;
  /** Region backgrounds: 0 sky, 1 glass, 2 focused glass. */
  bgs: [string, string, string];
  glyphs: string[];
  styles: Style[];
  ids: Map<string, number>;
  /** Base (blank) style per region. */
  base: [number, number, number];
  /** Star style id per region and brightness step; -1 when the star is invisible there. */
  star: [Int32Array, Int32Array, Int32Array];
  mix: Map<string, string>;
}

const palettes = new WeakMap<Theme, Palette>();

function signature(theme: Theme): string {
  const c = theme.colors;
  const s = theme.sky;
  return `${c.bg}|${c.surface}|${c.surfaceFocus}|${s.glass}|${s.stars.join(",")}|${s.glyphs.join("")}|${s.moonColor}|${s.shootingStarColor}`;
}

function styleId(p: Palette, fg: string | null, bg: string): number {
  const key = `${fg ?? ""}|${bg}`;
  let id = p.ids.get(key);
  if (id === undefined) {
    const paint = paintOf(fg, bg);
    id = p.styles.length;
    p.styles.push({ fg, bg, open: paint.open, close: paint.close });
    p.ids.set(key, id);
  }
  return id;
}

function mixCached(p: Palette, a: string, b: string, t: number): string {
  const key = `${a}${b}${t}`;
  let v = p.mix.get(key);
  if (v === undefined) {
    v = mixHex(a, b, t);
    p.mix.set(key, v);
  }
  return v;
}

/** The colour at position 0..1 along a gradient list. */
function along(list: readonly string[], t: number): string {
  if (list.length === 1) return list[0];
  const pos = Math.max(0, Math.min(1, t)) * (list.length - 1);
  const i = Math.min(list.length - 2, Math.floor(pos));
  return mixHex(list[i], list[i + 1], pos - i);
}

function paletteFor(theme: Theme): Palette {
  const sig = signature(theme);
  const level = colorLevel();
  const cached = palettes.get(theme);
  if (cached && cached.sig === sig && cached.level === level) return cached;

  const c = theme.colors;
  const glyphs = singleColumnGlyphs(theme.sky.glyphs);
  const p: Palette = {
    sig,
    level,
    bgs: [c.bg, c.surface, c.surfaceFocus],
    glyphs: glyphs.length ? glyphs : ["·"],
    styles: [],
    ids: new Map(),
    base: [0, 0, 0],
    star: [new Int32Array(STAR_LEVELS), new Int32Array(STAR_LEVELS), new Int32Array(STAR_LEVELS)],
    mix: new Map(),
  };
  p.base = [styleId(p, null, p.bgs[0]), styleId(p, null, p.bgs[1]), styleId(p, null, p.bgs[2])];
  const stars = theme.sky.stars.length ? theme.sky.stars : [c.text];
  const glass = Math.max(0, Math.min(1, theme.sky.glass));
  for (let q = 0; q < STAR_LEVELS; q++) {
    const color = along(stars, q / (STAR_LEVELS - 1));
    p.star[0][q] = styleId(p, color, p.bgs[0]);
    for (const r of [1, 2] as const) {
      const bg = p.bgs[r];
      const dimmed = glass <= 0 ? bg : mixHex(color, bg, 1 - glass);
      p.star[r][q] = dimmed === bg ? -1 : styleId(p, dimmed, bg);
    }
  }
  palettes.set(theme, p);
  return p;
}

// ---- frame composition ------------------------------------------------------------------------

/** Reused buffers: region per cell (0 sky, 1 glass, 2 focused glass), overlay style and glyph. */
let regionBuf = new Uint8Array(0);
let styleBuf = new Int32Array(0);
let charBuf: string[] = [];

function ensureBuffers(n: number): void {
  if (regionBuf.length < n) {
    const size = Math.max(n, Math.ceil(regionBuf.length * 1.5));
    regionBuf = new Uint8Array(size);
    styleBuf = new Int32Array(size);
    charBuf = new Array<string>(size).fill(" ");
  }
}

function fillGlass(width: number, height: number, glass: Rect[]): void {
  regionBuf.fill(0, 0, width * height);
  // Unfocused first, so a focused rect wins where they overlap.
  for (const pass of [false, true]) {
    for (const r of glass) {
      if (Boolean(r.focused) !== pass) continue;
      const x0 = Math.max(0, Math.floor(r.x));
      const x1 = Math.min(width, Math.floor(r.x + r.width));
      const y0 = Math.max(0, Math.floor(r.y));
      const y1 = Math.min(height, Math.floor(r.y + r.height));
      if (x1 <= x0 || y1 <= y0) continue;
      const v = pass ? 2 : 1;
      for (let y = y0; y < y1; y++) regionBuf.fill(v, y * width + x0, y * width + x1);
    }
  }
}

/** Fills the buffers for one frame; returns the palette (styles) the buffers refer to. */
function compose(opts: SkyFrameOptions): Palette {
  const { width, height, theme } = opts;
  const n = width * height;
  ensureBuffers(n);
  const p = paletteFor(theme);
  fillGlass(width, height, opts.glass);
  styleBuf.fill(-1, 0, n);
  if (!theme.sky.enabled) return p;

  const reduce = Boolean(opts.reduceMotion);
  const t = reduce ? 0 : opts.timeMs;
  const glyphs = p.glyphs;
  const sky = theme.sky;

  // Stars.
  for (const star of opts.stars) {
    const { x, y } = star;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const i = y * width + x;
    const b = starBrightness(star, t);
    const q = Math.round(b * (STAR_LEVELS - 1));
    const id = p.star[regionBuf[i]][q];
    if (id < 0) continue;
    styleBuf[i] = id;
    charBuf[i] = glyphs[glyphIndex(star.size, b, glyphs.length)];
  }

  // The crescent moon, outside the glass only.
  if (sky.moon && opts.moonAt !== null) {
    const auto = moonPlacement(width, height, opts.glass);
    const at = opts.moonAt ? { x: Math.floor(opts.moonAt.x), y: Math.floor(opts.moonAt.y), size: "large" as const } : auto;
    if (at) {
      const glow = reduce ? MOON_LEVELS - 1 : Math.round((0.5 + 0.5 * Math.sin((t / MOON_GLOW_MS) * Math.PI * 2)) * (MOON_LEVELS - 1));
      const bg = p.bgs[0];
      const lit = mixCached(p, sky.moonColor, bg, 0.22 * (1 - glow / (MOON_LEVELS - 1)));
      const rim = mixCached(p, lit, bg, 0.45);
      const colorOf = (px: number): string | null => (px === 3 ? lit : px === 2 ? rim : null);
      const cells = MOON_CELLS[at.size];
      for (let cy = 0; cy < cells.length; cy++) {
        const y = at.y + cy;
        if (y < 0 || y >= height) continue;
        const row = cells[cy];
        for (let cx = 0; cx < row.length; cx++) {
          const x = at.x + cx;
          if (x < 0 || x >= width) continue;
          const i = y * width + x;
          if (regionBuf[i] !== 0) continue;
          const packed = row[cx];
          const top = colorOf(packed >> 2);
          const bottom = colorOf(packed & 3);
          if (!top && !bottom) {
            // The dark side: no stars shine through the moon.
            styleBuf[i] = -1;
            continue;
          }
          if (top && bottom) {
            // A full block when both halves match: it also reads right without colours.
            styleBuf[i] = styleId(p, top, bottom);
            charBuf[i] = top === bottom ? "█" : "▀";
          } else if (top) {
            styleBuf[i] = styleId(p, top, bg);
            charBuf[i] = "▀";
          } else {
            styleBuf[i] = styleId(p, bottom, bg);
            charBuf[i] = "▄";
          }
        }
      }
    }
  }

  // A shooting star now and then, outside the glass only.
  if (sky.shootingStars && !reduce) {
    const bg = p.bgs[0];
    for (const cell of shootingStarAt(t, width, height)) {
      const i = cell.y * width + cell.x;
      if (regionBuf[i] !== 0) continue;
      const fade = Math.round(cell.fade * 8) / 8;
      if (fade >= 1) continue;
      styleBuf[i] = styleId(p, mixCached(p, sky.shootingStarColor, bg, fade), bg);
      charBuf[i] = glyphs[Math.round((cell.size / 3) * (glyphs.length - 1))];
    }
  }
  return p;
}

function validSize(opts: SkyFrameOptions): boolean {
  return Number.isInteger(opts.width) && Number.isInteger(opts.height) && opts.width > 0 && opts.height > 0;
}

/**
 * One frame of the sky: `height` strings, each exactly `width` columns wide (every glyph is one
 * column), coloured with chalk escape codes for the terminal's colour level.
 */
export function skyFrame(opts: SkyFrameOptions): string[] {
  if (!validSize(opts)) return [];
  const { width, height } = opts;
  const p = compose(opts);
  const styles = p.styles;
  const base = p.base;
  const rows: string[] = new Array(height);
  for (let y = 0; y < height; y++) {
    let out = "";
    let run = -1;
    let text = "";
    let blanks = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x;
      let s = styleBuf[i];
      const blank = s < 0;
      if (blank) s = base[regionBuf[i]];
      if (s !== run) {
        if (run >= 0) {
          const st = styles[run];
          out += st.open + text + spaceRun(blanks) + st.close;
        }
        run = s;
        text = "";
        blanks = 0;
      }
      if (blank) {
        blanks++;
      } else {
        if (blanks) {
          text += spaceRun(blanks);
          blanks = 0;
        }
        text += charBuf[i];
      }
    }
    if (run >= 0) {
      const st = styles[run];
      out += st.open + text + spaceRun(blanks) + st.close;
    }
    rows[y] = out;
  }
  return rows;
}

/** The same frame as cells (for tests and tools; skyFrame is the fast path). */
export function skyCells(opts: SkyFrameOptions): SkyCell[][] {
  if (!validSize(opts)) return [];
  const { width, height } = opts;
  const p = compose(opts);
  const out: SkyCell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: SkyCell[] = [];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const s = styleBuf[i];
      if (s < 0) row.push({ char: " ", fg: null, bg: p.bgs[regionBuf[i]] });
      else row.push({ char: charBuf[i], fg: p.styles[s].fg, bg: p.styles[s].bg });
    }
    out.push(row);
  }
  return out;
}
