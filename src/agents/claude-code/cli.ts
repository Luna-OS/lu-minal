// Finds the user's Claude Code CLI and builds its command lines. lu-minal never talks to the Claude
// API with a subscription: it runs the official `claude` program, which signs in, keeps the login
// and counts the plan's limits on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "../../core/types.js";
import { expandHome } from "../../platform/paths.js";
import { findProgram, withProgramPath } from "../../platform/process.js";

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
    // nvm-windows (and npm run as administrator) put global packages next to node.exe.
    if (env.NVM_SYMLINK) add(p.join(env.NVM_SYMLINK, "claude.cmd"));
    if (env.ProgramFiles) add(p.join(env.ProgramFiles, "nodejs", "claude.cmd"));
    if (env.LOCALAPPDATA) add(p.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "claude.exe"));
    // pnpm add -g.
    add(p.join(env.PNPM_HOME || (env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, "pnpm") : p.join(home, "AppData", "Local", "pnpm")), "claude.cmd"));
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
  // npm with a user prefix, bun, volta, pnpm.
  add(p.join(home, ".npm-global", "bin", "claude"));
  add(p.join(home, ".bun", "bin", "claude"));
  add(p.join(home, ".volta", "bin", "claude"));
  if (env.PNPM_HOME) add(p.join(env.PNPM_HOME, "claude"));
  add(platform === "darwin" ? p.join(home, "Library", "pnpm", "claude") : p.join(env.XDG_DATA_HOME || p.join(home, ".local", "share"), "pnpm", "claude"));
  // npm under nvm: the newest Node first (claudeEnv puts its folder, which has that node, on the PATH).
  if (env.NVM_BIN) add(p.join(env.NVM_BIN, "claude"));
  const nvmNode = p.join(env.NVM_DIR || p.join(home, ".nvm"), "versions", "node");
  for (const version of nodeVersionsNewestFirst(nvmNode)) add(p.join(nvmNode, version, "bin", "claude"));
  if (platform === "linux") add("/snap/bin/claude");
  return out;
}

/** The "v22.11.0"-style folders in `dir`, newest first ([] when there is none). */
function nodeVersionsNewestFirst(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^v?\d+(\.\d+)*$/.test(n));
  } catch {
    return [];
  }
  const parts = (n: string) => n.replace(/^v/, "").split(".").map(Number);
  return names.sort((a, b) => {
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
}

/** The full path of `claude` (a configured one first, then the PATH, then the known places), or null. */
export function findClaude(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const wanted = configured?.trim() ? expandHome(configured.trim()) : null;
  return findProgram("claude", { configured: wanted, extra: knownClaudeLocations(os.homedir(), env), env });
}

/**
 * The permission modes lu-minal uses (`--permission-mode`). Claude Code 2.1.310's help lists the
 * asking mode as "manual" but still takes "default" (older versions know only that), and reports it
 * as "default" in its init line.
 */
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
  /**
   * The settings files to load (`--setting-sources`), e.g. ["user"] for a project nobody trusted
   * yet: its .claude/settings.json could hold hooks, an apiKeyHelper or allow rules, and `claude -p`
   * skips the workspace-trust dialog that would otherwise ask about them.
   */
  settingSources?: Array<"user" | "project" | "local">;
  /** Only the MCP servers of --mcp-config (`--strict-mcp-config`): not a project's .mcp.json. */
  strictMcpConfig?: boolean;
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
  if (opts.settingSources) args.push("--setting-sources", opts.settingSources.join(","));
  if (opts.strictMcpConfig) args.push("--strict-mcp-config");
  const tools = (opts.allowedTools ?? []).map((t) => t.trim()).filter(Boolean);
  if (tools.length) args.push("--allowedTools", tools.join(","));
  return args;
}

/** One user message as Claude Code's stream-json input expects it. */
/** One user message for stream-json input: plain text, or content blocks (text and images). */
export function userMessageLine(content: string | Array<Record<string, unknown>>): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** A control request line (interrupt, set_permission_mode, ...). */
export function controlLine(requestId: string, request: Record<string, unknown> & { subtype: string }): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`;
}

/** Asks the running turn to stop (the CLI answers with a control_response and ends the turn). */
export function interruptLine(requestId: string): string {
  return controlLine(requestId, { subtype: "interrupt" });
}

/** Our answer to a control request from the CLI (e.g. a can_use_tool permission decision). */
export function controlResponseLine(requestId: string, response: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`;
}

/** Turns down a control request from the CLI that lu-minal doesn't handle. */
export function controlErrorLine(requestId: string, error: string): string {
  return `${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } })}\n`;
}

/** Switches the running process to another permission mode without a restart. */
export function setPermissionModeLine(requestId: string, mode: ClaudePermissionMode): string {
  return controlLine(requestId, { subtype: "set_permission_mode", mode });
}

/**
 * 24 hours: an MCP call (the permission prompt) may wait that long for the user's answer. Set both
 * as MCP_TOOL_TIMEOUT and as the server entry's "timeout" in the --mcp-config (Claude Code gives
 * HTTP servers 60 s per request unless one of them is higher).
 */
export const MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Markers a Claude Code process leaves for its children. When lu-minal itself is started from inside
 * a Claude Code session (a terminal tab of it, or a cloud session), its agents must not inherit
 * them: `claude` refuses to start nested, and a child would otherwise join that session (a fixed
 * session id would make every agent write into the same conversation).
 */
const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_PID",
];

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
  const env = withProgramPath(base, exe, platform);
  env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);
  for (const key of NESTED_SESSION_VARS) delete env[key];
  return env;
}
