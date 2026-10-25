import { describe, expect, it } from "vitest";
import {
  buildTheme,
  createThemeTool,
  invalidColors,
  listThemesTool,
  normalizeColor,
  setThemeTool,
  slugifyThemeName,
  themeTools,
} from "../../src/tools/theme.js";
import type { ThemeApi } from "../../src/tools/types.js";
import { FakeThemes, makeCtx, moonTheme, services } from "./helpers.js";

function setup() {
  const themes = new FakeThemes();
  const ctx = makeCtx({ agentName: "luna", services: services({ themes }) });
  return { themes, ctx };
}

describe("theme helpers", () => {
  it("slugifies names", () => {
    expect(slugifyThemeName("Tokyo Night!")).toBe("tokyo-night");
    expect(slugifyThemeName("  Crème   Brûlée ")).toBe("creme-brulee");
    expect(slugifyThemeName("***")).toBe("");
    expect(slugifyThemeName("a".repeat(60))).toHaveLength(40);
  });

  it("normalizes colours", () => {
    expect(normalizeColor("#7FE3C6")).toBe("#7fe3c6");
    expect(normalizeColor("#abc")).toBe("#aabbcc");
    for (const bad of ["7fe3c6", "#7fe3c", "red", "rgb(1,2,3)", 12, null]) expect(normalizeColor(bad)).toBeNull();
  });

  it("finds broken colours in a theme", () => {
    const t = moonTheme();
    expect(invalidColors(t)).toEqual([]);
    t.colors.accent = "purple";
    t.colors.agents = ["#ffffff", "#12"];
    t.sky.moonColor = "#fff";
    expect(invalidColors(t)).toEqual(["colors.accent", "colors.agents[1]", "sky.moonColor"]);
  });

  it("merges partial colours and sky settings over a base", () => {
    const base = moonTheme();
    const built = buildTheme(base, {
      name: "Forest Night",
      colors: { accent: "#7FE3C6", agents: ["#111111", "#222"] },
      sky: { density: 3.5, moon: false, stars: ["#000000", "#ffffff"] },
      axo: false,
      author: "luna",
    });
    if ("errors" in built) throw new Error(built.errors.join("; "));
    expect(built.theme.name).toBe("forest-night");
    expect(built.theme.label).toBe("Forest Night");
    expect(built.theme.colors.accent).toBe("#7fe3c6");
    expect(built.theme.colors.agents).toEqual(["#111111", "#222222"]);
    expect(built.theme.colors.bg).toBe(base.colors.bg);
    expect(built.theme.sky).toMatchObject({ density: 3.5, moon: false, stars: ["#000000", "#ffffff"], glass: 0.25 });
    expect(built.theme.axo).toBe(false);
    expect(built.theme.author).toBe("luna");
    expect(built.changed).toEqual(["accent", "agents", "sky.density", "sky.moon", "sky.stars", "axo"]);
    // The base is untouched.
    expect(base.colors.accent).toBe("#b9aefb");
    expect(base.sky.moon).toBe(true);
  });

  it("decides dark or light from a new background", () => {
    const light = buildTheme(moonTheme(), { name: "paper", colors: { bg: "#fafaf5", text: "#111111" } });
    expect("theme" in light && light.theme.dark).toBe(false);
    const dark = buildTheme({ ...moonTheme(), dark: false }, { name: "ink", colors: { bg: "#050505" } });
    expect("theme" in dark && dark.theme.dark).toBe(true);
  });

  it("collects every error", () => {
    const res = buildTheme(moonTheme(), {
      name: "x",
      colors: { accent: "green", nope: "#000000", agents: "#fff" },
      sky: { glass: 2, moon: "yes", glyphs: [], comets: true },
    });
    expect("errors" in res && res.errors).toEqual([
      'colors.accent "green" is not "#rrggbb"',
      expect.stringContaining('unknown colour "nope"'),
      'colors.agents must be a list of "#rrggbb" colours',
      "sky.glass must be a number from 0 to 1",
      "sky.moon must be true or false",
      "sky.glyphs must be a list of one-character strings",
      expect.stringContaining('unknown sky setting "comets"'),
    ]);
  });
});

