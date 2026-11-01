// Sign-ins over ACP (Antigravity's way) and the models a session lists, against the fake ACP agent.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAcpModels, saveAcpModels } from "../../src/agents/acp/models.js";
import {
  acpCommandArgs,
  acpReady,
  acpSignedIn,
  ANTIGRAVITY_ID,
  ANTIGRAVITY_REGISTRY_ID,
  builtinAcpPresets,
  findAcpProgram,
  setAcpSignedIn,
  type AcpPreset,
} from "../../src/agents/acp/presets.js";
import { parseSessionModels, probeAcpModels, signInAcp } from "../../src/agents/acp/signin.js";

const FAKE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tempHome = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lu-signin-"));
  dirs.push(d);
  return d;
};

const antigravity = (): AcpPreset => builtinAcpPresets().find((p) => p.id === ANTIGRAVITY_ID)!;

/** Antigravity's preset, signing in the fake agent's way. */
function fakePreset(): AcpPreset {
  return { ...antigravity(), acpSignIn: { methodId: "fake-login", label: "fake account" } };
}

function fakeRun(env: NodeJS.ProcessEnv) {
  const children: ChildProcess[] = [];
  return {
    children,
    opts: {
      exe: process.execPath,
      env: { ...process.env, ...env },
      spawnImpl: (_exe: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        const child = spawn(process.execPath, [FAKE, ...args], options);
        children.push(child);
        return child;
      },
    },
  };
}

describe("parseSessionModels", () => {
  it("reads the model option (groups too) or the older availableModels", () => {
    const result = {
      configOptions: [
        { id: "mode", category: "mode", type: "select", options: [{ value: "plan", name: "Plan" }] },
        {
          id: "model",
          category: "model",
          type: "select",
          options: [
            { value: "gemini-4-argon", name: "Gemini 4 Argon" },
            { group: "Others", options: [{ value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { value: "gemini-4-argon" }] },
          ],
        },
      ],
    };
    expect(parseSessionModels(result, "antigravity").map((m) => [m.id, m.name, m.provider])).toEqual([
      ["gemini-4-argon", "Gemini 4 Argon", "antigravity"],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", "antigravity"],
    ]);
    expect(parseSessionModels({ models: { availableModels: [{ modelId: "a", name: "A" }] } }, "x").map((m) => m.id)).toEqual(["a"]);
    expect(parseSessionModels(null, "x")).toEqual([]);
  });
});

describe("signing in over ACP", () => {
  it("authenticates with the chosen method, then reads the account's models in an empty folder", async () => {
    const log = path.join(tempHome(), "log.jsonl");
    const run = fakeRun({ FAKE_ACP_AUTH: "1", FAKE_ACP_LOG: log });
    const models = await signInAcp(fakePreset(), { ...run.opts, methodId: "fake-login" });
    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle", "opencode/beam-free", "anthropic/claude-sonnet-5-5"]);
    type Msg = { method?: string; params?: { methodId?: string; cwd?: string } };
    const sent = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { in?: Msg }).in ?? {});
    expect(sent.filter((m) => m.method).map((m) => m.method)).toEqual(["initialize", "authenticate", "session/new"]);
    expect(sent.find((m) => m.method === "authenticate")?.params?.methodId).toBe("fake-login");
    // Not the user's folders: a fresh, empty one, removed afterwards.
    const cwd = sent.find((m) => m.method === "session/new")?.params?.cwd ?? "";
    expect(path.basename(cwd)).toMatch(/^lu-minal-acp-/);
    // The process ends (taskkill takes a moment on Windows), then its folder goes.
    await vi.waitFor(() => expect(run.children.every((c) => c.exitCode !== null || c.signalCode !== null)).toBe(true), { timeout: 5000, interval: 100 });
    await vi.waitFor(() => expect(fs.existsSync(cwd)).toBe(false), { timeout: 5000, interval: 100 });
  });

  it("says so when the agent doesn't offer the method", async () => {
    const run = fakeRun({});
    await expect(signInAcp(fakePreset(), { ...run.opts, methodId: "oauth-personal" })).rejects.toThrow(/doesn't offer "oauth-personal"/);
  });

  it("lists the models only when signed in (or a key is set), signing in the remembered way", async () => {
    const home = tempHome();
    const env = { LU_MINAL_HOME: home, FAKE_ACP_AUTH: "1", GEMINI_API_KEY: "" };
    const preset = fakePreset();
    await expect(probeAcpModels(preset, fakeRun(env).opts)).rejects.toThrow(/Authentication required/);
    // Antigravity signs in again with the method lu-minal noted (the fake offers fake-login).
    setAcpSignedIn(ANTIGRAVITY_ID, "fake-login", { ...process.env, ...env });
    const models = await probeAcpModels(preset, fakeRun(env).opts);
    expect(models).toHaveLength(3);
  });
});

describe("Google Antigravity's preset", () => {
  it("runs the downloaded program with the registry's arguments", () => {
    const home = tempHome();
    const env = { ...process.env, LU_MINAL_HOME: home };
    const preset = antigravity();
    expect(preset.download?.registryId).toBe(ANTIGRAVITY_REGISTRY_ID);
    expect(findAcpProgram(preset, { env })).toBeNull();
    // What download.ts leaves behind.
    const root = path.join(home, "state", "acp-agents");
    const exe = path.join(root, ANTIGRAVITY_REGISTRY_ID, "1.4.5", "agy_acp_server.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    fs.writeFileSync(
      path.join(root, ANTIGRAVITY_REGISTRY_ID, "installed.json"),
      JSON.stringify({ version: "1.4.5", exe: `${ANTIGRAVITY_REGISTRY_ID}/1.4.5/agy_acp_server.exe`, args: ["--uid="] }),
    );
    expect(findAcpProgram(preset, { env })).toBe(exe);
    expect(acpCommandArgs(preset, "gemini-4-argon", { env })).toEqual(["--uid="]);
  });

  it("is ready once signed in through lu-minal or with GEMINI_API_KEY", () => {
    const home = tempHome();
    const env = { LU_MINAL_HOME: home } as NodeJS.ProcessEnv;
    const preset = antigravity();
    expect(acpReady(preset, env)).toBe(false);
    expect(acpReady(preset, { ...env, GEMINI_API_KEY: "k" })).toBe(true);
    setAcpSignedIn(ANTIGRAVITY_ID, "oauth-personal", env);
    expect(acpSignedIn(ANTIGRAVITY_ID, env)).toBe("oauth-personal");
    expect(acpReady(preset, env)).toBe(true);
    expect(preset.autoAuth?.([{ id: "oauth-personal", name: "Google" }], env)).toBe("oauth-personal");
    setAcpSignedIn(ANTIGRAVITY_ID, null, env);
    expect(acpReady(preset, env)).toBe(false);
  });

  it("offers the models from the last sign-in until it can ask again", async () => {
    const cache = tempHome();
    const preset = antigravity();
    const models = parseSessionModels({ models: { availableModels: [{ modelId: "gemini-4-argon", name: "Gemini 4 Argon" }] } }, ANTIGRAVITY_ID);
    saveAcpModels(preset, cache, models);
    const list = await listAcpModels(preset, { exe: "agy", cacheDir: cache });
    expect(list.map((m) => m.id)).toEqual(["default", "gemini-4-argon"]);
  });
});
