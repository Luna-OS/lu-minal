import { describe, expect, it } from "vitest";
import { builtinTheme, defaultTheme } from "../../src/themes/builtin.js";
import type { Theme } from "../../src/themes/types.js";
import { parseTheme, singleColumnGlyphs, slugifyThemeName, themeToJson } from "../../src/themes/validate.js";

function ok(result: ReturnType<typeof parseTheme>): Theme {
  if ("error" in result) throw new Error(`expected a theme, got: ${result.error}`);
  return result.theme;
}

function err(result: ReturnType<typeof parseTheme>): string {
  if (!("error" in result)) throw new Error("expected an error");
  return result.error;
}

describe("slugifyThemeName", () => {
  it("makes file-safe slugs", () => {
    expect(slugifyThemeName("Tokyo Night!")).toBe("tokyo-night");
    expect(slugifyThemeName("  Forest -- Night  ")).toBe("forest-night");
    expect(slugifyThemeName("Rosé Pine")).toBe("rose-pine");
    expect(slugifyThemeName("../../etc/passwd")).toBe("etc-passwd");
    expect(slugifyThemeName("C:\\themes\\x")).toBe("c-themes-x");
    expect(slugifyThemeName("???")).toBe("");
    expect(slugifyThemeName("a".repeat(80))).toHaveLength(40);
  });

  it("avoids names Windows reserves", () => {
    expect(slugifyThemeName("CON")).toBe("con-theme");
    expect(slugifyThemeName("nul")).toBe("nul-theme");
    expect(slugifyThemeName("com1")).toBe("com1-theme");
    expect(slugifyThemeName("console")).toBe("console");
  });
});

