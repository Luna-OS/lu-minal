// The real `opencode acp`, when it is installed: the handshake and a session, with HOME pointed at
// a temp dir so the user's own OpenCode config is never touched. No prompt is sent (that would
// need a model provider). Set LU_MINAL_TEST_OPENCODE to an opencode binary to run it elsewhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAcpModels } from "../../src/agents/acp/models.js";
import { acpEnv, findAcpAgent } from "../../src/agents/acp/presets.js";
import { RpcPeer } from "../../src/agents/acp/rpc.js";
import { killTree, spawnProgram } from "../../src/platform/process.js";

const OPENCODE =
  process.env.LU_MINAL_TEST_OPENCODE ??
  "/tmp/claude-0/-home-user-lu-minal/27aae692-276c-5495-9990-69155bcc1ebc/scratchpad/oc/node_modules/.bin/opencode";
const available = fs.existsSync(OPENCODE);

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
  };
}

describe.skipIf(!available)("the real opencode acp", () => {
  it("answers initialize and session/new the way the driver expects", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lm-oc-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "lm-oc-proj-"));
    const preset = findAcpAgent("opencode-cli")!;
    const child = spawnProgram(OPENCODE, preset.args, {
      cwd: project,
      env: acpEnv(preset, isolatedEnv(home)),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stderr?.resume(); // its log lines (--print-logs) must not fill the pipe
    const rpc = new RpcPeer({ input: child.stdout!, output: child.stdin! });
    try {
      const init = await rpc.request<any>(
        "initialize",
        { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "lu-minal", version: "test" } },
        { timeoutMs: 90_000 },
      );
      expect(init.protocolVersion).toBe(1);
      expect(init.agentCapabilities.mcpCapabilities.http).toBe(true);
      expect(init.agentInfo.name).toBe("OpenCode");
      expect(init.authMethods.map((m: any) => m.id)).toContain("opencode-login");

      const session = await rpc.request<any>("session/new", { cwd: project, mcpServers: [] }, { timeoutMs: 90_000 });
      expect(session.sessionId).toMatch(/^ses_/);
      const model = session.configOptions.find((o: any) => o.category === "model");
      expect(model).toMatchObject({ id: "model", type: "select" });
      expect(model.options.some((o: any) => o.value === model.currentValue)).toBe(true);
      expect(model.options.every((o: any) => /^[^/\s]+\/\S+$/.test(o.value))).toBe(true);
      const mode = session.configOptions.find((o: any) => o.category === "mode");
      expect(mode.options.map((o: any) => o.value)).toEqual(expect.arrayContaining(["build", "plan"]));

      // Model selection the way the driver does it.
      const other = model.options.find((o: any) => o.value !== model.currentValue && o.value.startsWith("opencode/"));
      if (other) {
        const set = await rpc.request<any>("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: other.value }, { timeoutMs: 30_000 });
        expect(set.configOptions.find((o: any) => o.id === "model").currentValue).toBe(other.value);
      }
    } finally {
      rpc.close();
      killTree(child);
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 120_000);

  it("lists its models with `opencode models --verbose`", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lm-oc-home-"));
    try {
      const models = await listAcpModels(findAcpAgent("opencode-cli")!, { exe: OPENCODE, env: isolatedEnv(home), timeoutMs: 90_000 });
      expect(models[0].id).toBe("default");
      expect(models.slice(1).every((m) => /^[^/\s]+\/\S+$/.test(m.id) && m.provider === "opencode-cli")).toBe(true);
      // models.dev is reachable from most machines; offline, only "default" is left.
      if (models.length > 1) expect(models.some((m) => m.id.startsWith("opencode/"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
