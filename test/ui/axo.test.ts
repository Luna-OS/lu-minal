import chalk from "chalk";
import stringWidth from "string-width";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AXO_COLORS, AXO_FRAMES, AXO_HEIGHT, AXO_WIDTH, AXO_Z_COLOR, type AxoMood } from "../../src/ui/axo/frames.js";
import { AXO_COLUMNS, AXO_ROWS, BLINK_EVERY, DONE_TICKS, axoPose, liftFrame, renderAxo, renderAxoPose } from "../../src/ui/axo/render.js";
import { mixHex } from "../../src/themes/color.js";
import { columns, parseRow, stripAnsi } from "./ansi-helpers.js";

const BG = "#141030";
let level: typeof chalk.level;

beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = level;
});

describe("Axo's frames (ported from Moon Code)", () => {
  it("has every mood with the Moon Code frame counts", () => {
    expect(Object.keys(AXO_FRAMES).sort()).toEqual(["done", "idle", "sleep", "work"]);
    expect(AXO_FRAMES.idle).toHaveLength(2);
    expect(AXO_FRAMES.work).toHaveLength(2);
    expect(AXO_FRAMES.sleep).toHaveLength(1);
    expect(AXO_FRAMES.done).toHaveLength(1);
  });

  it("are 26 x 20 pixels of known colour keys", () => {
    for (const frames of Object.values(AXO_FRAMES)) {
      for (const frame of frames) {
        expect(frame).toHaveLength(AXO_HEIGHT);
        for (const row of frame) {
          expect(row).toHaveLength(AXO_WIDTH);
          for (const ch of row) expect(ch === "." || ch in AXO_COLORS, `pixel ${ch}`).toBe(true);
        }
      }
    }
  });

  it("keeps the exact pixels and palette", () => {
    // Eyes open with their light in idle, closed (lower lids only) in the blink frame.
    expect(AXO_FRAMES.idle[0][7]).toBe("..GGggWWWeEWWWWeEWWWggGG..");
    expect(AXO_FRAMES.idle[1][7]).toBe("..GGggWWWWWWWWWWWWWWggGG..");
    // The sleeping mouth is an outline; the moon on the laptop lid; the cheer's sparks.
    expect(AXO_FRAMES.sleep[0][10]).toBe("...G.OWWWWWWOOWWWWWWO.G...");
    expect(AXO_FRAMES.work[0][15]).toBe(".tTt...OLLLLLmLLLLOOWO....");
    expect(AXO_FRAMES.done[0][1]).toBe(".tTt..................tTt.");
    expect(AXO_COLORS).toMatchObject({ O: "#5b4f9e", W: "#fbf7f0", G: "#f6a8c8", E: "#1d1742", C: "#f7b89a", L: "#b9aefb", m: "#f4f1ff", t: "#7fe3c6" });
    expect(Object.keys(AXO_COLORS)).toHaveLength(14);
  });
});

describe("renderAxo", () => {
  it("is 10 rows of exactly 26 columns", () => {
    for (const frames of Object.values(AXO_FRAMES)) {
      for (const frame of frames) {
        const rows = renderAxo(frame, BG);
        expect(rows).toHaveLength(AXO_ROWS);
        expect(AXO_ROWS).toBe(10);
        for (const r of rows) expect(columns(r)).toBe(AXO_COLUMNS);
      }
    }
  });

  it("maps two pixel rows to one row of half blocks, transparent pixels showing the background", () => {
    const frame = AXO_FRAMES.idle[0];
    const rows = renderAxo(frame, BG).map(parseRow);
    // Row 0 = pixel rows 0 and 1: all transparent -> spaces on bg.
    for (const c of rows[0]) expect(c).toEqual({ char: " ", fg: null, bg: BG });
    for (let y = 0; y < AXO_ROWS; y++) {
      for (let x = 0; x < AXO_WIDTH; x++) {
        const top = frame[2 * y][x];
        const bottom = frame[2 * y + 1][x];
        const c = rows[y][x];
        if (top === "." && bottom === ".") expect(c).toEqual({ char: " ", fg: null, bg: BG });
        else if (bottom === ".") expect(c).toEqual({ char: "▀", fg: AXO_COLORS[top], bg: BG });
        else if (top === ".") expect(c).toEqual({ char: "▄", fg: AXO_COLORS[bottom], bg: BG });
        else expect(c).toEqual({ char: "▀", fg: AXO_COLORS[top], bg: AXO_COLORS[bottom] });
      }
    }
  });

  it("draws a silhouette without colours", () => {
    chalk.level = 0;
    try {
      const rows = renderAxo(AXO_FRAMES.idle[0], BG);
      expect(rows.join("")).not.toContain("\u001b[");
      expect(rows.every((r) => stringWidth(r) === 26)).toBe(true);
      expect(rows[1]).toBe(" ▀▄    ▄▄████████▄▄    ▄▀ ");
    } finally {
      chalk.level = 3;
    }
  });

  it("caches per frame and background", () => {
    const a = renderAxo(AXO_FRAMES.work[1], BG);
    expect(renderAxo(AXO_FRAMES.work[1], BG)).toBe(a);
    expect(renderAxo(AXO_FRAMES.work[1], "#0b0920")).not.toBe(a);
  });

  it("takes a custom palette", () => {
    const rows = renderAxo(["OO", ".."], BG, { O: "#ff0000" }).map(parseRow);
    expect(rows[0]).toEqual([
      { char: "▀", fg: "#ff0000", bg: BG },
      { char: "▀", fg: "#ff0000", bg: BG },
    ]);
  });
});

