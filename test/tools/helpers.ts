// Test helpers for the tools: temp project folders, a ToolContext without an agent, and fake
// theme / Roblox services.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRole, PermissionMode } from "../../src/core/types.js";
import type { RobloxApi } from "../../src/roblox/types.js";
import type { Theme } from "../../src/themes/types.js";
import type { TeamApi, ThemeApi, ToolApproval, ToolContext, ToolServices } from "../../src/tools/types.js";

/** A fresh temp folder with `files` (relative path -> content) written into it. */
export function tempProject(files: Record<string, string | Buffer> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-tools-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export const nullTeam: TeamApi = {
  members: () => [],
  send: () => [],
  spawn: async () => "nobody",
  stop: () => false,
  tasks: () => [],
  addTask: () => {
    throw new Error("no board");
  },
  updateTask: () => null,
};

export const nullRoblox: RobloxApi = {
  status: () => ({ listening: false, port: 0, connected: false, place: null, studioVersion: null, lastSeen: null, error: null }),
  call: async () => {
    throw new Error("not connected");
  },
  output: () => [],
  subscribe: () => () => undefined,
};

export function moonTheme(): Theme {
  return {
    name: "moon",
    label: "Moon",
    dark: true,
    colors: {
      bg: "#0b0920",
      surface: "#141030",
      surfaceFocus: "#1b1640",
      popover: "#1f1a48",
      border: "#2c2660",
      borderFocus: "#b9aefb",
      text: "#ecebff",
      muted: "#a49fd0",
      faint: "#6b6699",
      accent: "#b9aefb",
      accent2: "#7fe3c6",
      claude: "#7fe3c6",
      success: "#7fe3c6",
      warning: "#ffd28a",
      error: "#ff8fa3",
      diffAddBg: "#123a33",
      diffAddFg: "#9ff5dc",
      diffDelBg: "#3d1726",
      diffDelFg: "#ffb3c1",
      selection: "#2c2660",
      selectionText: "#ffffff",
      tabActiveBg: "#b9aefb",
      tabActiveFg: "#0b0920",
      agents: ["#b9aefb", "#7fe3c6", "#ffd28a"],
    },
    sky: {
      enabled: true,
      stars: ["#3a3570", "#8d86c9", "#ffffff"],
      glyphs: ["·", "+", "*"],
      density: 2,
      glass: 0.25,
      moon: true,
      moonColor: "#fdf6d8",
      shootingStars: true,
      shootingStarColor: "#ffffff",
    },
    axo: true,
    author: "lu-minal",
  };
}

/** An in-memory ThemeApi with "moon" and "moon-day" built in. */
export class FakeThemes implements ThemeApi {
  themes = new Map<string, { theme: Theme; builtin: boolean }>();
  currentName = "moon";
  saved: Array<{ theme: Theme; apply: boolean }> = [];
  sets: string[] = [];

  constructor() {
    const moon = moonTheme();
    const day: Theme = { ...moonTheme(), name: "moon-day", label: "Moon Day", dark: false };
    day.colors = { ...day.colors, bg: "#f4f2ff", text: "#1a1640" };
    this.themes.set("moon", { theme: moon, builtin: true });
    this.themes.set("moon-day", { theme: day, builtin: true });
  }

  list() {
    return [...this.themes.values()].map(({ theme, builtin }) => ({ name: theme.name, label: theme.label, dark: theme.dark, builtin }));
  }

  current(): Theme {
    return this.themes.get(this.currentName)!.theme;
  }

  set(name: string): boolean {
    if (!this.themes.has(name)) return false;
    this.sets.push(name);
    this.currentName = name;
    return true;
  }

  async save(theme: Theme, apply: boolean): Promise<void> {
    this.saved.push({ theme, apply });
    this.themes.set(theme.name, { theme, builtin: false });
    if (apply) this.currentName = theme.name;
  }
}

export function services(overrides: Partial<ToolServices> = {}): ToolServices {
  return { team: nullTeam, themes: new FakeThemes(), roblox: nullRoblox, ...overrides };
}

/** A ToolContext for calling a tool's `run` directly. */
export function makeCtx(
  opts: {
    cwd?: string;
    role?: AgentRole;
    agentName?: string;
    permissionMode?: PermissionMode;
    signal?: AbortSignal;
    services?: ToolServices;
    approve?: (req: ToolApproval) => Promise<boolean>;
  } = {},
): ToolContext {
  return {
    cwd: opts.cwd ?? process.cwd(),
    agentId: "agent_test",
    agentName: opts.agentName ?? "vega",
    role: opts.role ?? "worker",
    permissionMode: opts.permissionMode ?? "auto-edit",
    signal: opts.signal ?? new AbortController().signal,
    approve: opts.approve ?? (async () => true),
    services: opts.services ?? services(),
  };
}
