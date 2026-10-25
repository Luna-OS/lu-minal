import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatArgs,
  claudeEnv,
  claudePermissionMode,
  controlErrorLine,
  controlResponseLine,
  findClaude,
  interruptLine,
  knownClaudeLocations,
  MCP_TOOL_TIMEOUT_MS,
  setPermissionModeLine,
  userMessageLine,
} from "../../src/agents/claude-code/cli.js";
import { CLAUDE_DOCS_URL, claudeInstallCommand, claudeLoginArgs, claudeLogoutArgs } from "../../src/agents/claude-code/login.js";

const STREAM = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

describe("knownClaudeLocations", () => {
  it("lists the installers' places on Windows with Windows paths", () => {
    const list = knownClaudeLocations(
      "C:\\Users\\luna",
      { APPDATA: "C:\\Users\\luna\\AppData\\Roaming", USERPROFILE: "C:\\Users\\luna", LOCALAPPDATA: "C:\\Users\\luna\\AppData\\Local" },
      "win32",
    );
    expect(list[0]).toBe("C:\\Users\\luna\\.local\\bin\\claude.exe");
    expect(list).toContain("C:\\Users\\luna\\.claude\\local\\claude.exe");
    expect(list).toContain("C:\\Users\\luna\\AppData\\Roaming\\npm\\claude.cmd");
    expect(list).toContain("C:\\Users\\luna\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe");
    expect(list.every((p) => !p.includes("/"))).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  it("uses %USERPROFILE% when it differs from the home folder", () => {
    const list = knownClaudeLocations("D:\\home", { USERPROFILE: "C:\\Users\\luna" }, "win32");
    expect(list).toContain("C:\\Users\\luna\\.local\\bin\\claude.exe");
    expect(list).toContain("D:\\home\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("lists ~/.local/bin, ~/.claude/local and Homebrew's folders on macOS and Linux", () => {
    const mac = knownClaudeLocations("/Users/luna", {}, "darwin");
    expect(mac.slice(0, 4)).toEqual([
      "/Users/luna/.local/bin/claude",
      "/Users/luna/.claude/local/claude",
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ]);
    expect(mac.some((p) => p.endsWith(".exe") || p.includes("\\"))).toBe(false);
    expect(knownClaudeLocations("/home/luna", {}, "linux")).toContain("/home/luna/.npm-global/bin/claude");
  });
});

describe("findClaude", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function fakeExe(dir: string): string {
    const name = process.platform === "win32" ? "claude.cmd" : "claude";
    const file = path.join(dir, name);
    fs.writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\necho 2.1.0\n");
    fs.chmodSync(file, 0o755);
    return file;
  }

  it("finds claude on the PATH, and prefers a configured path that exists", () => {
    const onPath = fs.mkdtempSync(path.join(os.tmpdir(), "lm-claude-path-"));
    const configured = fs.mkdtempSync(path.join(os.tmpdir(), "lm-claude-conf-"));
    dirs.push(onPath, configured);
    const exe = fakeExe(onPath);
    const mine = fakeExe(configured);
    const env = { PATH: onPath, PATHEXT: ".EXE;.CMD" };
    expect(findClaude(null, env)).toBe(exe);
    expect(findClaude(mine, env)).toBe(mine);
    // A configured path that doesn't exist falls back to the PATH.
    expect(findClaude(path.join(configured, "nope"), env)).toBe(exe);
  });

  it("returns null when claude is nowhere", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lm-claude-none-"));
    dirs.push(empty);
    const found = findClaude(null, { PATH: empty });
    // Only the known install places could still have it (on a machine where it is installed).
    if (found) expect(knownClaudeLocations(os.homedir(), { PATH: empty })).toContain(found);
  });
});

describe("chatArgs", () => {
  it("always streams JSON both ways", () => {
    expect(chatArgs()).toEqual(STREAM);
    expect(chatArgs({ model: "default" })).toEqual(STREAM);
    expect(chatArgs({ model: "  " })).toEqual(STREAM);
  });

  it("adds the model, mode, session, MCP config, prompt tool, prompt and allowed tools", () => {
    const args = chatArgs({
      model: "opus",
      permissionMode: "acceptEdits",
      resume: "8f3c-session",
      mcpConfigFile: path.join("state", "mcp", "agent_1.json"),
      permissionPromptTool: "mcp__luminal__approve",
      appendSystemPrompt: "You are luna, the lead.\nWork with your team.",
      allowedTools: ["mcp__luminal", " ", "Bash(git status)"],
      effort: "high",
      addDirs: ["/tmp/attachments"],
    });
    expect(args.slice(0, 7)).toEqual(STREAM);
    expect(args.slice(7)).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      "8f3c-session",
      "--mcp-config",
      path.join("state", "mcp", "agent_1.json"),
      "--permission-prompt-tool",
      "mcp__luminal__approve",
      "--append-system-prompt",
      "You are luna, the lead.\nWork with your team.",
      "--add-dir",
      "/tmp/attachments",
      "--allowedTools",
      "mcp__luminal,Bash(git status)",
    ]);
  });

  it("prefers a prompt file and keeps a prompt that starts with '-' a value", () => {
    const withFile = chatArgs({ appendSystemPrompt: "inline", appendSystemPromptFile: "C:\\state\\a.prompt.md" });
    expect(withFile).toContain("--append-system-prompt-file");
    expect(withFile).not.toContain("--append-system-prompt");
    expect(withFile).not.toContain("inline");
    expect(chatArgs({ appendSystemPrompt: "- be brief" })).toContain("--append-system-prompt=- be brief");
    expect(chatArgs({ appendSystemPrompt: "   " })).toEqual(STREAM);
  });

  it("leaves out an unknown permission mode", () => {
    expect(chatArgs({ permissionMode: "whatever" as never })).not.toContain("--permission-mode");
  });
});

