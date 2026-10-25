import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES, DEFAULT_THEME_NAME, MOON_PALETTE, builtinTheme, defaultTheme, isBuiltinName } from "../../src/themes/builtin.js";
import { contrast, isHex, mixHex } from "../../src/themes/color.js";
import type { ThemeColors } from "../../src/themes/types.js";
import { THEME_COLOR_KEYS, parseTheme } from "../../src/themes/validate.js";

const EXPECTED_NAMES = [
  "moon",
  "moon-day",
  "astra",
  "tokyo-night",
  "catppuccin-mocha",
  "dracula",
  "nord",
  "gruvbox-dark",
  "rose-pine",
  "mono",
];

// Every key ThemeColors has, checked against a literal so a new key in the contract fails here.
const ALL_COLOR_KEYS: Array<keyof ThemeColors> = [...THEME_COLOR_KEYS, "agents"];

describe("the built-in themes", () => {
  it("are the expected set, moon first and the default", () => {
    expect(BUILTIN_THEMES.map((t) => t.name)).toEqual(EXPECTED_NAMES);
    expect(DEFAULT_THEME_NAME).toBe("moon");
    expect(defaultTheme().name).toBe("moon");
    expect(builtinTheme("nord")?.label).toBe("Nord");
    expect(builtinTheme("nope")).toBeUndefined();
    expect(isBuiltinName("dracula")).toBe(true);
    expect(isBuiltinName("dracula-custom")).toBe(false);
  });

  it("have unique, file-safe names and labels", () => {
    expect(new Set(BUILTIN_THEMES.map((t) => t.name)).size).toBe(BUILTIN_THEMES.length);
    expect(new Set(BUILTIN_THEMES.map((t) => t.label)).size).toBe(BUILTIN_THEMES.length);
    for (const t of BUILTIN_THEMES) expect(t.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  for (const theme of BUILTIN_THEMES) {
    describe(theme.name, () => {
      it("is complete: every colour is #rrggbb, agents and stars are non-empty", () => {
        const keys = Object.keys(theme.colors).sort();
        expect(keys).toEqual([...ALL_COLOR_KEYS].sort());
        for (const key of THEME_COLOR_KEYS) expect(isHex(theme.colors[key]), `${theme.name} colors.${key}`).toBe(true);
        expect(theme.colors.agents.length).toBeGreaterThanOrEqual(6);
        for (const c of theme.colors.agents) expect(isHex(c)).toBe(true);
        expect(theme.sky.stars.length).toBeGreaterThanOrEqual(3);
        for (const c of theme.sky.stars) expect(isHex(c)).toBe(true);
        expect(isHex(theme.sky.moonColor)).toBe(true);
        expect(isHex(theme.sky.shootingStarColor)).toBe(true);
        expect(typeof theme.sky.enabled).toBe("boolean");
        expect(typeof theme.sky.moon).toBe("boolean");
        expect(typeof theme.sky.shootingStars).toBe("boolean");
        expect(theme.sky.density).toBeGreaterThan(0);
        expect(theme.sky.density).toBeLessThanOrEqual(6);
        expect(theme.sky.glass).toBeGreaterThanOrEqual(0);
        expect(theme.sky.glass).toBeLessThanOrEqual(1);
        expect(theme.author).toBe("lu-minal");
        expect(typeof theme.axo).toBe("boolean");
      });

      it("only uses star glyphs one terminal column wide", () => {
        expect(theme.sky.glyphs.length).toBeGreaterThan(0);
        for (const g of theme.sky.glyphs) expect(stringWidth(g), JSON.stringify(g)).toBe(1);
      });

      it("is readable (WCAG contrast)", () => {
        const c = theme.colors;
        const check = (fg: string, bg: string, min: number, what: string) =>
          expect(contrast(fg, bg), `${theme.name}: ${what} ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        for (const bg of [c.bg, c.surface, c.surfaceFocus, c.popover]) {
          check(c.text, bg, 7, "text");
          check(c.muted, bg, 4.5, "muted");
          check(c.faint, bg, 2.8, "faint");
          check(c.accent, bg, 4.5, "accent");
          check(c.accent2, bg, 4.5, "accent2");
          check(c.claude, bg, 4.5, "claude");
          for (const k of ["success", "warning", "error"] as const) check(c[k], bg, 3, k);
        }
        check(c.diffAddFg, c.diffAddBg, 4.5, "diff add");
        check(c.diffDelFg, c.diffDelBg, 4.5, "diff del");
        check(c.selectionText, c.selection, 4.5, "selection");
        check(c.tabActiveFg, c.tabActiveBg, 4.5, "active tab");
        check(c.borderFocus, c.surface, 1.8, "focused border");
        expect(contrast(c.border, c.surface)).toBeGreaterThan(1.15);
        for (const a of c.agents) check(a, c.surface, 3, "agent");
      });

      it("tells focused glass from plain glass, and dark from light", () => {
        expect(theme.colors.surfaceFocus).not.toBe(theme.colors.surface);
        expect(theme.colors.surface).not.toBe(theme.colors.bg);
        expect(theme.colors.border).not.toBe(theme.colors.borderFocus);
        const bgLum = contrast(theme.colors.bg, "#000000");
        if (theme.dark) expect(bgLum).toBeLessThan(2);
        else expect(bgLum).toBeGreaterThan(10);
      });

      it("survives a round trip through parseTheme unchanged", () => {
        const parsed = parseTheme(structuredClone(theme));
        expect("theme" in parsed && parsed.theme).toEqual(theme);
      });
    });
  }
});

describe("moon keeps the Moon family palette", () => {
  const moon = builtinTheme("moon")!;
  const c = moon.colors;

  it("uses the tokens.css values", () => {
    expect(c.bg).toBe("#0b0920");
    expect(c.surface).toBe("#141030");
    expect(c.surfaceFocus).toBe("#1d1742");
    expect(c.popover).toBe("#181338");
    expect(c.text).toBe("#fbf7f0");
    expect(c.accent).toBe("#d6cffd");
    expect(c.accent2).toBe("#9ad7f5");
    expect(c.claude).toBe("#7fe3c6");
    expect(c.success).toBe("#7fe3c6");
    expect(c.warning).toBe("#f3c766");
    expect(c.error).toBe("#e5626b");
    expect(c.selection).toBe("#3b2e6b");
    expect(c.tabActiveBg).toBe("#3b2e6b");
    expect(c.tabActiveFg).toBe("#f4f1ff");
    expect(c.diffAddFg).toBe("#d8fff2");
    expect(c.diffDelFg).toBe("#ffd6dc");
  });

  it("derives borders and muted text with color-mix over the night", () => {
    expect(c.border).toBe(mixHex(MOON_PALETTE.night900, MOON_PALETTE.lavender400, 0.18));
    expect(c.borderFocus).toBe(mixHex(MOON_PALETTE.night900, MOON_PALETTE.lavender400, 0.36));
    expect(c.muted).toBe(mixHex(MOON_PALETTE.night900, MOON_PALETTE.cream100, 0.62));
    expect(c.faint).toBe(mixHex(MOON_PALETTE.night900, MOON_PALETTE.cream100, 0.4));
  });

  it("starts its agent colours with lavender, sky, mint, peach, gold and Axo's pink", () => {
    expect(c.agents.slice(0, 7)).toEqual(["#b9aefb", "#9ad7f5", "#7fe3c6", "#f7b89a", "#f3c766", "#f6a8c8", "#d6cffd"]);
  });

  it("has the glass night sky with moon and shooting stars", () => {
    expect(moon.sky).toMatchObject({ enabled: true, density: 1.6, glass: 0.25, moon: true, moonColor: "#f4f1ff", shootingStars: true, shootingStarColor: "#d6cffd" });
    expect(moon.sky.stars[0]).toBe("#3b2e6b");
    expect(moon.sky.stars[moon.sky.stars.length - 1]).toBe("#f4f1ff");
    expect(moon.axo).toBe(true);
  });

  it("moon-day is light with the sky off, astra has the bright diff rows", () => {
    const day = builtinTheme("moon-day")!;
    expect(day.dark).toBe(false);
    expect(day.sky.enabled).toBe(false);
    expect(day.axo).toBe(true);
    expect(day.colors.bg).toBe("#f5f2fb");
    expect(day.colors.text).toBe("#1c1733");
    const astra = builtinTheme("astra")!;
    expect(astra.colors).toMatchObject({ bg: "#0a1220", surface: "#0e1726", accent: "#56d4dd", diffAddBg: "#1e6b2e", diffAddFg: "#eaffea", diffDelBg: "#7a1f1f" });
  });
});