describe("theme tools", () => {
  it("are MCP tools without approvals", () => {
    for (const t of themeTools()) {
      expect(t.mcp).toBe(true);
      expect(t.risk).toBe("read");
    }
  });

  it("list_themes marks the current theme", async () => {
    const { ctx } = setup();
    const res = await listThemesTool.run({}, ctx);
    expect(res.content.split("\n")).toEqual(["moon (current) — Moon · dark · built-in", "moon-day — Moon Day · light · built-in"]);
    expect(res.display?.detail).toBe("2 themes");
  });

  it("set_theme switches by name or label and lists names when unknown", async () => {
    const { themes, ctx } = setup();
    expect((await setThemeTool.run({ name: "Moon Day" }, ctx)).content).toBe("Switched to Moon Day (moon-day).");
    expect(themes.currentName).toBe("moon-day");
    const miss = await setThemeTool.run({ name: "dracula" }, ctx);
    expect(miss.isError).toBe(true);
    expect(miss.content).toBe('There is no theme "dracula". Themes: moon, moon-day.');
  });

  it("create_theme builds on the current theme, saves and applies it", async () => {
    const { themes, ctx } = setup();
    const res = await createThemeTool.run({ name: "Mint Glow", colors: { accent: "#7fe3c6", borderFocus: "#7FE3C6" }, sky: { glass: 0.4 } }, ctx);
    expect(res.isError).toBeFalsy();
    expect(themes.saved).toHaveLength(1);
    const { theme, apply } = themes.saved[0];
    expect(apply).toBe(true);
    expect(theme).toMatchObject({ name: "mint-glow", label: "Mint Glow", dark: true, author: "luna" });
    expect(theme.colors.borderFocus).toBe("#7fe3c6");
    expect(theme.sky.glass).toBe(0.4);
    expect(themes.currentName).toBe("mint-glow");
    expect(res.content).toContain("changed accent, borderFocus, sky.glass");
    expect(res.display).toMatchObject({ target: "mint-glow", detail: "3 settings changed" });
  });

  it("create_theme can start from another theme without applying it", async () => {
    const { themes, ctx } = setup();
    const res = await createThemeTool.run({ name: "dawn", base: "moon-day", colors: { accent: "#ff8800" }, apply: false }, ctx);
    expect(res.isError).toBeFalsy();
    const saved = themes.saved[0];
    expect(saved.apply).toBe(false);
    expect(saved.theme.colors.bg).toBe("#f4f2ff");
    expect(saved.theme.dark).toBe(false);
    // The base was only borrowed: the app is back on the theme it was on.
    expect(themes.currentName).toBe("moon");
  });

  it("uses the ThemeApi's own get() when it has one", async () => {
    const themes = new FakeThemes();
    const withGet: ThemeApi = Object.assign(themes, {
      get: (name: string) => themes.themes.get(name)?.theme,
    });
    const ctx = makeCtx({ services: services({ themes: withGet }) });
    await createThemeTool.run({ name: "dusk", base: "moon-day" }, ctx);
    expect(themes.sets).toEqual([]);
    expect(themes.saved[0].theme.colors.bg).toBe("#f4f2ff");
  });

  it("refuses built-in names, unknown bases and bad colours", async () => {
    const { themes, ctx } = setup();
    expect((await createThemeTool.run({ name: "Moon" }, ctx)).content).toContain("built-in");
    expect((await createThemeTool.run({ name: "x", base: "dracula" }, ctx)).content).toContain("no theme");
    const bad = await createThemeTool.run({ name: "x", colors: { accent: "teal" } }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('colors.accent "teal" is not "#rrggbb"');
    expect((await createThemeTool.run({ name: "x", colors: ["#000000"] }, ctx)).isError).toBe(true);
    expect(themes.saved).toHaveLength(0);
  });
});