describe("liftFrame", () => {
  it("moves the frame up and fills transparent rows in below", () => {
    const frame = AXO_FRAMES.done[0];
    const up = liftFrame(frame, 1);
    expect(up).toHaveLength(AXO_HEIGHT);
    expect(up[0]).toBe(frame[1]);
    expect(up[AXO_HEIGHT - 1]).toBe(".".repeat(AXO_WIDTH));
    expect(liftFrame(frame, 0)).toBe(frame);
    expect(liftFrame(frame, 1)).toBe(up);
  });
});

describe("axoPose", () => {
  it("idles with a blink every ~4 s", () => {
    const frames = Array.from({ length: BLINK_EVERY * 2 }, (_, t) => axoPose("idle", t).frame);
    const blinks = frames.map((f, t) => (f === AXO_FRAMES.idle[1] ? t : -1)).filter((t) => t >= 0);
    expect(blinks).toEqual([BLINK_EVERY - 1, 2 * BLINK_EVERY - 1]);
    expect(axoPose("idle", 0).frame).toBe(AXO_FRAMES.idle[0]);
  });

  it("types while working: the two frames alternate every tick", () => {
    expect([0, 1, 2, 3].map((t) => axoPose("work", t).frame)).toEqual([AXO_FRAMES.work[0], AXO_FRAMES.work[1], AXO_FRAMES.work[0], AXO_FRAMES.work[1]]);
  });

  it("cheers with hops for ~2 s when done, then idles", () => {
    const poses = Array.from({ length: DONE_TICKS }, (_, t) => axoPose("done", t));
    expect(poses.every((p) => p.frame === AXO_FRAMES.done[0])).toBe(true);
    expect(poses.some((p) => p.lift === 1)).toBe(true);
    expect(poses.some((p) => p.lift === 0)).toBe(true);
    expect(axoPose("done", DONE_TICKS).frame).toBe(AXO_FRAMES.idle[0]);
    expect(axoPose("done", DONE_TICKS + 40).frame).toBe(AXO_FRAMES.idle[0]);
  });

  it("snores rising z's through empty cells while asleep", () => {
    const frame = AXO_FRAMES.sleep[0];
    const seen = new Set<string>();
    for (let t = 0; t < 24; t++) {
      const pose = axoPose("sleep", t);
      expect(pose.frame).toBe(frame);
      expect(pose.overlays.length).toBeGreaterThanOrEqual(1);
      expect(pose.overlays.length).toBeLessThanOrEqual(3);
      for (const o of pose.overlays) {
        expect(["z", "Z"]).toContain(o.char);
        expect(o.alpha).toBeGreaterThan(0);
        expect(o.alpha).toBeLessThanOrEqual(1);
        // Never on top of Axo: both pixels of that cell are transparent.
        expect(frame[o.y * 2][o.x]).toBe(".");
        expect(frame[o.y * 2 + 1][o.x]).toBe(".");
        seen.add(`${o.x},${o.y}`);
      }
      const cells = new Set(pose.overlays.map((o) => `${o.x},${o.y}`));
      expect(cells.size).toBe(pose.overlays.length);
    }
    // They rise: z's show up in more than one row over time.
    expect(new Set([...seen].map((k) => k.split(",")[1])).size).toBeGreaterThan(1);
  });

  it("stands still without animation", () => {
    for (const mood of ["idle", "work", "done", "sleep"] as AxoMood[]) {
      const a = axoPose(mood, 0, false);
      const b = axoPose(mood, 123, false);
      expect(b).toEqual(a);
      expect(a.lift).toBe(0);
      expect(a.frame).toBe(AXO_FRAMES[mood][0]);
    }
    expect(axoPose("sleep", 5, false).overlays).toEqual([{ x: 25, y: 0, char: "Z", alpha: 1 }]);
  });
});

describe("renderAxoPose", () => {
  it("draws the z's in sky blue faded toward the background, keeping 26 columns", () => {
    const pose = axoPose("sleep", 0, false);
    const rows = renderAxoPose(pose, BG);
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(columns(r)).toBe(26);
    const z = parseRow(rows[0])[25];
    expect(z).toEqual({ char: "Z", fg: AXO_Z_COLOR, bg: BG });
    const faded = renderAxoPose({ frame: AXO_FRAMES.sleep[0], lift: 0, overlays: [{ x: 24, y: 0, char: "z", alpha: 0.5 }] }, BG);
    expect(parseRow(faded[0])[24].fg).toBe(mixHex(BG, AXO_Z_COLOR, 0.5));
    // Other rows are the plain sprite.
    expect(rows.slice(1)).toEqual(renderAxo(AXO_FRAMES.sleep[0], BG).slice(1));
  });

  it("renders a hop one pixel higher", () => {
    const hop = renderAxoPose({ frame: AXO_FRAMES.done[0], lift: 1, overlays: [] }, BG);
    expect(hop).toEqual(renderAxo(liftFrame(AXO_FRAMES.done[0], 1), BG));
    expect(stripAnsi(hop.join("\n"))).not.toBe(stripAnsi(renderAxo(AXO_FRAMES.done[0], BG).join("\n")));
  });

  it("ignores overlays outside the sprite", () => {
    const rows = renderAxoPose({ frame: AXO_FRAMES.idle[0], lift: 0, overlays: [{ x: 40, y: 0, char: "z", alpha: 1 }, { x: 0, y: 12, char: "z", alpha: 1 }] }, BG);
    expect(rows).toEqual(renderAxo(AXO_FRAMES.idle[0], BG));
  });
});
