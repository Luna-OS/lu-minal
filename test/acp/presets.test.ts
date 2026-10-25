import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acpCommandArgs,
  acpEnv,
  acpPresets,
  builtinAcpPresets,
  detectAcpAgents,
  findAcpAgent,
  findAcpProgram,
  GEMINI_CLI_ID,
  OPENCODE_CLI_ID,
  openCodeLogError,
  openCodePermissionEnv,
  type ProgramFinder,
} from "../../src/agents/acp/presets.js";
import { defaultConfig, mergeConfig } from "../../src/core/config.js";

/** A findProgram stand-in: knows a few names on the PATH and a few files elsewhere. */
function fakeFinder(onPath: Record<string, string>, files: string[] = []) {
  const calls: Array<{ name: string; extra: string[]; configured: string | null }> = [];
  const find: ProgramFinder = (name, opts = {}) => {
    calls.push({ name, extra: opts.extra ?? [], configured: opts.configured ?? null });
    if (opts.configured && files.includes(opts.configured)) return opts.configured;
    if (onPath[name]) return onPath[name];
    return (opts.extra ?? []).find((f) => files.includes(f)) ?? null;
  };
  return { find, calls };
}

describe("builtin presets", () => {
  it("knows OpenCode and Gemini CLI", () => {
    const [oc, gemini] = builtinAcpPresets();
    expect(oc).toMatchObject({
      id: OPENCODE_CLI_ID,
      name: "OpenCode (CLI)",
      command: "opencode",
      args: ["acp", "--print-logs", "--log-level", "WARN"],
      toolPrefix: "luminal_",
      models: "opencode",
      login: { command: "opencode", args: ["auth", "login"] },
      builtin: true,
    });
    expect(oc.signIn).toContain("opencode auth login");
    expect(oc.docs).toMatch(/^https:\/\/opencode\.ai/);
    expect(gemini).toMatchObject({ id: GEMINI_CLI_ID, name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], toolPrefix: "", models: "static" });
    expect(gemini.signIn).toMatch(/Login with Google/);
    expect(gemini.staticModels.map((m) => m.id)).toEqual(expect.arrayContaining(["gemini-4-argon", "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro"]));
  });

  it("picks Gemini's model on the command line and leaves 'default' to the agent", () => {
    const gemini = findAcpAgent(GEMINI_CLI_ID)!;
    expect(acpCommandArgs(gemini, "gemini-3.8-flash")).toEqual(["--experimental-acp", "--model", "gemini-3.8-flash"]);
    expect(acpCommandArgs(gemini, "default")).toEqual(["--experimental-acp"]);
    expect(acpCommandArgs(gemini, "")).toEqual(["--experimental-acp"]);
    expect(acpCommandArgs(gemini, "gemini-3.8-flash", { modelArgs: false })).toEqual(["--experimental-acp"]);
    expect(acpCommandArgs(findAcpAgent(OPENCODE_CLI_ID)!, "opencode/big-pickle")).toEqual(["acp", "--print-logs", "--log-level", "WARN"]);
  });

  it("signs Gemini in with an API key from the environment, never interactively", () => {
    const gemini = findAcpAgent(GEMINI_CLI_ID)!;
    const methods = [
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "gemini-api-key", name: "Use Gemini API key" },
    ];
    expect(gemini.autoAuth!(methods, { GEMINI_API_KEY: "k" })).toBe("gemini-api-key");
    expect(gemini.autoAuth!(methods, {})).toBeNull();
    expect(gemini.autoAuth!([methods[0]], { GEMINI_API_KEY: "k" })).toBeNull();
  });
});

