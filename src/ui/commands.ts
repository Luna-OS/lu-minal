// Slash commands. Every shortcut has one, because terminals (VS Code, Windows Terminal, macOS
// Terminal) each swallow different key combinations.
import type { Agent } from "../core/agent.js";
import type { Hub } from "../core/hub.js";
import { nextPermissionMode, PERMISSION_HINTS } from "../core/permissions.js";
import type { Project } from "../core/project.js";
import { PERMISSION_MODES, type PermissionMode } from "../core/types.js";
import { parseModelRef } from "../providers/models.js";
import type { UiServices } from "./store.js";

export interface CommandContext {
  hub: Hub;
  ui: UiServices;
  project: Project | undefined;
  agent: Agent | undefined;
  /** Puts text into the focused agent's prompt. */
  setPrompt: (text: string) => void;
  toggleZoom: () => void;
  /** Opens one of the dialogs (implemented in dialogs/index.tsx). */
  dialogs: DialogLaunchers;
}

export interface DialogLaunchers {
  newTab(): void;
  newAgent(): void;
  login(provider?: string): void;
  model(agent: Agent): void;
  theme(): void;
  usage(): void;
  roblox(): void;
  help(): void;
  agents(): void;
  tasks(): void;
  palette(): void;
  closeTab(project: Project): void;
}

export interface Command {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  /** The key that does the same, for the palette and /help. */
  keys?: string;
  run(ctx: CommandContext, args: string): void | Promise<void>;
}

function needProject(ctx: CommandContext): Project | undefined {
  if (!ctx.project) ctx.hub.toast("Open a project first (ctrl+t or /tab).", "warning");
  return ctx.project;
}

