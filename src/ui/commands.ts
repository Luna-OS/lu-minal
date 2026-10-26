// Slash commands. Every shortcut has one, because terminals (VS Code, Windows Terminal, macOS
// Terminal) each swallow different key combinations.
import { cloudTarget } from "../cloud/claude-cloud.js";
import type { Agent } from "../core/agent.js";
import type { Hub } from "../core/hub.js";
import { nextPermissionMode, PERMISSION_HINTS } from "../core/permissions.js";
import type { Project } from "../core/project.js";
import { PERMISSION_MODES, type PermissionMode } from "../core/types.js";
import { parseModelRef } from "../providers/models.js";
import { mouseReportingUseful, SELECT_HINT } from "./mouse.js";
import type { UiServices } from "./store.js";
import { resolvePath } from "../tools/fs.js";

export interface CommandContext {
  hub: Hub;
  ui: UiServices;
  project: Project | undefined;
  agent: Agent | undefined;
  /** Puts text into the focused agent's prompt. */
  setPrompt: (text: string) => void;
  toggleZoom: () => void;
  /** Attaches files (by path) to the focused agent's next message. */
  attach: (paths: string[]) => void;
  /** Attaches the picture or the copied files on the clipboard to the focused agent's next message. */
  paste: () => void;
  /** Copies the focused agent's last reply to the clipboard (the App's; absent where there is no terminal). */
  copy?: () => void;
  /** Opens one of the dialogs (implemented in dialogs/index.tsx). */
  dialogs: DialogLaunchers;
}

export interface DialogLaunchers {
  newTab(): void;
  newAgent(): void;
  attach(): void;
  login(provider?: string): void;
  model(agent: Agent): void;
  theme(): void;
  usage(): void;
  stats(): void;
  cloud(): void;
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
  {
    name: "home",
    aliases: ["start", "news"],
    description: "The start screen: recent folders, new models, Claude Code news, Anthropic status",
    keys: "alt+0",
    run: (ctx) => ctx.hub.openHome(),
  },
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
  {
    name: "attach",
    aliases: ["file", "image"],
    args: "[path]",
    description: "Attach a picture or file to the next message (or paste a screenshot or copied files, or drop files on the terminal)",
    run: (ctx, args) => {
      const p = args.trim();
      if (!p) return ctx.dialogs.attach();
      const base = ctx.project?.cwd ?? process.cwd();
      ctx.attach([resolvePath(base, p)]);
    },
  },
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
  { name: "stats", aliases: ["statistics", "tokens"], description: "Token statistics: today, this week, all time, by model and project", run: (ctx) => ctx.dialogs.stats() },
  {
    name: "cloud",
    aliases: ["web", "remote"],
    args: "[msg <text>]",
    description: "Claude cloud sessions in the terminal: start, message, teleport, watch (msg: to the one used last, else the newest)",
    run: async (ctx, args) => {
      const m = /^(?:msg|message|send)(?:\s+([\s\S]*))?$/i.exec(args.trim());
      if (!m) return ctx.dialogs.cloud();
      const text = (m[1] ?? "").trim();
      if (!text) return ctx.hub.toast("Usage: /cloud msg <text> - to the cloud session used last in /cloud, else the newest.", "warning");
      const session = cloudTarget(ctx.hub.cloudSessions, ctx.project?.cwd ?? null, ctx.hub.pickedCloudId);
      if (!session) return ctx.hub.toast("No cloud session yet - /cloud starts one or adds one by its link.", "warning");
      await ctx.hub.messageCloud(session, text);
    },
  },
  { name: "roblox", aliases: ["studio"], description: "Connect Roblox Studio", run: (ctx) => ctx.dialogs.roblox() },
  {
    name: "trust",
    args: "[on|off]",
    description: "Trust this folder's own agent settings (.claude hooks and rules, CLAUDE.md, .mcp.json servers)",
    run: (ctx, args) => {
      const p = needProject(ctx);
      if (!p) return;
      const a = args.trim().toLowerCase();
      const trusted = a === "on" || a === "yes" ? true : a === "off" || a === "no" ? false : !p.trusted;
      void ctx.hub.setTrust(p, trusted).then(() =>
        ctx.hub.toast(
          trusted
            ? `Trusted ${p.name}: Claude Code agents load its .claude settings, CLAUDE.md and .mcp.json servers.`
            : `${p.name} is not trusted: Claude Code agents start with your own settings only.`,
          trusted ? "warning" : "info",
        ),
      );
    },
  },
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
  {
    name: "yolo",
    aliases: ["allow-all", "autoapprove"],
    args: "[on|off]",
    description: "Let every agent in every tab run everything without asking, new tabs too (off: back to edits on)",
    run: (ctx, args) => {
      const a = args.trim().toLowerCase();
      const on = a === "on" || a === "yes" ? true : a === "off" || a === "no" ? false : !ctx.hub.allowingEverything;
      ctx.hub.allowEverything(on);
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
  {
    name: "paste",
    aliases: ["clipboard"],
    description: "Attach the picture or the files copied on the clipboard to the next message",
    keys: "ctrl+v (alt+v)",
    run: (ctx) => ctx.paste(),
  },
  {
    name: "copy",
    aliases: ["yank"],
    description: "Copy the focused agent's last reply to the clipboard (its words, not the tool output)",
    run: (ctx) => {
      if (!ctx.agent) return ctx.hub.toast("Focus an agent first - /copy copies its last reply.", "info");
      ctx.copy?.();
    },
  },
  {
    name: "mouse",
    args: "[on|off]",
    description: "The mouse wheel scrolls the panel under it, a click focuses one (off: the terminal's own selection)",
    run: (ctx, args) => {
      const a = args.trim().toLowerCase();
      const on = a === "on" || a === "yes" ? true : a === "off" || a === "no" ? false : !ctx.hub.config.mouse;
      ctx.hub.config.mouse = on;
      ctx.hub.persistConfig();
      ctx.hub.notifier.changed();
      if (!on) return ctx.hub.toast("Mouse off: a plain drag selects text again; pgup / pgdn scroll.", "info");
      if (!mouseReportingUseful()) {
        return ctx.hub.toast("Mouse on - but the macOS app's terminal keeps the wheel for itself, so lu-minal leaves the mouse to it in this window.", "info");
      }
      ctx.hub.toast(`Mouse on: the wheel scrolls, a click focuses. ${SELECT_HINT}`, "info");
    },
  },
  { name: "palette", aliases: ["commands"], description: "All commands", keys: "ctrl+k", run: (ctx) => ctx.dialogs.palette() },
  { name: "update", aliases: ["upgrade"], description: "Install the newest lu-minal", run: (ctx) => void ctx.hub.installUpdate() },
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
