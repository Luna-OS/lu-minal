// Turns untrusted JSON (a custom theme file, an agent's create_theme call) into a complete Theme:
// missing fields come from a base theme, colours must be "#rrggbb" (short "#rgb" is expanded),
// the name becomes a file-safe slug and numbers are clamped to sane ranges.
import stringWidth from "string-width";
import { defaultTheme } from "./builtin.js";
import { isDark, isHex, normalizeHex } from "./color.js";
import type { Theme, ThemeColors, ThemeSky } from "./types.js";

/** Every colour key of ThemeColors except the `agents` list, in display order. */
export const THEME_COLOR_KEYS = [
  "bg",
  "surface",
  "surfaceFocus",
  "popover",
  "border",
  "borderFocus",
  "text",
  "muted",
  "faint",
  "accent",
  "accent2",
  "claude",
  "success",
  "warning",
  "error",
  "diffAddBg",
  "diffAddFg",
  "diffDelBg",
  "diffDelFg",
  "selection",
  "selectionText",
  "tabActiveBg",
  "tabActiveFg",
] as const satisfies ReadonlyArray<Exclude<keyof ThemeColors, "agents">>;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** The sky's numeric ranges. */
export const SKY_LIMITS = {
  density: { min: 0, max: 20 },
  glass: { min: 0, max: 1 },
} as const;

/** Names Windows refuses as file names (with any extension). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * "Tokyo Night!" -> "tokyo-night": lower case ASCII letters, digits and dashes, at most 40
 * characters, safe as a file name on Windows, macOS and Linux. "" when nothing is left.
 */
export function slugifyThemeName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return WINDOWS_RESERVED.test(slug) ? `${slug}-theme` : slug;
}