export const COMMANDS: Command[] = [
  { name: "help", aliases: ["?", "keys"], description: "Keys and commands", keys: "?", run: (ctx) => ctx.dialogs.help() },
  { name: "tab", aliases: ["open", "new-tab"], description: "Open a project in a new tab (folder, GitHub, Forgejo)", keys: "ctrl+t", run: (ctx) => ctx.dialogs.newTab() },
  {
    name: "close",
    aliases: ["close-tab"],
    description: "Close this tab and stop its agents",
    keys: "ctrl+w (empty prompt)",
    run: (ctx) => {
      const p = needProject(ctx);
      if (p) ctx.dialogs.closeTab(p);
    },
  },
  {
    name: "new",
    aliases: ["agent", "spawn"],
    args: "[provider/model] [task]",
    description: "Add an agent to this project (any provider)",
    keys: "ctrl+n",
    run: async (ctx, args) => {
      const p = needProject(ctx);
      if (!p) return;
      const [first, ...rest] = args.trim().split(/\s+/);
      const ref = first ? parseModelRef(first) : null;
      if (!ref) return ctx.dialogs.newAgent();
      await p.addAgent({ name: "", role: "worker", model: ref, task: rest.join(" ") || undefined, spawnedBy: "you" });
    },
  },
  { name: "agents", aliases: ["team"], description: "The agents in this project", run: (ctx) => ctx.dialogs.agents() },
  { name: "tasks", aliases: ["board"], description: "The project's shared task board", run: (ctx) => ctx.dialogs.tasks() },
  {
    name: "model",
    args: "[provider/model]",
    description: "Switch the focused agent's model",
    keys: "ctrl+o",
    run: async (ctx, args) => {
      const p = needProject(ctx);
      const agent = ctx.agent;
      if (!p || !agent) return;
      const ref = parseModelRef(args.trim());
      if (!ref) return ctx.dialogs.model(agent);
      await ctx.hub.changeModel(p, agent, ref);
    },
  },
  { name: "login", aliases: ["signin", "providers"], args: "[provider]", description: "Sign in: Claude, OpenRouter, API keys, GitHub, Forgejo", keys: "ctrl+l", run: (ctx, args) => ctx.dialogs.login(args.trim() || undefined) },
  {
    name: "logout",
    args: "<provider>",
    description: "Sign out of a provider",
    run: async (ctx, args) => {
      const id = args.trim();
      if (!id) return ctx.dialogs.login();
      if (id === "claude" || id === "claude-code") return ctx.hub.logoutClaude(ctx.ui.runInTerminal);
      ctx.hub.removeKey(id);
    },
  },
  {
    name: "theme",
    args: "[name]",
    description: "Change the look (or ask an agent to design one)",
    run: (ctx, args) => {
      if (args.trim()) return void ctx.hub.setTheme(args.trim());
      ctx.dialogs.theme();
    },
  },
  { name: "usage", aliases: ["limits"], description: "Plan limits, credits and token use", run: (ctx) => ctx.dialogs.usage() },
  { name: "roblox", aliases: ["studio"], description: "Connect Roblox Studio", run: (ctx) => ctx.dialogs.roblox() },
  {
    name: "perm",
    aliases: ["permissions", "mode"],
    args: "[auto-edit|ask|yolo|plan]",
    description: "What agents may do without asking",
    keys: "shift+tab",
    run: (ctx, args) => {
      const p = needProject(ctx);
      if (!p) return;
      const wanted = args.trim() as PermissionMode;
      const mode = PERMISSION_MODES.includes(wanted) ? wanted : nextPermissionMode(p.permissionMode);
      p.setPermissionMode(mode);
      ctx.hub.toast(`${mode}: ${PERMISSION_HINTS[mode]}`, mode === "yolo" ? "warning" : "info");
    },
  },
  { name: "zoom", aliases: ["full"], description: "Show the focused agent full screen", keys: "ctrl+f", run: (ctx) => ctx.toggleZoom() },
  {
    name: "clear",
    description: "Clear the focused agent's panel (the conversation stays)",
    run: (ctx) => ctx.agent?.clearLog(),
  },
  {
    name: "stop",
    aliases: ["interrupt"],
    description: "Interrupt the focused agent",
    keys: "esc",
    run: (ctx) => ctx.agent?.interrupt(),
  },
  {
    name: "kill",
    aliases: ["remove"],
    args: "[name]",
    description: "Remove an agent from the project",
    run: async (ctx, args) => {
      const p = needProject(ctx);
      if (!p) return;
      const agent = args.trim() ? p.findAgent(args.trim()) : ctx.agent;
      if (!agent) return ctx.hub.toast(`No agent "${args.trim()}".`, "warning");
      if (agent.role === "lead") return ctx.hub.toast("The lead stays - close the tab instead.", "warning");
      await p.removeAgent(agent);
    },
  },
  {
    name: "msg",
    aliases: ["tell"],
    args: "<name|*> <text>",
    description: "Message an agent (or * for everyone) - same as @name text",
    run: (ctx, args) => {
      const p = needProject(ctx);
      if (!p) return;
      const m = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      if (!m) return ctx.hub.toast("Usage: /msg <name|*> <text>", "warning");
      const got = p.send("you", m[1], m[2]);
      if (!got.length) ctx.hub.toast(`Nobody called "${m[1]}" here.`, "warning");
    },
  },
  {
    name: "continue",
    aliases: ["restore"],
    description: "Reopen the tabs of the last session",
    run: async (ctx) => {
      const n = await ctx.hub.restoreSession();
      ctx.hub.toast(n ? `Reopened ${n} tab${n === 1 ? "" : "s"}.` : "Nothing to reopen.", n ? "success" : "info");
    },
  },
  { name: "palette", aliases: ["commands"], description: "All commands", keys: "ctrl+k", run: (ctx) => ctx.dialogs.palette() },
  { name: "quit", aliases: ["exit", "q"], description: "Quit lu-minal", keys: "ctrl+q", run: (ctx) => ctx.ui.quit() },
];

export function findCommand(name: string): Command | undefined {
  const n = name.toLowerCase();
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/** Commands whose name starts with what was typed after "/" (for the menu above the prompt). */
export function commandSuggestions(typed: string): Command[] {
  const t = typed.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(t) || c.aliases?.some((a) => a.startsWith(t)));
}

/** Runs "/name args" text; false when it was not a known command. */
export async function runCommandLine(ctx: CommandContext, line: string): Promise<boolean> {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim());
  if (!m) return false;
  const cmd = findCommand(m[1]);
  if (!cmd) {
    ctx.hub.toast(`Unknown command /${m[1]} - try /help.`, "warning");
    return true;
  }
  try {
    await cmd.run(ctx, m[2]);
  } catch (err) {
    ctx.hub.toast(err instanceof Error ? err.message : String(err), "error");
  }
  return true;
}