describe("parseTheme", () => {
  it("fills every missing field from the base (moon by default)", () => {
    const t = ok(parseTheme({ name: "Forest Night", colors: { accent: "#7FE3C6", bg: "#0a1a10" } }));
    const moon = defaultTheme();
    expect(t.name).toBe("forest-night");
    expect(t.label).toBe("Forest Night");
    expect(t.colors.accent).toBe("#7fe3c6");
    expect(t.colors.bg).toBe("#0a1a10");
    expect(t.colors.surface).toBe(moon.colors.surface);
    expect(t.colors.agents).toEqual(moon.colors.agents);
    expect(t.colors.agents).not.toBe(moon.colors.agents);
    expect(t.sky).toEqual(moon.sky);
    expect(t.axo).toBe(true);
    // dark follows the new background.
    expect(t.dark).toBe(true);
  });

  it("uses another base when given", () => {
    const nord = builtinTheme("nord")!;
    const t = ok(parseTheme({ name: "my nord", sky: { moon: false } }, nord));
    expect(t.colors).toEqual(nord.colors);
    expect(t.sky.moon).toBe(false);
    expect(t.sky.stars).toEqual(nord.sky.stars);
  });

  it("derives dark from a light bg, or takes it as given", () => {
    expect(ok(parseTheme({ name: "paper", colors: { bg: "#fafafa" } })).dark).toBe(false);
    expect(ok(parseTheme({ name: "paper", dark: true, colors: { bg: "#fafafa" } })).dark).toBe(true);
    expect(ok(parseTheme({ name: "x" }, builtinTheme("moon-day"))).dark).toBe(false);
  });

  it("expands short hex and lower-cases colours", () => {
    const t = ok(parseTheme({ name: "x", colors: { text: "#FFF", agents: ["#ABC", "#123456"] }, sky: { stars: ["#000", "#FFFFFF"] } }));
    expect(t.colors.text).toBe("#ffffff");
    expect(t.colors.agents).toEqual(["#aabbcc", "#123456"]);
    expect(t.sky.stars).toEqual(["#000000", "#ffffff"]);
  });

  it("lists every invalid colour", () => {
    const e = err(parseTheme({ name: "x", colors: { bg: "black", accent: "#12345", agents: ["#fff", "pink"] }, sky: { moonColor: 7 } }));
    expect(e).toContain('colors.bg "black"');
    expect(e).toContain('colors.accent "#12345"');
    expect(e).toContain("colors.agents[1]");
    expect(e).toContain("sky.moonColor");
  });

  it("rejects empty lists, wrong types and non-objects", () => {
    expect(err(parseTheme({ name: "x", colors: { agents: [] } }))).toContain("colors.agents");
    expect(err(parseTheme({ name: "x", sky: { stars: "#ffffff" } }))).toContain("sky.stars");
    expect(err(parseTheme({ name: "x", sky: { enabled: "yes" } }))).toContain("sky.enabled");
    expect(err(parseTheme({ name: "x", colors: [] }))).toContain('"colors"');
    expect(err(parseTheme(["moon"]))).toContain("object");
    expect(err(parseTheme(null))).toContain("object");
    expect(err(parseTheme(42))).toContain("object");
  });

  it("needs a name with letters or digits, and falls back to the label", () => {
    expect(err(parseTheme({ colors: {} }))).toContain("name");
    expect(err(parseTheme({ name: "!!!" }))).toContain("name");
    const t = ok(parseTheme({ label: "Deep Sea" }));
    expect(t.name).toBe("deep-sea");
    expect(t.label).toBe("Deep Sea");
    expect(ok(parseTheme({ name: "deep-sea" })).label).toBe("deep-sea");
  });

  it("parses a JSON string and reports broken JSON", () => {
    expect(ok(parseTheme('{"name":"from string","colors":{"accent":"#ff00aa"}}')).colors.accent).toBe("#ff00aa");
    expect(err(parseTheme("{name: oops"))).toMatch(/JSON/);
  });

  it("clamps sky numbers and ignores non-numbers", () => {
    const moon = defaultTheme();
    const t = ok(parseTheme({ name: "x", sky: { density: 99, glass: -2 } }));
    expect(t.sky.density).toBe(20);
    expect(t.sky.glass).toBe(0);
    const u = ok(parseTheme({ name: "x", sky: { density: "lots", glass: Number.NaN } }));
    expect(u.sky.density).toBe(moon.sky.density);
    expect(u.sky.glass).toBe(moon.sky.glass);
  });

  it("keeps only one-column glyphs and falls back when none are left", () => {
    const t = ok(parseTheme({ name: "x", sky: { glyphs: ["*", "⭐", "漢", "", 3, "+"] } }));
    expect(t.sky.glyphs).toEqual(["*", "+"]);
    const u = ok(parseTheme({ name: "x", sky: { glyphs: ["⭐", "🌙"] } }));
    expect(u.sky.glyphs).toEqual(defaultTheme().sky.glyphs);
    expect(singleColumnGlyphs(["·", "✦", "🌟", "ab"])).toEqual(["·", "✦"]);
  });

  it("ignores unknown keys and keeps a short author", () => {
    const t = ok(parseTheme({ name: "x", whatever: 1, colors: { notAColour: "#fff" }, author: "  vega  " }));
    expect(t.author).toBe("vega");
    expect(Object.keys(t.colors)).not.toContain("notAColour");
    expect("whatever" in t).toBe(false);
  });

  it("refuses a base with broken colours instead of passing them on", () => {
    const broken = structuredClone(defaultTheme());
    broken.colors.surface = "dark blue";
    expect(err(parseTheme({ name: "x" }, broken))).toContain("colors.surface");
    expect(ok(parseTheme({ name: "x", colors: { surface: "#101010" } }, broken)).colors.surface).toBe("#101010");
  });
});

describe("themeToJson", () => {
  it("writes stable, parseable JSON that reads back as the same theme", () => {
    const t = ok(parseTheme({ name: "Round Trip", author: "luna", colors: { accent: "#7fe3c6" } }));
    const json = themeToJson(t);
    expect(json.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(json))).toEqual(["name", "label", "dark", "author", "axo", "colors", "sky"]);
    expect(ok(parseTheme(JSON.parse(json)))).toEqual(t);
    expect(themeToJson(t)).toBe(json);
  });

  it("leaves out a missing author", () => {
    const json = JSON.parse(themeToJson(defaultTheme()));
    expect(json.author).toBe("lu-minal");
    const anon = { ...defaultTheme(), author: undefined };
    expect("author" in JSON.parse(themeToJson(anon))).toBe(false);
  });
});
