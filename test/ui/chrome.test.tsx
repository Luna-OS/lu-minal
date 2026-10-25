// The toasts in the top right corner: long ones wrap (up to three lines) instead of losing their end.
import chalk from "chalk";
import { Box } from "ink";
import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Toast } from "../../src/core/hub.js";
import { builtinTheme } from "../../src/themes/builtin.js";
import { Toasts } from "../../src/ui/components/Chrome.js";
import { parseRow } from "./ansi-helpers.js";
import { renderAt } from "./ink-helpers.js";

const moon = builtinTheme("moon")!;
let level: typeof chalk.level;
beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = level;
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function show(toasts: Toast[], width: number) {
  const r = renderAt(
    <Box width={width} height={20}>
      <Toasts toasts={toasts} theme={moon} width={width} />
    </Box>,
    { columns: width, rows: 20 },
  );
  cleanups.push(r.unmount);
  const raw = () => r.stdout.frames.at(-1)!.split("\n");
  /** The toast rows, as text. */
  const rows = () => r.screen().split("\n").filter((l) => l.trim());
  return { ...r, raw, rows };
}

const toast = (text: string, level: Toast["level"] = "warning"): Toast => ({ id: `t${text.length}`, text, level, at: 0 });
const squeeze = (s: string) => s.replace(/\s+/g, "");

const MISSING = "No such file: /tmp/some/rather/long/folder/name/that/goes/on/and/on/nope-missing-file.png";
const TRUSTED = "Trusted proj: Claude Code agents load its .claude settings, CLAUDE.md and .mcp.json servers.";

describe("<Toasts>", () => {
  it("shows a long toast whole on a wide terminal", () => {
    const r = show([toast(MISSING), toast(TRUSTED)], 200);
    const text = r.rows().join("\n");
    expect(text).toContain(MISSING);
    expect(text).toContain(TRUSTED);
  });

  it("wraps it on a narrow one, every row the same width on the popover colour", () => {
    const r = show([toast(MISSING)], 80);
    const rows = r.rows();
    // "No such file:", then the path split over two lines.
    expect(rows.length).toBe(3);
    expect(squeeze(rows.join(""))).toContain(squeeze(MISSING));
    const painted = r.raw().map((l) => parseRow(l).filter((cell) => cell.bg !== null)).filter((cells) => cells.length);
    expect(painted.map((cells) => cells.length)).toEqual([64, 64, 64]);
    expect(painted.flat().every((cell) => cell.bg === moon.colors.popover)).toBe(true);
  });

  it("stops after three lines with an ellipsis", () => {
    const r = show([toast(`${"word ".repeat(80)}end`)], 80);
    const rows = r.rows();
    expect(rows.length).toBe(3);
    expect(rows[2].trimEnd()).toMatch(/…$/);
  });
});