/** "tokyo-night" -> "Tokyo Night". */
function labelFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function colorList(value: unknown, path: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty list of "#rrggbb" colours`);
    return null;
  }
  const out: string[] = [];
  value.forEach((c, i) => {
    const n = normalizeHex(c);
    if (n) out.push(n);
    else errors.push(`${path}[${i}] ${JSON.stringify(c)} is not "#rrggbb"`);
  });
  return out;
}

/** Keeps only glyphs that are exactly one terminal column wide (so the sky's rows never shift). */
export function singleColumnGlyphs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= 2 && stringWidth(g) === 1);
}

/**
 * Validates `json` (an object, or a JSON string) as a theme. Missing fields are filled from `base`
 * (default: the "moon" theme), so a file with just a name and two colours is a whole theme.
 * Errors (a colour that is not hex, a missing name, not an object) return `{ error }` listing
 * every problem; sky numbers out of range are clamped, unusable glyphs are dropped.
 */
export function parseTheme(json: unknown, base: Theme = defaultTheme()): { theme: Theme } | { error: string } {
  let input = json;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch (err) {
      return { error: `not valid JSON: ${(err as Error).message}` };
    }
  }
  if (!isObject(input)) return { error: "a theme must be a JSON object" };

  const errors: string[] = [];
  const rawName = typeof input.name === "string" ? input.name : typeof input.label === "string" ? input.label : "";
  const name = slugifyThemeName(rawName);
  if (!name) errors.push('"name" must contain letters or digits');
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 60) : rawName.trim() ? rawName.trim().slice(0, 60) : labelFromSlug(name);

  // ---- colours -------------------------------------------------------------------------------
  const colors: ThemeColors = { ...base.colors, agents: [...base.colors.agents] };
  if (input.colors !== undefined && !isObject(input.colors)) errors.push('"colors" must be an object');
  const rawColors = isObject(input.colors) ? input.colors : {};
  for (const key of THEME_COLOR_KEYS) {
    if (!(key in rawColors)) continue;
    const c = normalizeHex(rawColors[key]);
    if (c) colors[key] = c;
    else errors.push(`colors.${key} ${JSON.stringify(rawColors[key])} is not "#rrggbb"`);
  }
  if ("agents" in rawColors) {
    const list = colorList(rawColors.agents, "colors.agents", errors);
    if (list) colors.agents = list;
  }

  // ---- sky -----------------------------------------------------------------------------------
  const sky: ThemeSky = { ...base.sky, stars: [...base.sky.stars], glyphs: [...base.sky.glyphs] };
  if (input.sky !== undefined && !isObject(input.sky)) errors.push('"sky" must be an object');
  const rawSky = isObject(input.sky) ? input.sky : {};
  for (const key of ["enabled", "moon", "shootingStars"] as const) {
    if (!(key in rawSky)) continue;
    if (typeof rawSky[key] === "boolean") sky[key] = rawSky[key] as boolean;
    else errors.push(`sky.${key} must be true or false`);
  }
  if ("density" in rawSky) sky.density = clamp(rawSky.density, SKY_LIMITS.density.min, SKY_LIMITS.density.max, base.sky.density);
  if ("glass" in rawSky) sky.glass = clamp(rawSky.glass, SKY_LIMITS.glass.min, SKY_LIMITS.glass.max, base.sky.glass);
  for (const key of ["moonColor", "shootingStarColor"] as const) {
    if (!(key in rawSky)) continue;
    const c = normalizeHex(rawSky[key]);
    if (c) sky[key] = c;
    else errors.push(`sky.${key} ${JSON.stringify(rawSky[key])} is not "#rrggbb"`);
  }
  if ("stars" in rawSky) {
    const list = colorList(rawSky.stars, "sky.stars", errors);
    if (list) sky.stars = list;
  }
  if ("glyphs" in rawSky) {
    const glyphs = singleColumnGlyphs(rawSky.glyphs);
    if (glyphs.length) sky.glyphs = glyphs;
  }
  // The base itself may be a hand-made object; never hand out an unusable sky.
  if (!singleColumnGlyphs(sky.glyphs).length) sky.glyphs = [...defaultTheme().sky.glyphs];
  sky.density = clamp(sky.density, SKY_LIMITS.density.min, SKY_LIMITS.density.max, 1.6);
  sky.glass = clamp(sky.glass, SKY_LIMITS.glass.min, SKY_LIMITS.glass.max, 0.25);
  if (!errors.length) {
    for (const key of THEME_COLOR_KEYS) if (!isHex(colors[key])) errors.push(`colors.${key} is not "#rrggbb" (in the base theme)`);
    if (!colors.agents.length || !colors.agents.every(isHex)) errors.push('colors.agents is not a list of "#rrggbb" (in the base theme)');
    if (!sky.stars.length || !sky.stars.every(isHex)) errors.push('sky.stars is not a list of "#rrggbb" (in the base theme)');
    if (!isHex(sky.moonColor) || !isHex(sky.shootingStarColor)) errors.push("the sky's moon or shooting star colour is not \"#rrggbb\" (in the base theme)");
  }

  if (errors.length) return { error: errors.join("; ") };

  const dark = typeof input.dark === "boolean" ? input.dark : "bg" in rawColors ? isDark(colors.bg) : base.dark;
  const theme: Theme = {
    name,
    label,
    dark,
    colors,
    sky,
    axo: typeof input.axo === "boolean" ? input.axo : base.axo,
  };
  if (typeof input.author === "string" && input.author.trim()) theme.author = input.author.trim().slice(0, 60);
  return { theme };
}

/** A theme as the JSON file lu-minal writes (stable key order, two-space indent, final newline). */
export function themeToJson(theme: Theme): string {
  const colors: Record<string, unknown> = {};
  for (const key of THEME_COLOR_KEYS) colors[key] = theme.colors[key];
  colors.agents = [...theme.colors.agents];
  const s = theme.sky;
  const out: Record<string, unknown> = {
    name: theme.name,
    label: theme.label,
    dark: theme.dark,
    ...(theme.author ? { author: theme.author } : {}),
    axo: theme.axo,
    colors,
    sky: {
      enabled: s.enabled,
      stars: [...s.stars],
      glyphs: [...s.glyphs],
      density: s.density,
      glass: s.glass,
      moon: s.moon,
      moonColor: s.moonColor,
      shootingStars: s.shootingStars,
      shootingStarColor: s.shootingStarColor,
    },
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}