describe("permission modes", () => {
  it("maps lu-minal's modes to Claude Code's", () => {
    expect(claudePermissionMode("ask")).toBe("default");
    expect(claudePermissionMode("auto-edit")).toBe("acceptEdits");
    expect(claudePermissionMode("yolo")).toBe("bypassPermissions");
    expect(claudePermissionMode("plan")).toBe("plan");
  });
});

describe("stdin lines", () => {
  it("a user message is one JSON line", () => {
    const line = userMessageLine('Say "hi"\nplease');
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: 'Say "hi"\nplease' } });
  });

  it("control requests and responses", () => {
    expect(JSON.parse(interruptLine("int_1"))).toEqual({
      type: "control_request",
      request_id: "int_1",
      request: { subtype: "interrupt" },
    });
    expect(JSON.parse(setPermissionModeLine("m_1", "plan"))).toEqual({
      type: "control_request",
      request_id: "m_1",
      request: { subtype: "set_permission_mode", mode: "plan" },
    });
    expect(JSON.parse(controlResponseLine("r1", { behavior: "allow", updatedInput: {} }))).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: {} } },
    });
    expect(JSON.parse(controlErrorLine("r2", "no"))).toEqual({
      type: "control_response",
      response: { subtype: "error", request_id: "r2", error: "no" },
    });
  });
});

describe("claudeEnv", () => {
  it("copies the env, raises MCP_TOOL_TIMEOUT and keeps the user's keys", () => {
    const base = { HOME: "/home/luna", PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-x", MCP_TOOL_TIMEOUT: "60000" };
    const env = claudeEnv(base, null, "linux");
    expect(env).not.toBe(base);
    expect(env.MCP_TOOL_TIMEOUT).toBe(String(MCP_TOOL_TIMEOUT_MS));
    expect(MCP_TOOL_TIMEOUT_MS).toBe(86_400_000);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(base.MCP_TOOL_TIMEOUT).toBe("60000");
  });

  it("drops the markers of a surrounding Claude Code session", () => {
    const env = claudeEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc", CLAUDE_CODE_ENTRYPOINT: "cli" }, null, "linux");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("cli");
  });

  it("appends claude's folder (and Homebrew's on macOS) to a short PATH", () => {
    const mac = claudeEnv({ PATH: "/usr/bin:/bin" }, "/Users/luna/.npm-global/bin/claude", "darwin");
    expect(mac.PATH).toBe("/usr/bin:/bin:/Users/luna/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin");
    const already = claudeEnv({ PATH: "/opt/homebrew/bin:/usr/local/bin/:/usr/bin" }, "/opt/homebrew/bin/claude", "darwin");
    expect(already.PATH).toBe("/opt/homebrew/bin:/usr/local/bin/:/usr/bin");
  });

  it("keeps Windows' 'Path' spelling instead of adding a second PATH", () => {
    const env = claudeEnv(
      { Path: "C:\\Windows\\system32", PATHEXT: ".EXE;.CMD" },
      "C:\\Users\\luna\\AppData\\Roaming\\npm\\claude.cmd",
      "win32",
    );
    expect(env.PATH).toBeUndefined();
    expect(env.Path).toBe("C:\\Windows\\system32;C:\\Users\\luna\\AppData\\Roaming\\npm");
    const same = claudeEnv({ Path: "C:\\Users\\Luna\\.local\\bin\\" }, "c:\\users\\luna\\.local\\bin\\claude.exe", "win32");
    expect(same.Path).toBe("C:\\Users\\Luna\\.local\\bin\\");
  });
});

describe("login", () => {
  it("runs the official installer per platform", () => {
    expect(claudeInstallCommand("win32")).toEqual({
      exe: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"],
      display: "irm https://claude.ai/install.ps1 | iex",
    });
    for (const p of ["darwin", "linux"] as const) {
      expect(claudeInstallCommand(p)).toEqual({
        exe: "bash",
        args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
        display: "curl -fsSL https://claude.ai/install.sh | bash",
      });
    }
  });

  it("signs in and out with `claude auth`", () => {
    expect(claudeLoginArgs()).toEqual(["auth", "login"]);
    expect(claudeLogoutArgs()).toEqual(["auth", "logout"]);
    expect(CLAUDE_DOCS_URL).toMatch(/^https:\/\//);
  });
});
