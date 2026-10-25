// The theme tools: agents can list lu-minal's themes, switch to one, or build a custom one from a
// base theme plus a few colours ("make it greener", "a light theme"). Custom themes are saved
// through the ThemeApi, which writes them to the config dir and can apply them right away.
import type { Theme, ThemeColors, ThemeSky } from "../themes/types.js";
import { defineTool, plural } from "./fs.js";
import type { ThemeApi, Tool, ToolResult } from "./types.js";

const HEX = /^#[0-9a-f]{6}$/;

function fail(content: string, detail?: string): ToolResult {
  return { content, isError: true, display: detail ? { detail } : undefined };
}

/** "Tokyo Night!" -> "tokyo-night". */
export function slugifyThemeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** A colour as "#rrggbb" (lower case), or null. "#ABC" is expanded. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return HEX.test(v) ? v : null;
}

/** Relative luminance of "#rrggbb" (0 black .. 1 white). */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

const COLOR_KEYS: Array<keyof ThemeColors> = [
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
  "agents",
];

const SKY_KEYS: Array<keyof ThemeSky> = [
  "enabled",
  "stars",
  "glyphs",
  "density",
  "glass",
  "moon",
  "moonColor",
  "shootingStars",
  "shootingStarColor",
];

/** Every colour of a theme that is not "#rrggbb", as "colors.bg" paths. */
export function invalidColors(theme: Theme): string[] {
  const bad: string[] = [];
  for (const key of COLOR_KEYS) {
    const v = theme.colors[key] as unknown;
    if (key === "agents") {
      if (!Array.isArray(v) || !v.length) bad.push("colors.agents");
      else v.forEach((c, i) => !HEX.test(String(c)) && bad.push(`colors.agents[${i}]`));
    } else if (!HEX.test(String(v))) {
      bad.push(`colors.${key}`);
    }
  }
  if (!Array.isArray(theme.sky.stars) || !theme.sky.stars.length) bad.push("sky.stars");
  else theme.sky.stars.forEach((c, i) => !HEX.test(String(c)) && bad.push(`sky.stars[${i}]`));
  if (!HEX.test(String(theme.sky.moonColor))) bad.push("sky.moonColor");
  if (!HEX.test(String(theme.sky.shootingStarColor))) bad.push("sky.shootingStarColor");
  return bad;
}

function colorList(value: unknown, key: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || !value.length) {
    errors.push(`${key} must be a list of "#rrggbb" colours`);
    return null;
  }
  const out: string[] = [];
  value.forEach((c, i) => {
    const n = normalizeColor(c);
    if (n) out.push(n);
    else errors.push(`${key}[${i}] ${JSON.stringify(c)} is not "#rrggbb"`);
  });
  return out;
}