describe("OpenCode's permission rules", () => {
  it("makes edits, commands and web access ask, keeping the user's other rules and denials", () => {
    expect(JSON.parse(openCodePermissionEnv({}).OPENCODE_PERMISSION!)).toEqual({ edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask" });
    const env = openCodePermissionEnv({ OPENCODE_PERMISSION: JSON.stringify({ bash: "deny", read: "allow", edit: "allow" }), PATH: "/bin" });
    expect(JSON.parse(env.OPENCODE_PERMISSION!)).toEqual({ bash: "deny", read: "allow", edit: "ask", webfetch: "ask", websearch: "ask" });
    expect(env.PATH).toBe("/bin");
    expect(JSON.parse(openCodePermissionEnv({ OPENCODE_PERMISSION: "not json" }).OPENCODE_PERMISSION!).edit).toBe("ask");
  });

  it("is applied by acpEnv together with the preset's variables", () => {
    const presets = acpPresets(mergeConfig({ acpAgents: { [OPENCODE_CLI_ID]: { env: { OPENCODE_EXTRA: "1" } } } }));
    const env = acpEnv(presets[0], { HOME: "/h" });
    expect(env.HOME).toBe("/h");
    expect(env.OPENCODE_EXTRA).toBe("1");
    expect(JSON.parse(env.OPENCODE_PERMISSION!).bash).toBe("ask");
    expect(acpEnv(findAcpAgent(GEMINI_CLI_ID)!, { HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});

describe("OpenCode's log lines", () => {
  it("finds the provider error in an ERROR line (as `opencode acp --print-logs` prints it)", () => {
    const line =
      'timestamp=2026-10-25T14:25:01.122Z level=ERROR run=a01868a2 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_1 small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"';
    expect(openCodeLogError(line)).toBe(
      "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
    );
    expect(openCodeLogError('level=ERROR message="stream error" error.error="AI_RetryError: Failed after 3 attempts. Last error: Rate limited \\"slow down\\""')).toBe('Rate limited "slow down"');
    expect(openCodeLogError('level=WARN message="x" error.error="AI_APICallError: nope"')).toBeNull();
    expect(openCodeLogError('level=ERROR message="failed to fetch messages"')).toBeNull();
    expect(openCodeLogError("panic: something broke")).toBeNull();
    expect(findAcpAgent(OPENCODE_CLI_ID)!.stderrError).toBe(openCodeLogError);
    expect(findAcpAgent(GEMINI_CLI_ID)!.stderrError).toBeNull();
  });
});

describe("config.json acpAgents", () => {
  it("adds custom agents and drops malformed entries", () => {
    const config = mergeConfig({
      acpAgents: {
        goose: { name: "Goose", command: "goose", args: ["acp"], env: { GOOSE_MODE: "auto", BAD: 3 }, models: ["gpt-6", " ", 4], modelArgs: ["--model", "{model}"], toolPrefix: "luminal__" },
        "no-command": { name: "Nothing to run" },
        "bad id!": { command: "x" },
        weird: "not an object",
      },
    });
    const presets = acpPresets(config);
    expect(presets.map((p) => p.id)).toEqual([OPENCODE_CLI_ID, GEMINI_CLI_ID, "goose"]);
    const goose = findAcpAgent("goose", config)!;
    expect(goose).toMatchObject({ name: "Goose", command: "goose", args: ["acp"], env: { GOOSE_MODE: "auto" }, toolPrefix: "luminal__", builtin: false, models: "static" });
    expect(goose.staticModels).toEqual([{ id: "gpt-6", name: "gpt-6" }]);
    expect(acpCommandArgs(goose, "gpt-6")).toEqual(["acp", "--model", "gpt-6"]);
    expect(goose.signIn).toContain("Goose");
    expect(findAcpAgent("no-command", config)).toBeNull();
    expect(findAcpAgent("nope", config)).toBeNull();
    expect(acpPresets(defaultConfig()).map((p) => p.id)).toEqual([OPENCODE_CLI_ID, GEMINI_CLI_ID]);
    expect(acpPresets(null)).toHaveLength(2);
  });

  it("lets an entry with a builtin id change that agent", () => {
    const config = mergeConfig({
      acpAgents: { [GEMINI_CLI_ID]: { command: "~/bin/gemini", args: ["--acp"], models: ["gemini-next"], name: "Gemini (work)" } },
    });
    const gemini = findAcpAgent(GEMINI_CLI_ID, config)!;
    expect(gemini).toMatchObject({ name: "Gemini (work)", command: "~/bin/gemini", args: ["--acp"], builtin: true, toolPrefix: "" });
    expect(gemini.staticModels.at(-1)).toEqual({ id: "gemini-next", name: "gemini-next" });
    expect(gemini.staticModels.length).toBeGreaterThan(1);
    expect(acpCommandArgs(gemini, "gemini-next")).toEqual(["--acp", "--model", "gemini-next"]);
  });

  it("is kept by mergeConfig and defaults to an empty object", () => {
    expect(defaultConfig().acpAgents).toEqual({});
    expect(mergeConfig({ acpAgents: [1] }).acpAgents).toEqual({});
    expect(mergeConfig({ acpAgents: { x: { command: "x" } } }).acpAgents).toEqual({ x: { command: "x" } });
  });
});

describe("detection", () => {
  it("finds a program on the PATH or in its known places", () => {
    const home = path.join(os.tmpdir(), "home-luna");
    const oc = findAcpAgent(OPENCODE_CLI_ID)!;
    const onPath = fakeFinder({ opencode: "/usr/bin/opencode" });
    expect(findAcpProgram(oc, { find: onPath.find, home, platform: "linux" })).toBe("/usr/bin/opencode");
    expect(onPath.calls[0].extra).toContain(path.posix.join(home, ".opencode", "bin", "opencode"));

    const installed = path.posix.join(home, ".opencode", "bin", "opencode");
    const offPath = fakeFinder({}, [installed]);
    expect(findAcpProgram(oc, { find: offPath.find, home, platform: "linux" })).toBe(installed);

    const win = fakeFinder({});
    findAcpProgram(oc, { find: win.find, home: "C:\\Users\\luna", env: { APPDATA: "C:\\Users\\luna\\AppData\\Roaming" }, platform: "win32" });
    expect(win.calls[0].extra).toEqual(
      expect.arrayContaining(["C:\\Users\\luna\\.opencode\\bin\\opencode.exe", "C:\\Users\\luna\\AppData\\Roaming\\npm\\opencode.cmd"]),
    );
    const gemini = findAcpAgent(GEMINI_CLI_ID)!;
    const g = fakeFinder({});
    expect(findAcpProgram(gemini, { find: g.find, home: "/home/luna", platform: "darwin" })).toBeNull();
    expect(g.calls[0].extra).toEqual(expect.arrayContaining(["/opt/homebrew/bin/gemini", "/home/luna/.npm-global/bin/gemini"]));
  });

  it("uses a configured path as it is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-acp-bin-"));
    try {
      const exe = path.join(dir, process.platform === "win32" ? "my-agent.cmd" : "my-agent");
      fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
      const config = mergeConfig({ acpAgents: { mine: { command: exe } } });
      expect(findAcpProgram(findAcpAgent("mine", config)!)).toBe(exe);
      const missing = mergeConfig({ acpAgents: { mine: { command: path.join(dir, "nope") } } });
      expect(findAcpProgram(findAcpAgent("mine", missing)!)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every agent with where it is installed", () => {
    const config = mergeConfig({ acpAgents: { goose: { command: "goose", args: ["acp"] } } });
    const { find } = fakeFinder({ opencode: "/usr/bin/opencode", goose: "/usr/local/bin/goose" });
    expect(detectAcpAgents(config, { find, home: "/home/luna", platform: "linux" }).map((d) => [d.preset.id, d.exe])).toEqual([
      [OPENCODE_CLI_ID, "/usr/bin/opencode"],
      [GEMINI_CLI_ID, null],
      ["goose", "/usr/local/bin/goose"],
    ]);
  });
});
