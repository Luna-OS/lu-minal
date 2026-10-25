import chalk from "chalk";
import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import stringWidth from "string-width";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_THEMES, STAR_GLYPHS, builtinTheme } from "../../src/themes/builtin.js";
import type { Theme } from "../../src/themes/types.js";
import { Axo, centerText } from "../../src/ui/components/Axo.js";
import {
  GAUGE_BAR,
  GAUGE_UNKNOWN,
  MOON_PHASES,
  MoonGauge,
  formatResetIn,
  gaugeColor,
  gaugeSegs,
  moonPhaseGlyph,
} from "../../src/ui/components/MoonGauge.js";
import { Sky } from "../../src/ui/components/Sky.js";
import { columns, parseRow, stripAnsi } from "./ansi-helpers.js";

const moon = builtinTheme("moon")!;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
let level: typeof chalk.level;

beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = level;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("every glyph the sky, Axo and the gauges draw is one column wide", () => {
  const glyphs = new Set<string>([
    ...STAR_GLYPHS,
    ...BUILTIN_THEMES.flatMap((t) => t.sky.glyphs),
    ...MOON_PHASES,
    GAUGE_BAR.filled,
    GAUGE_BAR.empty,
    GAUGE_UNKNOWN,
    "▀",
    "▄",
    "█",
    "z",
    "Z",
    "·",
  ]);
  for (const g of glyphs) {
    it(`${JSON.stringify(g)} (U+${g.codePointAt(0)!.toString(16).toUpperCase()})`, () => {
      expect(stringWidth(g)).toBe(1);
      // No emoji presentation (those are two columns in many terminals).
      expect(/\p{Emoji_Presentation}/u.test(g)).toBe(false);
    });
  }
});

describe("formatResetIn", () => {
  it.each([
    [-5000, "now"],
    [0, "now"],
    [59_000, "now"],
    [MIN, "1m"],
    [45 * MIN + 50_000, "45m"],
    [HOUR, "1h"],
    [2 * HOUR + 13 * MIN, "2h 13m"],
    [23 * HOUR + 59 * MIN, "23h 59m"],
    [24 * HOUR, "1d"],
    [3 * 24 * HOUR + 4 * HOUR + 30 * MIN, "3d 4h"],
    [Number.NaN, "now"],
  ])("%d ms -> %s", (ms, text) => {
    expect(formatResetIn(ms)).toBe(text);
  });
});

describe("gaugeColor and moonPhaseGlyph", () => {
  it("turn warning at 75 % and error at 90 %", () => {
    const c = moon.colors;
    expect(gaugeColor(0, moon)).toBe(c.success);
    expect(gaugeColor(0.749, moon)).toBe(c.success);
    expect(gaugeColor(0.75, moon)).toBe(c.warning);
    expect(gaugeColor(0.899, moon)).toBe(c.warning);
    expect(gaugeColor(0.9, moon)).toBe(c.error);
    expect(gaugeColor(1.4, moon)).toBe(c.error);
    expect(gaugeColor(Number.NaN, moon)).toBe(c.success);
  });

  it("fill the moon with the utilization", () => {
    expect([0, 0.1, 0.13, 0.3, 0.5, 0.7, 0.8, 0.9, 1, 2, -1].map(moonPhaseGlyph)).toEqual(["○", "○", "◔", "◔", "◑", "◕", "◕", "●", "●", "●", "○"]);
  });
});