/** The theme `create_theme` would save, or the errors in its input. */
export function buildTheme(
  base: Theme,
  input: { name: string; label?: string; colors?: Record<string, unknown>; sky?: Record<string, unknown>; axo?: boolean; author?: string },
): { theme: Theme; changed: string[] } | { errors: string[] } {
  const errors: string[] = [];
  const name = slugifyThemeName(input.name);
  if (!name) errors.push("name must contain letters or digits");
  const colors: ThemeColors = { ...base.colors, agents: [...base.colors.agents] };
  const sky: ThemeSky = { ...base.sky, stars: [...base.sky.stars], glyphs: [...base.sky.glyphs] };
  const changed: string[] = [];

  for (const [key, value] of Object.entries(input.colors ?? {})) {
    if (!COLOR_KEYS.includes(key as keyof ThemeColors)) {
      errors.push(`unknown colour "${key}" (known: ${COLOR_KEYS.join(", ")})`);
      continue;
    }
    if (key === "agents") {
      const list = colorList(value, "colors.agents", errors);
      if (list) colors.agents = list;
    } else {
      const c = normalizeColor(value);
      if (!c) {
        errors.push(`colors.${key} ${JSON.stringify(value)} is not "#rrggbb"`);
        continue;
      }
      (colors as unknown as Record<string, string>)[key] = c;
    }
    changed.push(key);
  }

  for (const [key, value] of Object.entries(input.sky ?? {})) {
    switch (key as keyof ThemeSky) {
      case "enabled":
      case "moon":
      case "shootingStars":
        if (typeof value !== "boolean") errors.push(`sky.${key} must be true or false`);
        else (sky as unknown as Record<string, unknown>)[key] = value;
        break;
      case "density":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 20) errors.push("sky.density must be a number from 0 to 20");
        else sky.density = value;
        break;
      case "glass":
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) errors.push("sky.glass must be a number from 0 to 1");
        else sky.glass = value;
        break;
      case "moonColor":
      case "shootingStarColor": {
        const c = normalizeColor(value);
        if (!c) errors.push(`sky.${key} ${JSON.stringify(value)} is not "#rrggbb"`);
        else sky[key as "moonColor" | "shootingStarColor"] = c;
        break;
      }
      case "stars": {
        const list = colorList(value, "sky.stars", errors);
        if (list) sky.stars = list;
        break;
      }
      case "glyphs":
        if (!Array.isArray(value) || !value.length || !value.every((g) => typeof g === "string" && g.length > 0 && g.length <= 2)) {
          errors.push("sky.glyphs must be a list of one-character strings");
        } else sky.glyphs = value as string[];
        break;
      default:
        errors.push(`unknown sky setting "${key}" (known: ${SKY_KEYS.join(", ")})`);
        continue;
    }
    changed.push(`sky.${key}`);
  }

  const theme: Theme = {
    name,
    label: input.label?.trim() || input.name.trim() || name,
    dark: input.colors && "bg" in input.colors && HEX.test(colors.bg) ? luminance(colors.bg) < 0.4 : base.dark,
    colors,
    sky,
    axo: typeof input.axo === "boolean" ? input.axo : base.axo,
    author: input.author,
  };
  if (typeof input.axo === "boolean" && input.axo !== base.axo) changed.push("axo");
  for (const bad of invalidColors(theme)) errors.push(`${bad} is not "#rrggbb" (in the base theme)`);
  return errors.length ? { errors } : { theme, changed };
}

/**
 * The full theme for `name`: the current theme when it matches, the API's own `get` when it has one,
 * or (as a last resort) by switching to it, reading it and switching back.
 */
function themeByName(api: ThemeApi, name: string): Theme | null {
  const current = api.current();
  if (!name || name === current.name) return current;
  const getter = (api as ThemeApi & { get?: (name: string) => Theme | null | undefined }).get;
  if (typeof getter === "function") return getter.call(api, name) ?? null;
  if (!api.list().some((t) => t.name === name)) return null;
  if (!api.set(name)) return null;
  const theme = api.current();
  api.set(current.name);
  return structuredClone(theme);
}

function findName(api: ThemeApi, wanted: string): string | null {
  const w = wanted.trim().toLowerCase();
  const list = api.list();
  const hit = list.find((t) => t.name.toLowerCase() === w) ?? list.find((t) => t.label.toLowerCase() === w) ?? list.find((t) => t.name === slugifyThemeName(w));
  return hit?.name ?? null;
}

function names(api: ThemeApi): string {
  return api.list().map((t) => t.name).join(", ");
}

export const listThemesTool = defineTool<Record<string, never>>({
  name: "list_themes",
  description: "Lists lu-minal's themes (built-in and custom) and marks the one in use.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  mcp: true,
  describe: () => ({ verb: "themes" }),
  async run(_args, ctx) {
    const api = ctx.services.themes;
    const current = api.current().name;
    const list = api.list();
    const lines = list.map(
      (t) => `${t.name}${t.name === current ? " (current)" : ""} — ${t.label} · ${t.dark ? "dark" : "light"} · ${t.builtin ? "built-in" : "custom"}`,
    );
    return { content: lines.join("\n") || "No themes.", display: { detail: plural(list.length, "theme") } };
  },
});

type SetThemeArgs = { name: string };

