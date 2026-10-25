// Who is signed in to Claude Code: `claude auth status --json`, completed with what ~/.claude.json
// remembers about the account (its e-mail and organisation). lu-minal never reads or stores the
// login's tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeAccount } from "../../core/types.js";
import { runProgram, type RunResult } from "../../platform/process.js";
import { claudeEnv } from "./cli.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The first of `keys` that holds a non-empty string. */
function pick(obj: Obj, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The account fields of `claude auth status --json` and ~/.claude.json's `oauthAccount`. When the
 * status is missing (an older CLI without `auth status`), a remembered claude.ai account counts as
 * signed in.
 */
export function parseAccount(status: unknown, config: unknown): Omit<ClaudeAccount, "installed" | "exe" | "version"> {
  const s = isObj(status) ? status : {};
  const oauth = isObj(config) && isObj(config.oauthAccount) ? config.oauthAccount : {};
  const loggedIn = isObj(status)
    ? Boolean(s.loggedIn)
    : Boolean(pick(oauth, "accountUuid", "emailAddress"));
  return {
    loggedIn,
    authMethod: pick(s, "authMethod") ?? (!isObj(status) && loggedIn ? "claude.ai" : null),
    email: pick(s, "email", "emailAddress") ?? pick(oauth, "emailAddress"),
    organization: pick(s, "orgName", "organizationName") ?? pick(oauth, "organizationName"),
    plan: pick(s, "subscriptionType", "plan", "subscription"),
  };
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

/** ~/.claude.json (Claude Code's global settings; CLAUDE_CONFIG_DIR/.claude.json first), or {}. */
export function readGlobalClaudeConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): unknown {
  const candidates = [
    env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : null,
    path.join(home, ".claude.json"),
  ].filter((f): f is string => Boolean(f));
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch {
      // try the next one
    }
  }
  return {};
}

/** The JSON object in a command's output (which may carry a warning line before it), or null. */
export function jsonObjectIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

export interface ReadAccountOptions {
  /** Runs `claude` (tests pass a fake). */
  run?: (exe: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<RunResult>;
  env?: NodeJS.ProcessEnv;
  /** Reads ~/.claude.json (tests pass a fake). */
  readConfig?: () => unknown;
}

/**
 * { installed, exe, version, ...account } for the header and the sign-in dialog, from
 * `claude --version` and `claude auth status --json`. Never throws.
 */
export async function readClaudeAccount(exe: string | null, opts: ReadAccountOptions = {}): Promise<ClaudeAccount> {
  const signedOut = parseAccount({ loggedIn: false }, null);
  if (!exe) return { installed: false, exe: null, version: null, ...signedOut };
  const run = opts.run ?? ((e, a, o) => runProgram(e, a, { timeoutMs: o.timeoutMs, env: o.env }));
  const env = claudeEnv(opts.env ?? process.env, exe);
  let version: string | null = null;
  try {
    const v = await run(exe, ["--version"], { timeoutMs: 10_000, env });
    version = /(\d+\.\d+\.\d+)/.exec(`${v.stdout}\n${v.stderr}`)?.[1] ?? null;
  } catch {
    // The program could not be started at all.
    return { installed: false, exe, version: null, ...signedOut };
  }
  let status: unknown = null;
  try {
    // Exits non-zero when signed out, but still prints the JSON.
    const res = await run(exe, ["auth", "status", "--json"], { timeoutMs: 15_000, env });
    status = res.timedOut ? null : jsonObjectIn(res.stdout);
  } catch {
    status = null;
  }
  let config: unknown = {};
  try {
    config = (opts.readConfig ?? (() => readGlobalClaudeConfig(opts.env ?? process.env)))();
  } catch {
    config = {};
  }
  return { installed: true, exe, version, ...parseAccount(status, config) };
}