describe("gaugeSegs", () => {
  const w = (segs: Array<{ text: string }>) => segs.reduce((n, s) => n + stringWidth(s.text), 0);
  const win = (utilization: number, resetIn: number | null = 2 * HOUR + 13 * MIN) => ({ utilization, resetsAt: resetIn == null ? null : NOW + resetIn });

  it("fills the width exactly in the full form, the bar scaling with it", () => {
    for (const width of [20, 28, 40, 60]) {
      const segs = gaugeSegs({ label: "session", window: win(0.42), theme: moon, width, now: NOW });
      expect(w(segs)).toBe(width);
    }
    const text = gaugeSegs({ label: "session", window: win(0.42), theme: moon, width: 40, now: NOW }).map((s) => s.text).join("");
    expect(text).toBe("◑ session ━━━━━━━────────── 42% · 2h 13m");
  });

  it("colours the bar success, warning at 75 % and error at 90 %", () => {
    const bar = (u: number) => gaugeSegs({ label: "week", window: win(u), theme: moon, width: 40, now: NOW }).find((s) => s.text.includes(GAUGE_BAR.filled))!;
    expect(bar(0.3).color).toBe(moon.colors.success);
    expect(bar(0.8).color).toBe(moon.colors.warning);
    expect(bar(0.95).color).toBe(moon.colors.error);
    const pct = gaugeSegs({ label: "week", window: win(0.95), theme: moon, width: 40, now: NOW }).find((s) => s.text === "95%")!;
    expect(pct.color).toBe(moon.colors.error);
    expect(pct.bold).toBe(true);
  });

  it("drops the reset time, then the label, when room runs out", () => {
    const text = (width: number) => gaugeSegs({ label: "session", window: win(0.42), theme: moon, width, now: NOW }).map((s) => s.text).join("");
    expect(text(24)).toBe("◑ session ━━━━────── 42%");
    expect(text(24).length).toBeLessThanOrEqual(24);
    expect(text(16)).toBe("◑ ━━━━────── 42%");
    for (let width = 1; width < 50; width++) expect(stringWidth(text(width))).toBeLessThanOrEqual(width);
  });

  it("caps the bar at 100 % and skips an unknown reset", () => {
    const segs = gaugeSegs({ label: "week", window: win(1.3, null), theme: moon, width: 30, now: NOW });
    const text = segs.map((s) => s.text).join("");
    expect(text).toContain("100%");
    expect(text).not.toContain("·");
    expect(text).not.toContain(GAUGE_BAR.empty);
  });

  it("has a compact form for the tab bar", () => {
    const text = (width: number, u = 0.42) => gaugeSegs({ label: "session", window: win(u), theme: moon, width, compact: true, now: NOW }).map((s) => s.text).join("");
    expect(text(24)).toBe("◑ session 42% 2h13m");
    expect(text(12)).toBe("◑ 42% 2h13m");
    expect(text(6)).toBe("◑ 42%");
    expect(text(3)).toBe("◑ 4");
    expect(text(24, 0)).toBe("○ session 0% 2h13m");
  });

  it("shows a muted dash for an unknown window", () => {
    const full = gaugeSegs({ label: "week", window: null, theme: moon, width: 28, now: NOW });
    expect(full.map((s) => s.text).join("")).toBe(`○ week ${GAUGE_BAR.empty.repeat(19)} –`);
    expect(w(full)).toBe(28);
    expect(full[full.length - 1].color).toBe(moon.colors.muted);
    const compact = gaugeSegs({ label: "week", window: null, theme: moon, width: 24, compact: true });
    expect(compact.map((s) => s.text).join("")).toBe("○ week –");
    expect(gaugeSegs({ label: "week", window: null, theme: moon, width: 4 }).map((s) => s.text).join("")).toBe("○ –");
    expect(gaugeSegs({ label: "x", window: null, theme: moon, width: 0 })).toEqual([]);
  });
});

describe("<MoonGauge>", () => {
  it("renders the gauge on the given background", () => {
    const { lastFrame, unmount } = render(<MoonGauge label="session" window={{ utilization: 0.8, resetsAt: NOW + 45 * MIN }} theme={moon} width={36} bg={moon.colors.surface} now={NOW} />);
    const frame = lastFrame()!;
    expect(stripAnsi(frame)).toBe("◕ session ━━━━━━━━━━━━━─── 80% · 45m");
    const cells = parseRow(frame);
    expect(cells.every((c) => c.bg === moon.colors.surface)).toBe(true);
    expect(cells.find((c) => c.char === "━")!.fg).toBe(moon.colors.warning);
    unmount();
  });

  it("keeps its box width in a row even when the compact text is shorter", () => {
    const { lastFrame, unmount } = render(
      <Box flexDirection="row">
        <MoonGauge label="session" window={{ utilization: 0.1, resetsAt: NOW + 3 * HOUR }} theme={moon} width={24} compact now={NOW} />
        <MoonGauge label="week" window={null} theme={moon} width={24} compact now={NOW} />
      </Box>,
    );
    const text = stripAnsi(lastFrame()!);
    expect(text.indexOf("○ week")).toBe(24);
    expect(text.startsWith("○ session 10% 3h")).toBe(true);
    unmount();
  });

  it("defaults to 28 columns", () => {
    const { lastFrame, unmount } = render(<MoonGauge label="week" window={{ utilization: 0.5, resetsAt: NOW + 3 * 24 * HOUR + 4 * HOUR }} theme={moon} now={NOW} />);
    expect(columns(lastFrame()!)).toBe(28);
    expect(stripAnsi(lastFrame()!)).toContain("50% · 3d 4h");
    unmount();
  });
});

