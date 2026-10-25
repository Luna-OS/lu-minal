import chalk from "chalk";
import stringWidth from "string-width";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinTheme } from "../../src/themes/builtin.js";
import { mixHex } from "../../src/themes/color.js";
import type { Theme } from "../../src/themes/types.js";
import {
  MOON_SIZE,
  SHOOTING_STAR,
  STAR_LEVELS,
  createStarField,
  moonPlacement,
  mulberry32,
  shootingStarAt,
  shootingStarWindow,
  skyCells,
  skyFrame,
  starBrightness,
  type Rect,
  type SkyFrameOptions,
} from "../../src/ui/sky/model.js";
import { columns, parseRow, stripAnsi } from "./ansi-helpers.js";

const moon = builtinTheme("moon")!;
let level: typeof chalk.level;

beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = level;
});

function opts(partial: Partial<SkyFrameOptions> = {}): SkyFrameOptions {
  const width = partial.width ?? 80;
  const height = partial.height ?? 24;
  const theme = partial.theme ?? moon;
  return { width, height, timeMs: 0, theme, stars: createStarField(width, height, theme.sky.density, 7), glass: [], ...partial };
}

/** A time when no shooting star flies. */
const QUIET = shootingStarWindow(0).end + 1000;

const MOON_GLYPHS = new Set(["▀", "▄", "█"]);

