// The themes the app can use: the built-ins plus the custom ones saved as JSON files in the config
// dir's themes folder (one file per theme, "<name>.json"). It holds the active theme, tells
// listeners when it (or the list) changes, and is what the theme tools reach as a ThemeApi.
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../platform/files.js";
import type { ThemeApi } from "../tools/types.js";
import { BUILTIN_THEMES, DEFAULT_THEME_NAME, isBuiltinName } from "./builtin.js";
import type { Theme } from "./types.js";
import { parseTheme, slugifyThemeName, themeToJson } from "./validate.js";

/** What the theme picker lists. */
export interface ThemeListItem {
  name: string;
  label: string;
  dark: boolean;
  builtin: boolean;
}

/** A custom theme file that could not be used, and why. */
export interface ThemeProblem {
  file: string;
  error: string;
}

export interface ThemeManagerOptions {
  /** The folder with the custom themes (created on the first save). */
  dir: string;
  /** The theme to start with; unknown names fall back to "moon". */
  initial?: string;
  /** Called with the new theme whenever the active theme changes. */
  onChange?: (theme: Theme) => void;
}

/** Files larger than this are not themes. */
const MAX_FILE_BYTES = 256 * 1024;

interface CustomEntry {
  theme: Theme;
  file: string;
}

/** The theme a custom file wants as its base: `"base": "nord"` (default: moon). */
function baseOf(json: unknown): Theme {
  const wanted = typeof json === "object" && json !== null ? (json as { base?: unknown }).base : undefined;
  return (typeof wanted === "string" && BUILTIN_THEMES.find((t) => t.name === wanted)) || BUILTIN_THEMES[0];
}

export class ThemeManager {
  readonly dir: string;
  private readonly onChange?: (theme: Theme) => void;
  private readonly listeners = new Set<() => void>();
  private customs: CustomEntry[] = [];
  private currentTheme: Theme;
  private issues: ThemeProblem[] = [];

  constructor(opts: ThemeManagerOptions) {
    this.dir = opts.dir;
    this.onChange = opts.onChange;
    this.currentTheme = BUILTIN_THEMES[0];
    this.loadCustoms();
    this.currentTheme = (opts.initial && this.resolve(opts.initial)) || this.get(DEFAULT_THEME_NAME) || BUILTIN_THEMES[0];
  }

  /**
   * Re-reads the custom themes from `dir/*.json`. Invalid files are skipped (see `problems`). A
   * custom theme named like a built-in one is renamed "<name>-custom"; when two files claim the
   * same name, the file called "<name>.json" keeps it and the others get "-2", "-3", ...
   * If the active theme was custom, it is re-read (or falls back to "moon" when it is gone).
   */
  reload(): void {
    this.loadCustoms();
    const before = this.currentTheme;
    const next = this.get(before.name) ?? this.get(DEFAULT_THEME_NAME) ?? BUILTIN_THEMES[0];
    this.currentTheme = next;
    if (next !== before) this.onChange?.(next);
    this.emit();
  }

  /** Built-ins first (in their fixed order), then the custom themes by label. */
  list(): ThemeListItem[] {
    return [
      ...BUILTIN_THEMES.map((t) => ({ name: t.name, label: t.label, dark: t.dark, builtin: true })),
      ...this.customs.map(({ theme: t }) => ({ name: t.name, label: t.label, dark: t.dark, builtin: false })),
    ];
  }

  /** A theme by its exact name. The object is shared: treat it as read-only. */
  get(name: string): Theme | undefined {
    return BUILTIN_THEMES.find((t) => t.name === name) ?? this.customs.find((c) => c.theme.name === name)?.theme;
  }

  /** The active theme. The same object until the theme changes, so it is safe as a memo key. */
  get current(): Theme {
    return this.currentTheme;
  }

  /** Custom theme files that were skipped on the last (re)load. */
  get problems(): readonly ThemeProblem[] {
    return this.issues;
  }

  /**
   * Switches to a theme by name (exact, then case-insensitive name or label, then slug).
   * Returns false when there is no such theme. Switching to the active theme is a no-op (true).
   */
  set(name: string): boolean {
    const theme = this.resolve(name);
    if (!theme) return false;
    if (theme !== this.currentTheme) {
      this.currentTheme = theme;
      this.onChange?.(theme);
      this.emit();
    }
    return true;
  }

