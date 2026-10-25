// Finds the user's Claude Code CLI and builds its command lines. lu-minal never talks to the Claude
// API with a subscription: it runs the official `claude` program, which signs in, keeps the login
// and counts the plan's limits on its own.
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "../../core/types.js";
import { expandHome } from "../../platform/paths.js";
import { findProgram } from "../../platform/process.js";

/**
 * The places Claude Code's installers put `claude`, besides the PATH. An app started from the
 * Start menu, the Dock or the macOS Swift shell may not see the PATH of the user's terminal, hence
 * this list. Built with the target platform's path rules, so it can be tested anywhere.
 */
export function knownClaudeLocations(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  const add = (file: string | null) => {
    if (file && !out.includes(file)) out.push(file);
  };
  if (platform === "win32") {
    const p = path.win32;
    const profile = env.USERPROFILE || home;
    // The native installer (irm https://claude.ai/install.ps1 | iex).
    add(p.join(home, ".local", "bin", "claude.exe"));
    add(p.join(profile, ".local", "bin", "claude.exe"));
    // `claude migrate-installer` (a local npm install).
    add(p.join(home, ".claude", "local", "claude.exe"));
    add(p.join(home, ".claude", "local", "claude.cmd"));
    // npm install -g @anthropic-ai/claude-code.
    add(env.APPDATA ? p.join(env.APPDATA, "npm", "claude.cmd") : p.join(home, "AppData", "Roaming", "npm", "claude.cmd"));
    if (env.LOCALAPPDATA) add(p.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "claude.exe"));
    add(p.join(home, ".bun", "bin", "claude.exe"));
    add(p.join(home, "scoop", "shims", "claude.exe"));
    return out;
  }
  const p = path.posix;
  add(p.join(home, ".local", "bin", "claude"));
  add(p.join(home, ".claude", "local", "claude"));
  // Homebrew (Intel macOS and Linux use /usr/local, Apple Silicon /opt/homebrew).
  add("/usr/local/bin/claude");
  add("/opt/homebrew/bin/claude");
  // npm with a user prefix, bun, volta.
  add(p.join(home, ".npm-global", "bin", "claude"));
  add(p.join(home, ".bun", "bin", "claude"));
  add(p.join(home, ".volta", "bin", "claude"));
  if (platform === "linux") add("/snap/bin/claude");
  return out;
}

/** The full path of `claude` (a configured one first, then the PATH, then the known places), or null. */
export function findClaude(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const wanted = configured?.trim() ? expandHome(configured.trim()) : null;
  return findProgram("claude", { configured: wanted, extra: knownClaudeLocations(os.homedir(), env), env });
}

/** The permission modes Claude Code knows (`--permission-mode`). */
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

/** lu-minal's permission mode as Claude Code's. */
export function claudePermissionMode(mode: PermissionMode): ClaudePermissionMode {
  switch (mode) {
    case "auto-edit":
      return "acceptEdits";
    case "yolo":
      return "bypassPermissions";
    case "plan":
      return "plan";
    case "ask":
    default:
      return "default";
  }
}

export interface ChatArgsOptions {
  /** A model alias or id; "default" (the plan's default) adds no --model. */
  model?: string;
  permissionMode?: ClaudePermissionMode;
  /** A session id to continue. */
  resume?: string;
  /** The JSON file with lu-minal's MCP server (`--mcp-config`). */
  mcpConfigFile?: string;
  /** The MCP tool that answers permission prompts, e.g. "mcp__luminal__approve". */
  permissionPromptTool?: string;
  /** Text appended to Claude Code's system prompt. */
  appendSystemPrompt?: string;
  /**
   * A file holding the text to append instead (`--append-system-prompt-file`). Wins over
   * `appendSystemPrompt`; used where a long multi-line argument can't be passed (cmd.exe shims).
   */
  appendSystemPromptFile?: string;
  /** Tools that run without a permission prompt (e.g. "mcp__luminal" for all of lu-minal's). */
  allowedTools?: string[];
  /** "low" | "medium" | "high" | "xhigh" | "max". */
  effort?: string;
  addDirs?: string[];
}