describe("createStarField", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    expect(createStarField(120, 40, 1.6, 42)).toEqual(createStarField(120, 40, 1.6, 42));
    expect(createStarField(120, 40, 1.6, 42)).not.toEqual(createStarField(120, 40, 1.6, 43));
  });

  it("places about density stars per 100 cells, on distinct cells inside the sky", () => {
    const stars = createStarField(200, 60, 1.6, 1);
    expect(stars.length).toBe(Math.round((200 * 60 * 1.6) / 100));
    const cells = new Set(stars.map((s) => `${s.x},${s.y}`));
    expect(cells.size).toBe(stars.length);
    for (const s of stars) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThan(200);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThan(60);
      expect([0, 1, 2, 3]).toContain(s.size);
      expect(s.speed).toBeGreaterThan(0);
    }
    // Sorted by row, then column; and a mix of sizes with mostly tiny stars.
    for (let i = 1; i < stars.length; i++) expect(stars[i].y * 1000 + stars[i].x).toBeGreaterThan(stars[i - 1].y * 1000 + stars[i - 1].x);
    const tiny = stars.filter((s) => s.size === 0).length;
    expect(tiny / stars.length).toBeGreaterThan(0.45);
    expect(stars.some((s) => s.size === 3)).toBe(true);
  });

  it("handles empty and degenerate sizes", () => {
    expect(createStarField(0, 10, 2)).toEqual([]);
    expect(createStarField(10, 10, 0)).toEqual([]);
    expect(createStarField(10, 10, Number.NaN)).toEqual([]);
    // Never more stars than cells.
    expect(createStarField(3, 2, 500).length).toBe(6);
  });

  it("uses a seeded PRNG in [0, 1)", () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("skyFrame", () => {
  it("returns one row per line, each exactly width columns", () => {
    for (const [w, h] of [
      [80, 24],
      [200, 60],
      [13, 3],
      [1, 1],
    ]) {
      for (const t of [0, 777, QUIET, shootingStarWindow(0).start + 600]) {
        const rows = skyFrame(opts({ width: w, height: h, timeMs: t, glass: [{ x: 2, y: 1, width: Math.max(1, w - 4), height: Math.max(1, h - 2), focused: true }] }));
        expect(rows).toHaveLength(h);
        for (const row of rows) {
          expect(columns(row)).toBe(w);
          expect(row).not.toContain("\n");
        }
      }
    }
  });

  it("is exactly the same for the same time and stars", () => {
    const a = skyFrame(opts({ timeMs: 12_345 }));
    const b = skyFrame(opts({ timeMs: 12_345 }));
    expect(a).toEqual(b);
  });

  it("twinkles: brightness follows a sine of time", () => {
    const star = { x: 0, y: 0, size: 1, phase: 0, speed: 1 };
    const values = [0, 400, 800, 1600, 3200].map((t) => starBrightness(star, t));
    expect(new Set(values.map((v) => v.toFixed(3))).size).toBeGreaterThan(3);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const a = skyFrame(opts({ timeMs: QUIET }));
    const b = skyFrame(opts({ timeMs: QUIET + 900 }));
    expect(a).not.toEqual(b);
  });

  it("draws stars in the theme's star colours on the sky background", () => {
    const o = opts({ timeMs: QUIET, theme: { ...moon, sky: { ...moon.sky, moon: false } } });
    const cells = skyCells(o);
    const stars = cells.flat().filter((c) => c.fg);
    expect(stars.length).toBeGreaterThan(10);
    const allowed = new Set<string>();
    for (let q = 0; q < STAR_LEVELS; q++) {
      const pos = (q / (STAR_LEVELS - 1)) * (moon.sky.stars.length - 1);
      const i = Math.min(moon.sky.stars.length - 2, Math.floor(pos));
      allowed.add(mixHex(moon.sky.stars[i], moon.sky.stars[i + 1], pos - i));
    }
    for (const s of stars) {
      expect(allowed.has(s.fg!)).toBe(true);
      expect(s.bg).toBe(moon.colors.bg);
      expect(moon.sky.glyphs).toContain(s.char);
    }
    // Blank cells carry the bg and no fg.
    expect(cells.flat().filter((c) => !c.fg).every((c) => c.char === " " && c.bg === moon.colors.bg)).toBe(true);
  });

  it("matches skyCells in the ANSI output (truecolor)", () => {
    const o = opts({ width: 60, height: 12, timeMs: 4321, glass: [{ x: 5, y: 4, width: 30, height: 6 }] });
    const rows = skyFrame(o);
    const cells = skyCells(o);
    rows.forEach((row, y) => {
      const parsed = parseRow(row);
      expect(parsed).toHaveLength(60);
      parsed.forEach((p, x) => {
        expect(p.char).toBe(cells[y][x].char);
        expect(p.bg).toBe(cells[y][x].bg);
        if (cells[y][x].fg) expect(p.fg).toBe(cells[y][x].fg);
      });
    });
  });

  it("merges runs: a row of one style is a single escape sequence", () => {
    const empty: Theme = { ...moon, sky: { ...moon.sky, enabled: false } };
    const [row] = skyFrame(opts({ width: 50, height: 1, theme: empty }));
    expect(row.match(/\u001b\[48;2/g)).toHaveLength(1);
    expect(stripAnsi(row)).toBe(" ".repeat(50));
  });

  describe("glass", () => {
    const panel: Rect = { x: 10, y: 6, width: 40, height: 12 };
    const focusedPanel: Rect = { x: 52, y: 6, width: 20, height: 12, focused: true };

    it("uses surface (and surfaceFocus for the focused panel) under the panels", () => {
      // (The moon's own cells may carry the moon colour as background, so it is off here.)
      const cells = skyCells(opts({ timeMs: QUIET, glass: [panel, focusedPanel], moonAt: null }));
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 80; x++) {
          const inPanel = x >= 10 && x < 50 && y >= 6 && y < 18;
          const inFocused = x >= 52 && x < 72 && y >= 6 && y < 18;
          const want = inFocused ? moon.colors.surfaceFocus : inPanel ? moon.colors.surface : moon.colors.bg;
          expect(cells[y][x].bg, `${x},${y}`).toBe(want);
        }
      }
    });

    it("lets stars shine through, dimmed toward the surface by 1 - glass", () => {
      const dense: Theme = { ...moon, sky: { ...moon.sky, density: 8 } };
      const o = opts({ theme: dense, timeMs: QUIET, glass: [{ x: 0, y: 0, width: 80, height: 24 }] });
      const inside = skyCells(o).flat().filter((c) => c.fg);
      expect(inside.length).toBeGreaterThan(20);
      const outside = skyCells({ ...o, glass: [] }).flat().filter((c) => c.fg && !MOON_GLYPHS.has(c.char));
      const dimmed = new Set(outside.map((c) => mixHex(c.fg!, moon.colors.surface, 1 - moon.sky.glass)));
      for (const c of inside) {
        expect(c.bg).toBe(moon.colors.surface);
        expect(dimmed.has(c.fg!)).toBe(true);
      }
    });

    it("hides the stars completely with glass 0", () => {
      const opaque: Theme = { ...moon, sky: { ...moon.sky, glass: 0, density: 8 } };
      const cells = skyCells(opts({ theme: opaque, glass: [{ x: 0, y: 4, width: 80, height: 20 }] }));
      for (let y = 4; y < 24; y++) for (const c of cells[y]) expect(c).toEqual({ char: " ", fg: null, bg: moon.colors.surface });
    });

    it("lets the focused rect win where rects overlap, and clips rects to the sky", () => {
      const cells = skyCells(
        opts({
          width: 20,
          height: 5,
          glass: [
            { x: 0, y: 0, width: 10, height: 5, focused: true },
            { x: 5, y: 0, width: 100, height: 100 },
            { x: -5, y: -5, width: 3, height: 3 },
          ],
        }),
      );
      expect(cells[2][7].bg).toBe(moon.colors.surfaceFocus);
      expect(cells[2][12].bg).toBe(moon.colors.surface);
      expect(cells[4][19].bg).toBe(moon.colors.surface);
    });

    it("never draws the moon or a shooting star inside glass", () => {
      const start = shootingStarWindow(0).start;
      for (const t of [start + 200, start + 600, start + 1000]) {
        const cells = skyCells(opts({ timeMs: t, glass: [{ x: 0, y: 0, width: 80, height: 24 }] }));
        const flat = cells.flat();
        expect(flat.some((c) => MOON_GLYPHS.has(c.char))).toBe(false);
        expect(flat.some((c) => c.fg && c.fg.startsWith(moon.sky.shootingStarColor))).toBe(false);
      }
    });
  });

  describe("the crescent moon", () => {
    it("sits near the top right outside the glass, in the moon colour", () => {
      const o = opts({ timeMs: QUIET });
      const at = moonPlacement(80, 24, [])!;
      expect(at).toEqual({ x: 80 - MOON_SIZE.large.width - 2, y: 0, size: "large" });
      const cells = skyCells(o);
      const moonCells = cells.flatMap((row, y) => row.map((c, x) => ({ ...c, x, y }))).filter((c) => MOON_GLYPHS.has(c.char));
      expect(moonCells.length).toBeGreaterThanOrEqual(8);
      for (const c of moonCells) {
        expect(c.x).toBeGreaterThanOrEqual(at.x);
        expect(c.x).toBeLessThan(at.x + 7);
        expect(c.y).toBeLessThan(3);
      }
      // The brightest cell is the moon colour itself at the glow's peak (reduceMotion = steady peak).
      const steady = skyCells({ ...o, reduceMotion: true }).flat();
      expect(steady.some((c) => c.fg === moon.sky.moonColor)).toBe(true);
      // The rest of the moon's box is its dark side: no stars there.
      for (let y = 0; y < 3; y++) for (let x = at.x; x < at.x + 7; x++) if (!MOON_GLYPHS.has(cells[y][x].char)) expect(cells[y][x].char).toBe(" ");
    });

    it("glows gently over time", () => {
      const a = skyCells(opts({ timeMs: 1750 })).flat().filter((c) => MOON_GLYPHS.has(c.char)).map((c) => c.fg);
      const b = skyCells(opts({ timeMs: 5250 })).flat().filter((c) => MOON_GLYPHS.has(c.char)).map((c) => c.fg);
      expect(a).not.toEqual(b);
    });

    it("moves out of the way of glass, shrinks to two rows, or is hidden by the glass", () => {
      // Rows 0-1 free, a panel from row 2: only the small moon fits.
      const small = moonPlacement(100, 30, [{ x: 0, y: 2, width: 100, height: 28 }]);
      expect(small).toMatchObject({ size: "small", y: 0 });
      // A panel in the top right corner: the moon moves left of it.
      const left = moonPlacement(100, 30, [{ x: 85, y: 0, width: 15, height: 30 }])!;
      expect(left.size).toBe("large");
      expect(left.x + MOON_SIZE.large.width).toBeLessThanOrEqual(85);
      // Glass everywhere: placed at the top right, and the glass hides it.
      expect(moonPlacement(100, 30, [{ x: 0, y: 0, width: 100, height: 30 }])).toEqual({ x: 91, y: 0, size: "large" });
      expect(moonPlacement(6, 2, [])).toBeNull();
    });

    it("can be placed explicitly or switched off", () => {
      const placed = skyCells(opts({ moonAt: { x: 3, y: 10 } }));
      expect(placed.slice(10, 13).some((row) => row.slice(3, 10).some((c) => MOON_GLYPHS.has(c.char)))).toBe(true);
      expect(placed.slice(0, 3).some((row) => row.some((c) => MOON_GLYPHS.has(c.char)))).toBe(false);
      const none = skyCells(opts({ moonAt: null })).flat();
      expect(none.some((c) => MOON_GLYPHS.has(c.char))).toBe(false);
      const off = skyCells(opts({ theme: { ...moon, sky: { ...moon.sky, moon: false } } })).flat();
      expect(off.some((c) => MOON_GLYPHS.has(c.char))).toBe(false);
    });
  });

  describe("shooting stars", () => {
    it("fly once per period, for 1.2 s, 10 to 20 s apart", () => {
      const windows = Array.from({ length: 20 }, (_, k) => shootingStarWindow(k * SHOOTING_STAR.periodMs));
      for (let k = 0; k < windows.length; k++) {
        expect(windows[k].end - windows[k].start).toBe(SHOOTING_STAR.durationMs);
        if (k) {
          const gap = windows[k].start - windows[k - 1].start;
          expect(gap).toBeGreaterThanOrEqual(10_000);
          expect(gap).toBeLessThanOrEqual(20_000);
        }
      }
    });

    it("appear during their window and not outside it", () => {
      const { start, end } = shootingStarWindow(SHOOTING_STAR.periodMs * 3);
      expect(shootingStarAt(start - 1, 120, 40)).toEqual([]);
      expect(shootingStarAt(end + 1, 120, 40)).toEqual([]);
      const mid = shootingStarAt(start + 600, 120, 40);
      expect(mid.length).toBeGreaterThanOrEqual(5);
      // A head (big glyph, brightest) leading down-left, with a fading tail up-right of it.
      const [head, ...tail] = mid;
      expect(head.size).toBe(3);
      for (const c of tail) {
        expect(c.x).toBeGreaterThan(head.x);
        expect(c.y).toBeLessThanOrEqual(head.y);
        expect(c.fade).toBeGreaterThanOrEqual(head.fade);
      }
      // It moves down-left over its flight, and stays in the top part of the sky.
      const early = shootingStarAt(start + 200, 120, 40)[0];
      const late = shootingStarAt(start + 1000, 120, 40)[0];
      expect(late.x).toBeLessThan(early.x);
      expect(late.y).toBeGreaterThanOrEqual(early.y);
      expect(late.y).toBeLessThan(20);
    });

    it("show up in the frame in the shooting star colour, and only then", () => {
      const { start } = shootingStarWindow(0);
      const noMoon: Theme = { ...moon, sky: { ...moon.sky, moon: false, shootingStarColor: "#ff00ff", stars: ["#202020", "#404040"] } };
      const at = (t: number) => skyCells(opts({ theme: noMoon, timeMs: t })).flat();
      // The stars are grey here, so any coloured cell is the shooting star (or its tail).
      const coloured = (cells: ReturnType<typeof at>) => cells.filter((c) => c.fg && !(c.fg.slice(1, 3) === c.fg.slice(3, 5) && c.fg.slice(3, 5) === c.fg.slice(5, 7)));
      const during = at(start + 600);
      expect(during.some((c) => c.fg === "#ff00ff")).toBe(true);
      expect(coloured(during).length).toBeGreaterThanOrEqual(4);
      expect(coloured(at(start - 500))).toEqual([]);
      expect(coloured(at(QUIET))).toEqual([]);
      // Switched off in the theme, or with reduced motion.
      const off: Theme = { ...noMoon, sky: { ...noMoon.sky, shootingStars: false } };
      expect(skyCells(opts({ theme: off, timeMs: start + 600 })).flat().some((c) => c.fg === "#ff00ff")).toBe(false);
      expect(skyCells(opts({ theme: noMoon, timeMs: start + 600, reduceMotion: true })).flat().some((c) => c.fg === "#ff00ff")).toBe(false);
    });

    it("need room", () => {
      expect(shootingStarAt(shootingStarWindow(0).start + 600, 5, 5)).toEqual([]);
    });
  });

  it("is static with reduceMotion", () => {
    const a = skyFrame(opts({ timeMs: 1000, reduceMotion: true }));
    const b = skyFrame(opts({ timeMs: 98_765, reduceMotion: true }));
    expect(a).toEqual(b);
    // Static stars still vary in brightness (from their phase).
    const fgs = new Set(skyCells(opts({ reduceMotion: true })).flat().map((c) => c.fg).filter(Boolean));
    expect(fgs.size).toBeGreaterThan(3);
  });

  it("draws plain background rows (and glass) when the sky is off", () => {
    const off: Theme = { ...moon, sky: { ...moon.sky, enabled: false } };
    const cells = skyCells(opts({ theme: off, timeMs: shootingStarWindow(0).start + 600, glass: [{ x: 4, y: 4, width: 10, height: 4, focused: true }] }));
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 80; x++) {
        const inside = x >= 4 && x < 14 && y >= 4 && y < 8;
        expect(cells[y][x]).toEqual({ char: " ", fg: null, bg: inside ? moon.colors.surfaceFocus : moon.colors.bg });
      }
    }
    const rows = skyFrame(opts({ theme: off }));
    expect(rows.every((r) => stripAnsi(r) === " ".repeat(80))).toBe(true);
  });

  it("works for every built-in theme and with a custom glyph list", () => {
    for (const name of ["moon-day", "astra", "tokyo-night", "catppuccin-mocha", "dracula", "nord", "gruvbox-dark", "rose-pine", "mono"]) {
      const theme = builtinTheme(name)!;
      const rows = skyFrame(opts({ theme, timeMs: 5000, glass: [{ x: 1, y: 3, width: 40, height: 10 }] }));
      expect(rows.every((r) => columns(r) === 80)).toBe(true);
    }
    // Wide glyphs in a hand-made theme are never drawn (rows stay exact).
    const odd: Theme = { ...moon, sky: { ...moon.sky, glyphs: ["🌟", "+"], density: 10 } };
    const rows = skyFrame(opts({ theme: odd, timeMs: QUIET }));
    expect(rows.every((r) => columns(r) === 80)).toBe(true);
    expect(rows.join("")).not.toContain("🌟");
  });

  it("degrades with the terminal's colour level", () => {
    chalk.level = 2;
    try {
      const rows = skyFrame(opts({ width: 30, height: 4 }));
      expect(rows.join("")).not.toMatch(/\u001b\[[34]8;2;/);
      expect(rows.join("")).toMatch(/\u001b\[48;5;\d+m/);
      expect(rows.every((r) => columns(r) === 30)).toBe(true);
    } finally {
      chalk.level = 3;
    }
    chalk.level = 0;
    try {
      const rows = skyFrame(opts({ width: 30, height: 4 }));
      expect(rows.join("")).not.toContain("\u001b[");
      expect(rows.every((r) => stringWidth(r) === 30)).toBe(true);
    } finally {
      chalk.level = 3;
    }
  });

  it("returns nothing for an empty sky", () => {
    expect(skyFrame(opts({ width: 0, height: 10 }))).toEqual([]);
    expect(skyFrame(opts({ width: 10, height: 0 }))).toEqual([]);
    expect(skyCells(opts({ width: -3, height: 2 }))).toEqual([]);
  });

  it("is fast enough for 8 fps on a big terminal", () => {
    const o = opts({ width: 200, height: 60, glass: [{ x: 0, y: 2, width: 200, height: 20, focused: true }, { x: 0, y: 23, width: 98, height: 36 }, { x: 101, y: 23, width: 99, height: 36 }] });
    skyFrame(o);
    const t0 = performance.now();
    for (let i = 0; i < 40; i++) skyFrame({ ...o, timeMs: i * 125 });
    const perFrame = (performance.now() - t0) / 40;
    // Generous bound for slow CI machines; locally it is well under a millisecond.
    expect(perFrame).toBeLessThan(25);
  });
});