export const setThemeTool = defineTool<SetThemeArgs>({
  name: "set_theme",
  description: "Switches lu-minal to a theme by name (see list_themes). Use it when the user asks for another look.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The theme's name, e.g. \"moon\"." } },
    required: ["name"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: "theme", target: String(args.name ?? "") }),
  async run(args, ctx) {
    const api = ctx.services.themes;
    const wanted = String(args.name ?? "").trim();
    const name = wanted ? findName(api, wanted) : null;
    if (!name || !api.set(name)) return fail(`There is no theme "${wanted}". Themes: ${names(api)}.`, "unknown theme");
    const t = api.current();
    return { content: `Switched to ${t.label} (${t.name}).`, display: { target: t.name, detail: t.label } };
  },
});

type CreateThemeArgs = {
  name: string;
  label?: string;
  base?: string;
  colors?: Record<string, unknown>;
  sky?: Record<string, unknown>;
  axo?: boolean;
  apply?: boolean;
};

export const createThemeTool = defineTool<CreateThemeArgs>({
  name: "create_theme",
  description:
    "Creates (or updates) a custom theme from a base theme (default: the current one) and the colours " +
    "you change, saves it and, unless apply is false, switches to it. Colours are \"#rrggbb\". Colour " +
    "keys: " +
    COLOR_KEYS.join(", ") +
    " (agents is a list). Sky keys: " +
    SKY_KEYS.join(", ") +
    " (stars is a list of colours from faint to bright, glass 0..1 is how much the sky shines through the panels).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The theme's name (made file-safe: \"Forest Night\" -> \"forest-night\")." },
      label: { type: "string", description: "The name shown in the picker (default: name)." },
      base: { type: "string", description: "The theme to start from (default: the current theme)." },
      colors: { type: "object", description: "Colours to change, e.g. {\"accent\": \"#7fe3c6\", \"bg\": \"#0b0920\"}.", additionalProperties: true },
      sky: { type: "object", description: "Sky settings to change, e.g. {\"density\": 2, \"moon\": false}.", additionalProperties: true },
      axo: { type: "boolean", description: "Show Axo, the pixel axolotl." },
      apply: { type: "boolean", description: "Switch to the theme right away (default true)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: "new theme", target: slugifyThemeName(String(args.name ?? "")) || String(args.name ?? "") }),
  async run(args, ctx) {
    const api = ctx.services.themes;
    const rawName = String(args.name ?? "").trim();
    if (!rawName) return fail("create_theme needs a `name`.");
    const slug = slugifyThemeName(rawName);
    const existing = api.list().find((t) => t.name === slug);
    if (existing?.builtin) return fail(`"${slug}" is a built-in theme; pick another name for a custom theme.`, "built-in name");
    let base: Theme | null;
    if (args.base) {
      const baseName = findName(api, String(args.base));
      base = baseName ? themeByName(api, baseName) : null;
      if (!base) return fail(`There is no theme "${args.base}" to start from. Themes: ${names(api)}.`, "unknown base");
    } else {
      base = api.current();
    }
    const isObj = (v: unknown) => v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v));
    if (!isObj(args.colors)) return fail("`colors` must be an object like {\"accent\": \"#7fe3c6\"}.");
    if (!isObj(args.sky)) return fail("`sky` must be an object like {\"density\": 2}.");
    const built = buildTheme(base, {
      name: rawName,
      label: typeof args.label === "string" ? args.label : undefined,
      colors: args.colors,
      sky: args.sky,
      axo: typeof args.axo === "boolean" ? args.axo : undefined,
      author: ctx.agentName,
    });
    if ("errors" in built) return fail(`The theme was not saved:\n- ${built.errors.join("\n- ")}`, plural(built.errors.length, "error"));
    const apply = args.apply ?? true;
    await api.save(built.theme, apply);
    const what = built.changed.length ? `changed ${built.changed.join(", ")}` : "a copy";
    return {
      content: `Saved the theme ${built.theme.label} (${built.theme.name}) from ${base.name}: ${what}.${apply ? " It is in use now." : " Switch with set_theme."}`,
      display: { target: built.theme.name, detail: built.changed.length ? plural(built.changed.length, "setting") + " changed" : `copy of ${base.name}` },
    };
  },
});

/** The theme tools in the order the model sees them. */
export function themeTools(): Tool[] {
  return [listThemesTool, setThemeTool, createThemeTool];
}
