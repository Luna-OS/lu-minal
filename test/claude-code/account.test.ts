import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jsonObjectIn, parseAccount, readClaudeAccount, readGlobalClaudeConfig } from "../../src/agents/claude-code/account.js";
import type { RunResult } from "../../src/platform/process.js";

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "", timedOut: false });

describe("parseAccount", () => {
  it("reads `claude auth status --json` and completes it from ~/.claude.json", () => {
    const status = {
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "luna@example.com",
      orgId: "org-1",
      orgName: "",
      subscriptionType: "max",
    };
    const config = { oauthAccount: { emailAddress: "other@example.com", organizationName: "Luna OS" } };
    expect(parseAccount(status, config)).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "luna@example.com",
      organization: "Luna OS",
      plan: "max",
    });
  });

  it("is signed out when the status says so, whatever the config remembers", () => {
    expect(parseAccount({ loggedIn: false }, { oauthAccount: { emailAddress: "a@b.c", accountUuid: "u" } })).toMatchObject({
      loggedIn: false,
      email: "a@b.c",
      plan: null,
    });
  });

  it("falls back to the remembered claude.ai account when there is no status (older CLIs)", () => {
    expect(parseAccount(null, { oauthAccount: { accountUuid: "u-1", emailAddress: "luna@example.com" } })).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "luna@example.com",
      organization: null,
      plan: null,
    });
    expect(parseAccount(null, {})).toEqual({ loggedIn: false, authMethod: null, email: null, organization: null, plan: null });
    expect(parseAccount("garbage", 42)).toMatchObject({ loggedIn: false });
  });
});

describe("jsonObjectIn", () => {
  it("finds the JSON object behind a warning line", () => {
    expect(jsonObjectIn('Warning: update available\n{"loggedIn":true}\n')).toEqual({ loggedIn: true });
    expect(jsonObjectIn("not json")).toBeNull();
    expect(jsonObjectIn("[1,2]")).toBeNull();
  });
});

describe("readGlobalClaudeConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("prefers CLAUDE_CONFIG_DIR/.claude.json and falls back to ~/.claude.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lm-home-"));
    const conf = fs.mkdtempSync(path.join(os.tmpdir(), "lm-claude-conf-"));
    dirs.push(home, conf);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ where: "home" }));
    expect(readGlobalClaudeConfig({}, home)).toEqual({ where: "home" });
    expect(readGlobalClaudeConfig({ CLAUDE_CONFIG_DIR: conf }, home)).toEqual({ where: "home" });
    fs.writeFileSync(path.join(conf, ".claude.json"), JSON.stringify({ where: "config dir" }));
    expect(readGlobalClaudeConfig({ CLAUDE_CONFIG_DIR: conf }, home)).toEqual({ where: "config dir" });
    fs.writeFileSync(path.join(home, ".claude.json"), "{broken");
    expect(readGlobalClaudeConfig({}, home)).toEqual({});
  });
});

describe("readClaudeAccount", () => {
  it("is not installed without a program", async () => {
    expect(await readClaudeAccount(null)).toEqual({
      installed: false,
      exe: null,
      version: null,
      loggedIn: false,
      authMethod: null,
      email: null,
      organization: null,
      plan: null,
    });
  });

  it("runs --version and auth status with timeouts and claude's environment", async () => {
    const calls: Array<{ args: string[]; timeoutMs: number; env: NodeJS.ProcessEnv }> = [];
    const account = await readClaudeAccount("/opt/claude/bin/claude", {
      env: { PATH: "/usr/bin", CLAUDECODE: "1" },
      readConfig: () => ({ oauthAccount: { organizationName: "Luna OS" } }),
      run: async (_exe, args, opts) => {
        calls.push({ args, ...opts });
        if (args[0] === "--version") return ok("2.1.310 (Claude Code)\n");
        // Signed in: exit 0 and the JSON.
        return ok('{"loggedIn":true,"authMethod":"claude.ai","email":"luna@example.com","subscriptionType":"pro"}');
      },
    });
    expect(account).toEqual({
      installed: true,
      exe: "/opt/claude/bin/claude",
      version: "2.1.310",
      loggedIn: true,
      authMethod: "claude.ai",
      email: "luna@example.com",
      organization: "Luna OS",
      plan: "pro",
    });
    expect(calls.map((c) => c.args)).toEqual([["--version"], ["auth", "status", "--json"]]);
    expect(calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 15_000)).toBe(true);
    expect(calls[0].env.CLAUDECODE).toBeUndefined();
  });

  it("reads a signed-out status from a non-zero exit, and never throws", async () => {
    const signedOut = await readClaudeAccount("claude", {
      readConfig: () => ({}),
      run: async (_e, args) => (args[0] === "--version" ? ok("2.0.1") : ok('{"loggedIn":false}', 1)),
    });
    expect(signedOut).toMatchObject({ installed: true, version: "2.0.1", loggedIn: false });

    const broken = await readClaudeAccount("claude", {
      readConfig: () => {
        throw new Error("unreadable");
      },
      run: async (_e, args) => {
        if (args[0] === "--version") return ok("1.0.0");
        throw new Error("auth status hung");
      },
    });
    expect(broken).toMatchObject({ installed: true, version: "1.0.0", loggedIn: false });

    const missing = await readClaudeAccount("/gone/claude", {
      run: async () => {
        throw Object.assign(new Error("spawn /gone/claude ENOENT"), { code: "ENOENT" });
      },
    });
    expect(missing).toMatchObject({ installed: false, exe: "/gone/claude", loggedIn: false });
  });
});