  /**
   * Validates and writes a custom theme to `dir/<name>.json` (creating `dir`), then reloads.
   * A built-in name is saved as "<name>-custom". With `apply`, the theme becomes the active one;
   * without, an active theme of the same name is still refreshed. Rejects when the theme is
   * invalid or the file can't be written.
   */
  async save(theme: Theme, apply: boolean): Promise<void> {
    const parsed = parseTheme(theme, BUILTIN_THEMES[0]);
    if ("error" in parsed) throw new Error(`Invalid theme: ${parsed.error}`);
    const t = parsed.theme;
    if (isBuiltinName(t.name)) t.name = `${t.name}-custom`;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${t.name}.json`);
    await writeFileAtomic(file, themeToJson(t));
    this.loadCustoms();
    const saved = this.customs.find((c) => path.resolve(c.file) === path.resolve(file))?.theme ?? this.get(t.name);
    const before = this.currentTheme;
    if (apply && saved) this.currentTheme = saved;
    else this.currentTheme = this.get(before.name) ?? this.get(DEFAULT_THEME_NAME) ?? BUILTIN_THEMES[0];
    if (this.currentTheme !== before) this.onChange?.(this.currentTheme);
    this.emit();
  }

  /**
   * Deletes a custom theme's file. Returns false for built-ins and unknown names. When it was the
   * active theme, the app goes back to "moon".
   */
  async remove(name: string): Promise<boolean> {
    const entry = this.customs.find((c) => c.theme.name === name);
    if (!entry) return false;
    await fs.promises.rm(entry.file, { force: true });
    this.reload();
    return true;
  }

  /** Calls `listener` after every change (active theme, list of themes). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The ThemeApi the theme tools use (with `get`, which `create_theme` uses to read a base). */
  api(): ThemeApi & { get(name: string): Theme | undefined } {
    return {
      list: () => this.list(),
      current: () => this.current,
      set: (name: string) => this.set(name),
      save: (theme: Theme, apply: boolean) => this.save(theme, apply),
      get: (name: string) => this.get(name),
    };
  }

  // ---- internals -------------------------------------------------------------------------------

  private resolve(name: string): Theme | undefined {
    const exact = this.get(name);
    if (exact) return exact;
    const wanted = name.trim().toLowerCase();
    if (!wanted) return undefined;
    const all = [...BUILTIN_THEMES, ...this.customs.map((c) => c.theme)];
    return (
      all.find((t) => t.name.toLowerCase() === wanted) ??
      all.find((t) => t.label.toLowerCase() === wanted) ??
      all.find((t) => t.name === slugifyThemeName(wanted))
    );
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the others.
      }
    }
  }

  private loadCustoms(): void {
    const problems: ThemeProblem[] = [];
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.toLowerCase().endsWith(".json"))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, "en"));
    } catch {
      files = [];
    }

    const parsed: Array<CustomEntry & { stem: string }> = [];
    for (const name of files) {
      const file = path.join(this.dir, name);
      const stem = name.slice(0, -".json".length);
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) {
          problems.push({ file, error: "the file is too large for a theme" });
          continue;
        }
        let json: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
        // A file without a name is named after the file.
        if (typeof json === "object" && json !== null && !Array.isArray(json)) {
          const obj = json as Record<string, unknown>;
          if (typeof obj.name !== "string" || !obj.name.trim()) json = { ...obj, name: stem };
        }
        const result = parseTheme(json, baseOf(json));
        if ("error" in result) problems.push({ file, error: result.error });
        else parsed.push({ theme: result.theme, file, stem: slugifyThemeName(stem) });
      } catch (err) {
        problems.push({ file, error: (err as Error).message });
      }
    }

    // A file named after its theme keeps the name on a clash.
    parsed.sort((a, b) => Number(b.stem === b.theme.name) - Number(a.stem === a.theme.name));
    const taken = new Set(BUILTIN_THEMES.map((t) => t.name));
    // Unchanged themes keep their object, so the active theme's identity survives a reload.
    const previous = new Map(this.customs.map((c) => [c.theme.name, c.theme]));
    const customs: CustomEntry[] = [];
    for (const entry of parsed) {
      let name = entry.theme.name;
      if (isBuiltinName(name)) name = `${name}-custom`;
      if (taken.has(name)) {
        let i = 2;
        while (taken.has(`${name}-${i}`)) i++;
        name = `${name}-${i}`;
      }
      taken.add(name);
      let theme = name === entry.theme.name ? entry.theme : { ...entry.theme, name };
      const old = previous.get(name);
      if (old && themeToJson(old) === themeToJson(theme)) theme = old;
      customs.push({ theme, file: entry.file });
    }
    customs.sort((a, b) => a.theme.label.localeCompare(b.theme.label, "en") || a.theme.name.localeCompare(b.theme.name, "en"));
    this.customs = customs;
    this.issues = problems;
  }
}

/**
 * The themes the app starts with: `initial` (the saved theme), or the `flag` (--theme) one for this
 * run. `unknown` is a flag that names no theme, so the app can say so; the saved theme stays then.
 */
export function startThemes(opts: ThemeManagerOptions & { flag?: string }): { themes: ThemeManager; unknown: string | null } {
  const themes = new ThemeManager(opts);
  const unknown = opts.flag !== undefined && !themes.set(opts.flag) ? opts.flag : null;
  return { themes, unknown };
}