describe("<Axo>", () => {
  it("renders 10 rows of 26 columns and a centred caption", () => {
    const { lastFrame, unmount } = render(<Axo mood="idle" bg={moon.colors.surface} caption="Ready when you are." captionColor={moon.colors.muted} animate={false} />);
    const lines = lastFrame()!.split("\n");
    expect(lines).toHaveLength(11);
    for (const l of lines) expect(columns(l)).toBe(26);
    expect(stripAnsi(lines[10])).toBe("   Ready when you are.    ");
    const caption = parseRow(lines[10]).find((c) => c.char === "R")!;
    expect(caption.fg).toBe(moon.colors.muted);
    expect(caption.bg).toBe(moon.colors.surface);
    unmount();
  });

  it("cuts a long caption to 26 columns and leaves the row out without one", () => {
    const long = render(<Axo mood="work" bg="#141030" caption="Refactoring the whole authentication layer" animate={false} />);
    const lines = long.lastFrame()!.split("\n");
    expect(lines).toHaveLength(11);
    expect(stripAnsi(lines[10])).toBe("Refactoring the whole aut…");
    long.unmount();
    const bare = render(<Axo mood="sleep" bg="#141030" animate={false} />);
    expect(bare.lastFrame()!.split("\n")).toHaveLength(10);
    expect(stripAnsi(bare.lastFrame()!.split("\n")[0])).toContain("Z");
    bare.unmount();
    expect(centerText("hi", 6)).toBe("  hi  ");
    expect(centerText("a\nb", 5)).toBe(" a b ");
  });

  it("shows another frame when the mood changes", () => {
    const { lastFrame, rerender, unmount } = render(<Axo mood="idle" bg="#141030" animate={false} />);
    const idle = lastFrame();
    rerender(<Axo mood="work" bg="#141030" animate={false} />);
    expect(lastFrame()).not.toBe(idle);
    rerender(<Axo mood="idle" bg="#141030" animate={false} />);
    expect(lastFrame()).toBe(idle);
    unmount();
  });

  it("types while working when animated", async () => {
    const { frames, unmount } = render(<Axo mood="work" bg="#141030" />);
    await sleep(700);
    unmount();
    expect(new Set(frames).size).toBeGreaterThanOrEqual(2);
  });
});

/** The Sky is an absolute child of the screen's root Box, which gives the screen its size. */
function Screen({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
  return (
    <Box width={width} height={height}>
      {children}
    </Box>
  );
}

describe("<Sky>", () => {
  const dense: Theme = { ...moon, sky: { ...moon.sky, density: 6 } };

  it("fills width x height with rows of the exact width, glass under the panels", () => {
    const glass = [{ x: 4, y: 3, width: 30, height: 6, focused: true }];
    const { lastFrame, unmount } = render(<Screen width={60} height={12}><Sky width={60} height={12} theme={moon} glass={glass} animate={false} /></Screen>);
    const lines = lastFrame()!.split("\n");
    expect(lines).toHaveLength(12);
    for (const l of lines) expect(columns(l)).toBe(60);
    expect(parseRow(lines[5])[10].bg).toBe(moon.colors.surfaceFocus);
    expect(parseRow(lines[10])[10].bg).toBe(moon.colors.bg);
    unmount();
  });

  it("stays still without animation and twinkles with it", async () => {
    const still = render(<Screen width={80} height={20}><Sky width={80} height={20} theme={dense} glass={[]} animate={false} fps={20} /></Screen>);
    await sleep(300);
    expect(new Set(still.frames).size).toBe(1);
    still.unmount();

    const live = render(<Screen width={80} height={20}><Sky width={80} height={20} theme={dense} glass={[]} fps={20} /></Screen>);
    await sleep(600);
    // (Frames after this are Ink clearing the screen on unmount.)
    const frames = [...live.frames];
    live.unmount();
    expect(new Set(frames).size).toBeGreaterThan(1);
    for (const f of frames) {
      const lines = f.split("\n");
      expect(lines).toHaveLength(20);
      for (const l of lines) expect(columns(l)).toBe(80);
    }
  });

  it("is a plain background when the theme has no sky", () => {
    const day = builtinTheme("moon-day")!;
    const { lastFrame, unmount } = render(<Screen width={30} height={4}><Sky width={30} height={4} theme={day} glass={[]} /></Screen>);
    for (const l of lastFrame()!.split("\n")) {
      expect(stripAnsi(l)).toBe(" ".repeat(30));
      expect(parseRow(l).every((c) => c.bg === day.colors.bg)).toBe(true);
    }
    unmount();
  });

  it("draws only the background and glass with enabled={false}", () => {
    const glass = [{ x: 2, y: 1, width: 10, height: 2 }];
    const { lastFrame, unmount } = render(<Screen width={30} height={4}><Sky width={30} height={4} theme={dense} glass={glass} enabled={false} /></Screen>);
    const lines = lastFrame()!.split("\n");
    expect(lines.every((l) => stripAnsi(l) === " ".repeat(30))).toBe(true);
    expect(parseRow(lines[1])[5].bg).toBe(moon.colors.surface);
    expect(parseRow(lines[3])[5].bg).toBe(moon.colors.bg);
    unmount();
  });

  it("survives a broken theme and renders nothing for an empty size", () => {
    const broken = { ...moon, colors: { ...moon.colors, bg: "nope" } } as Theme;
    const a = render(<Screen width={10} height={2}><Sky width={10} height={2} theme={broken} glass={[]} animate={false} /></Screen>);
    expect(a.lastFrame()!.split("\n")).toHaveLength(2);
    a.unmount();
    const b = render(<Screen width={10} height={1}><Sky width={0} height={5} theme={moon} glass={[]} /></Screen>);
    expect(stripAnsi(b.lastFrame()!).trim()).toBe("");
    b.unmount();
  });
});