/**
 * The arguments for a chat process that reads user messages from stdin and streams everything back
 * as JSON lines.
 */
export function chatArgs(opts: ChatArgsOptions = {}): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  const model = opts.model?.trim();
  if (model && model !== "default") args.push("--model", model);
  if (opts.effort?.trim()) args.push("--effort", opts.effort.trim());
  if (opts.permissionMode && CLAUDE_PERMISSION_MODES.includes(opts.permissionMode)) {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.resume?.trim()) args.push("--resume", opts.resume.trim());
  if (opts.mcpConfigFile) args.push("--mcp-config", opts.mcpConfigFile);
  if (opts.permissionPromptTool) args.push("--permission-prompt-tool", opts.permissionPromptTool);
  if (opts.appendSystemPromptFile) {
    args.push("--append-system-prompt-file", opts.appendSystemPromptFile);
  } else if (opts.appendSystemPrompt?.trim()) {
    const prompt = opts.appendSystemPrompt.trim();
    // A value that starts with "-" would be read as an option; the "=" form keeps it a value.
    if (prompt.startsWith("-")) args.push(`--append-system-prompt=${prompt}`);
    else args.push("--append-system-prompt", prompt);
  }
  for (const dir of opts.addDirs ?? []) if (dir) args.push("--add-dir", dir);
  const tools = (opts.allowedTools ?? []).map((t) => t.trim()).filter(Boolean);
  if (tools.length) args.push("--allowedTools", tools.join(","));
  return args;
}

/** One user message as Claude Code's stream-json input expects it. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** A control request line (interrupt, set_permission_mode, ...). */
export function controlLine(requestId: string, request: Record<string, unknown> & { subtype: string }): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`;
}

/** Asks the running turn to stop (the CLI answers with a control_response and ends the turn). */
export function interruptLine(requestId: string): string {
  return controlLine(requestId, { subtype: "interrupt" });
}

/** Switches the running process to another permission mode without a restart. */
export function setPermissionModeLine(requestId: string, mode: ClaudePermissionMode): string {
  return controlLine(requestId, { subtype: "set_permission_mode", mode });
}

/** 24 hours: an MCP call (the permission prompt) may wait that long for the user's answer. */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Variables that mark a process as running inside a Claude Code session. When lu-minal itself is
 * started from one (a terminal in Claude Code), its agents must not inherit them: `claude` refuses
 * to start nested, and a fixed session id would make every agent write into the same conversation.
 */
const NESTED_SESSION_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"];

/** The key under which `env` keeps the PATH (Windows spells it "Path"). */
function pathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
}

/**
 * The environment for `claude`: a copy of `base` (the user's own, API keys and all) with
 * MCP_TOOL_TIMEOUT raised so permission prompts can wait for the user, without the nested-session
 * markers, and with the directory of `exe` (plus Homebrew's on macOS) appended to the PATH when it
 * is missing there – npm's `claude` is a `#!/usr/bin/env node` script, and an app started from the
 * Dock gets a PATH without Homebrew's node.
 */
export function claudeEnv(
  base: NodeJS.ProcessEnv = process.env,
  exe?: string | null,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  for (const key of NESTED_SESSION_VARS) delete env[key];

  const p = platform === "win32" ? path.win32 : path.posix;
  const key = pathKey(env, platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = (env[key] ?? "").split(delimiter).filter(Boolean);
  const norm = (d: string) => (platform === "win32" ? d.toLowerCase().replace(/[\\/]+$/, "") : d.replace(/\/+$/, ""));
  const have = new Set(dirs.map(norm));
  const extra: string[] = [];
  if (exe && p.isAbsolute(exe)) extra.push(p.dirname(exe));
  if (platform === "darwin") extra.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of extra) {
    if (!have.has(norm(dir))) {
      dirs.push(dir);
      have.add(norm(dir));
    }
  }
  if (dirs.length) env[key] = dirs.join(delimiter);
  return env;
}
