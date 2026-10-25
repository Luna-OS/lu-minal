// docs/themes.md (linked from the README) matches the code: every colour and sky setting, the
// built-in themes, and an example file that loads as it is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../../src/themes/builtin.js";
import type { ThemeSky } from "../../src/themes/types.js";
import { THEME_COLOR_KEYS, parseTheme } from "../../src/themes/validate.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FILE = path.join(ROOT, "docs", "themes.md");
const doc = () => fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

const SKY_KEYS: Array<keyof ThemeSky> = ["enabled", "stars", "glyphs", "density", "glass", "moon", "moonColor", "shootingStars", "shootingStarColor"];

describe("docs/themes.md", () => {
  it("exists", () => {
    expect(fs.existsSync(FILE)).toBe(true);
  });

  it("names every colour, every sky setting and every built-in theme", () => {
    const text = doc();
    for (const key of [...THEME_COLOR_KEYS, "agents"]) expect(text, key).toContain(`\`${key}\``);
    for (const key of SKY_KEYS) expect(text, key).toContain(`\`${key}\``);
    for (const t of BUILTIN_THEMES) expect(text, t.name).toContain(`\`${t.name}\``);
    for (const word of ["create_theme", "/theme", "lu-minal themes", "--theme", "%APPDATA%\\lu-minal\\themes", "~/.config/lu-minal/themes"]) {
      expect(text, word).toContain(word);
    }
  });

  it("has an example that loads as a theme", () => {
    const example = /```json\n([\s\S]*?)\n```/.exec(doc())?.[1];
    expect(example).toBeTruthy();
    const result = parseTheme(example!);
    expect("error" in result ? result.error : null).toBeNull();
  });
});
