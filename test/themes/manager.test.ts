import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_THEMES, builtinTheme } from "../../src/themes/builtin.js";
import { startThemes, ThemeManager } from "../../src/themes/manager.js";
import type { Theme } from "../../src/themes/types.js";
import { themeToJson } from "../../src/themes/validate.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-themes-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeTheme(file: string, json: unknown): void {
  fs.writeFileSync(path.join(dir, file), typeof json === "string" ? json : JSON.stringify(json, null, 2));
}

function custom(name: string, accent = "#7fe3c6"): Theme {
  return { ...structuredClone(builtinTheme("moon")!), name, label: name, author: "vega", colors: { ...builtinTheme("moon")!.colors, accent } };
}

describe("ThemeManager", () => {
  it("starts with moon and lists the built-ins when the folder doesn't exist", () => {
    const m = new ThemeManager({ dir: path.join(dir, "missing") });
    expect(m.current.name).toBe("moon");
    expect(m.list()).toHaveLength(BUILTIN_THEMES.length);
    expect(m.list().every((t) => t.builtin)).toBe(true);
    expect(m.list()[0]).toEqual({ name: "moon", label: "Moon", dark: true, builtin: true });
    expect(m.problems).toEqual([]);
  });

  it("starts with the initial theme, falling back to moon for unknown names", () => {
    expect(new ThemeManager({ dir, initial: "nord" }).current.name).toBe("nord");
    expect(new ThemeManager({ dir, initial: "Tokyo Night" }).current.name).toBe("tokyo-night");
    expect(new ThemeManager({ dir, initial: "no-such-theme" }).current.name).toBe("moon");
  });

  it("loads custom themes, skips invalid files and reports why", () => {
    writeTheme("forest.json", { name: "Forest", colors: { accent: "#7fe3c6", bg: "#06140c" } });
    writeTheme("broken.json", "{ not json");
    writeTheme("bad-colour.json", { name: "bad", colors: { bg: "green" } });
    writeTheme("notes.txt", "not a theme");
    writeTheme("array.json", [1, 2, 3]);
    const m = new ThemeManager({ dir, initial: "forest" });
    expect(m.current.name).toBe("forest");
    expect(m.current.colors.bg).toBe("#06140c");
    // Filled from moon.
    expect(m.current.colors.text).toBe("#fbf7f0");
    const customs = m.list().filter((t) => !t.builtin);
    expect(customs).toEqual([{ name: "forest", label: "Forest", dark: true, builtin: false }]);
    expect(m.problems.map((p) => path.basename(p.file)).sort()).toEqual(["array.json", "bad-colour.json", "broken.json"]);
    expect(m.problems.find((p) => p.file.endsWith("bad-colour.json"))?.error).toContain("colors.bg");
  });

  it("names a file without a name after the file, reads a BOM and honours a base", () => {
    writeTheme("Deep Sea.json", "﻿" + JSON.stringify({ base: "nord", colors: { accent: "#00ffcc" } }));
    const m = new ThemeManager({ dir });
    const t = m.get("deep-sea");
    expect(t).toBeDefined();
    expect(t!.colors.accent).toBe("#00ffcc");
    expect(t!.colors.surface).toBe(builtinTheme("nord")!.colors.surface);
  });

  it("renames a custom theme that clashes with a built-in name", () => {
    writeTheme("moon.json", { name: "moon", colors: { accent: "#ff0000" } });
    writeTheme("my-nord.json", { name: "Nord", colors: { accent: "#00ff00" } });
    const m = new ThemeManager({ dir });
    // The built-ins are untouched.
    expect(m.get("moon")).toBe(builtinTheme("moon"));
    expect(m.get("nord")!.colors.accent).toBe(builtinTheme("nord")!.colors.accent);
    expect(m.get("moon-custom")!.colors.accent).toBe("#ff0000");
    expect(m.get("nord-custom")!.colors.accent).toBe("#00ff00");
    expect(m.list().filter((t) => !t.builtin).map((t) => t.name).sort()).toEqual(["moon-custom", "nord-custom"]);
  });

  it("gives the file named after the theme the name when two files claim it", () => {
    writeTheme("aaa.json", { name: "ocean", colors: { accent: "#111111" } });
    writeTheme("ocean.json", { name: "ocean", colors: { accent: "#222222" } });
    const m = new ThemeManager({ dir });
    expect(m.get("ocean")!.colors.accent).toBe("#222222");
    expect(m.get("ocean-2")!.colors.accent).toBe("#111111");
  });

  it("switches themes by name, label or slug, and refuses unknown ones", () => {
    const onChange = vi.fn();
    const m = new ThemeManager({ dir, onChange });
    const listener = vi.fn();
    m.subscribe(listener);
    expect(m.set("dracula")).toBe(true);
    expect(m.current.name).toBe("dracula");
    expect(onChange).toHaveBeenLastCalledWith(builtinTheme("dracula"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(m.set("Gruvbox Dark")).toBe(true);
    expect(m.current.name).toBe("gruvbox-dark");
    expect(m.set("ROSE-PINE")).toBe(true);
    expect(m.current.name).toBe("rose-pine");
    expect(m.set("no-such")).toBe(false);
    expect(m.set("")).toBe(false);
    expect(m.current.name).toBe("rose-pine");
    // Switching to the active theme is a no-op.
    const calls = listener.mock.calls.length;
    expect(m.set("rose-pine")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("keeps the same current object between changes (safe as a memo key)", () => {
    const m = new ThemeManager({ dir, initial: "astra" });
    expect(m.current).toBe(m.current);
    expect(m.current).toBe(builtinTheme("astra"));
  });

  it("saves a theme as <name>.json, applies it and notifies", async () => {
    const onChange = vi.fn();
    const m = new ThemeManager({ dir: path.join(dir, "nested", "themes"), onChange });
    const listener = vi.fn();
    m.subscribe(listener);
    await m.save(custom("Forest Night"), true);
    const file = path.join(dir, "nested", "themes", "forest-night.json");
    expect(fs.existsSync(file)).toBe(true);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json.name).toBe("forest-night");
    expect(json.label).toBe("Forest Night");
    expect(json.author).toBe("vega");
    expect(m.current.name).toBe("forest-night");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalled();
    // No temp files are left behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(["forest-night.json"]);
    // A fresh manager reads it back.
    expect(new ThemeManager({ dir: path.dirname(file) }).get("forest-night")!.colors.accent).toBe("#7fe3c6");
  });

  it("saves without applying, and refreshes the active theme when it is the one saved", async () => {
    const m = new ThemeManager({ dir });
    await m.save(custom("ocean", "#0000ff"), false);
    expect(m.current.name).toBe("moon");
    expect(m.get("ocean")!.colors.accent).toBe("#0000ff");
    m.set("ocean");
    const before = m.current;
    await m.save(custom("ocean", "#00ffff"), false);
    expect(m.current.name).toBe("ocean");
    expect(m.current.colors.accent).toBe("#00ffff");
    expect(m.current).not.toBe(before);
  });

  it("keeps the active custom theme's object when an unrelated theme is saved", async () => {
    const onChange = vi.fn();
    const m = new ThemeManager({ dir, onChange });
    await m.save(custom("first"), true);
    const first = m.current;
    onChange.mockClear();
    await m.save(custom("second"), false);
    expect(m.current).toBe(first);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves a built-in name as <name>-custom", async () => {
    const m = new ThemeManager({ dir });
    await m.save(custom("nord", "#abcdef"), true);
    expect(fs.existsSync(path.join(dir, "nord-custom.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "nord.json"))).toBe(false);
    expect(m.current.name).toBe("nord-custom");
    expect(m.get("nord")).toBe(builtinTheme("nord"));
  });

  it("rejects an invalid theme without writing anything", async () => {
    const m = new ThemeManager({ dir });
    const bad = custom("bad");
    bad.colors.bg = "not a colour";
    await expect(m.save(bad, true)).rejects.toThrow(/colors\.bg/);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(m.current.name).toBe("moon");
  });

  it("reloads changed files and falls back to moon when the active one disappears", () => {
    writeTheme("lake.json", { name: "lake", colors: { accent: "#111111" } });
    const onChange = vi.fn();
    const m = new ThemeManager({ dir, initial: "lake", onChange });
    writeTheme("lake.json", { name: "lake", colors: { accent: "#222222" } });
    m.reload();
    expect(m.current.colors.accent).toBe("#222222");
    expect(onChange).toHaveBeenCalledTimes(1);
    fs.rmSync(path.join(dir, "lake.json"));
    m.reload();
    expect(m.current.name).toBe("moon");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("removes custom themes but never built-ins", async () => {
    const m = new ThemeManager({ dir });
    await m.save(custom("gone"), true);
    expect(await m.remove("moon")).toBe(false);
    expect(await m.remove("nope")).toBe(false);
    expect(await m.remove("gone")).toBe(true);
    expect(fs.existsSync(path.join(dir, "gone.json"))).toBe(false);
    expect(m.current.name).toBe("moon");
    expect(m.get("gone")).toBeUndefined();
  });

  it("unsubscribes, and one throwing listener doesn't stop the others", () => {
    const m = new ThemeManager({ dir });
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    const offA = m.subscribe(a);
    const offB = m.subscribe(b);
    m.set("nord");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
    m.set("moon");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("serves the ThemeApi the theme tools use", async () => {
    const m = new ThemeManager({ dir });
    const api = m.api();
    expect(api.list().map((t) => t.name)).toContain("catppuccin-mocha");
    expect(api.current().name).toBe("moon");
    expect(api.set("mono")).toBe(true);
    expect(api.current()).toBe(m.current);
    expect(api.get("dracula")).toBe(builtinTheme("dracula"));
    expect(api.get("nope")).toBeUndefined();
    await api.save(custom("via-api"), true);
    expect(m.current.name).toBe("via-api");
    expect(api.list().find((t) => t.name === "via-api")).toEqual({ name: "via-api", label: "via-api", dark: true, builtin: false });
  });

  it("lists custom themes after the built-ins, sorted by label", async () => {
    const m = new ThemeManager({ dir });
    writeTheme("zeta.json", { name: "zeta", label: "Zeta" });
    writeTheme("alpha.json", { name: "alpha", label: "Alpha" });
    writeTheme("mid.json", { name: "mid", label: "Mid", colors: { bg: "#ffffff" } });
    m.reload();
    const list = m.list();
    expect(list.slice(0, BUILTIN_THEMES.length).every((t) => t.builtin)).toBe(true);
    expect(list.slice(BUILTIN_THEMES.length).map((t) => t.label)).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(list.find((t) => t.name === "mid")!.dark).toBe(false);
    expect(themeToJson(m.get("alpha")!)).toContain('"name": "alpha"');
  });
});

describe("startThemes", () => {
  it("starts with the saved theme, or --theme's for this run", () => {
    expect(startThemes({ dir, initial: "nord" }).themes.current.name).toBe("nord");
    const flagged = startThemes({ dir, initial: "nord", flag: "Tokyo Night" });
    expect(flagged.themes.current.name).toBe("tokyo-night");
    expect(flagged.unknown).toBeNull();
  });

  it("names a --theme that is no theme and keeps the saved one", () => {
    const started = startThemes({ dir, initial: "nord", flag: "nope" });
    expect(started.unknown).toBe("nope");
    expect(started.themes.current.name).toBe("nord");
  });
});
