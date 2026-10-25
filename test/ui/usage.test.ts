import { describe, expect, it } from "vitest";
import { barSegs, formatResetAt, formatWindow } from "../../src/ui/dialogs/usage.js";
import { BUILTIN_THEMES } from "../../src/themes/builtin.js";

const theme = BUILTIN_THEMES[0];

describe("usage view helpers", () => {
  it("formats context windows like the Claude app", () => {
    expect(formatWindow(1_000_000)).toBe("1M");
    expect(formatWindow(1_048_576)).toBe("1M");
    expect(formatWindow(1_500_000)).toBe("1.5M");
    expect(formatWindow(262_144)).toBe("262k");
    expect(formatWindow(900)).toBe("900");
  });

  it("says when a limit resets", () => {
    const now = new Date(2026, 9, 25, 12, 0).getTime();
    expect(formatResetAt(now + (4 * 60 + 56) * 60_000, now)).toBe("in 4h 56m");
    expect(formatResetAt(now + 30 * 60_000, now)).toBe("in 30m");
    expect(formatResetAt(now - 1, now)).toBe("now");
    const friday = new Date(2026, 9, 30, 1, 0).getTime();
    expect(formatResetAt(friday, now)).toBe("Fri 01:00");
  });

  it("draws bars of the exact width, coloured by how full they are", () => {
    const width = (segs: Array<{ text: string }>) => segs.reduce((n, s) => n + s.text.length, 0);
    expect(width(barSegs(0.25, 40, theme))).toBe(40);
    expect(barSegs(0.25, 40, theme)[0].text.length).toBe(10);
    expect(barSegs(0.001, 40, theme)[0].text.length).toBe(1);
    expect(barSegs(0, 40, theme)[0].text.length).toBe(0);
    expect(barSegs(0.8, 40, theme)[0].color).toBe(theme.colors.warning);
    expect(barSegs(0.95, 40, theme)[0].color).toBe(theme.colors.error);
  });
});
