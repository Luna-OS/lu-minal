import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acpDefaultModel, listAcpModels, parseOpenCodeModels, staticAcpModels } from "../../src/agents/acp/models.js";
import { findAcpAgent, GEMINI_CLI_ID, OPENCODE_CLI_ID } from "../../src/agents/acp/presets.js";

// `opencode models --verbose` output as OpenCode 1.19.4 prints it (shortened).
const VERBOSE = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "family": "big-pickle",
  "api": { "id": "big-pickle", "url": "https://opencode.ai/inference/openai/v1", "npm": "@ai-sdk/openai-compatible" },
  "status": "active",
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "limit": { "context": 200000, "input": 160000, "output": 32000 },
  "capabilities": { "temperature": true, "reasoning": true, "attachment": false, "toolcall": true },
  "release_date": "2025-10-17",
  "variants": {}
}
github-copilot/claude-sonnet-5.5
{
  "id": "claude-sonnet-5.5",
  "providerID": "github-copilot",
  "name": "Claude Sonnet 5.5",
  "status": "active",
  "cost": { "input": 3, "output": 15 },
  "limit": { "context": 1000000, "output": 64000 },
  "capabilities": { "reasoning": true, "toolcall": true },
  "release_date": "2026-09-01"
}
amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0
{
  "id": "anthropic.claude-haiku-4-5-20251001-v1:0",
  "providerID": "amazon-bedrock",
  "name": "Claude Haiku 4.5 {with braces}",
  "status": "deprecated",
  "capabilities": { "toolcall": false }
}
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lm-acp-models-"));
  dirs.push(d);
  return d;
};

describe("parseOpenCodeModels", () => {
  it("reads plain `opencode models` lines", () => {
    const models = parseOpenCodeModels("opencode/big-pickle\r\nopencode/beam-free\nanthropic/claude-sonnet-5-5\n\nWARN something\nopencode/big-pickle\n");
    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle", "opencode/beam-free", "anthropic/claude-sonnet-5-5"]);
    expect(models[0]).toMatchObject({ provider: "opencode-cli", name: "opencode/big-pickle", toolCall: true, wire: null, baseURL: null, free: false });
  });

  it("reads the metadata of --verbose output", () => {
    const models = parseOpenCodeModels(VERBOSE, "opencode-cli");
    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle", "github-copilot/claude-sonnet-5.5", "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"]);
    expect(models[0]).toMatchObject({
      name: "Big Pickle",
      contextWindow: 200000,
      maxOutput: 32000,
      free: true,
      cost: { input: 0, output: 0 },
      reasoning: true,
      toolCall: true,
      releaseDate: "2025-10-17",
      status: null,
    });
    expect(models[1]).toMatchObject({ name: "Claude Sonnet 5.5 (github-copilot)", free: false, cost: { input: 3, output: 15 }, contextWindow: 1_000_000 });
    expect(models[2]).toMatchObject({ name: "Claude Haiku 4.5 {with braces} (amazon-bedrock)", status: "deprecated", toolCall: false });
  });
});

describe("static models", () => {
  it("offers 'default' first, then the preset's list", () => {
    const gemini = staticAcpModels(findAcpAgent(GEMINI_CLI_ID)!);
    expect(gemini[0]).toMatchObject({ id: "default", name: "Default - Gemini CLI's own choice", provider: GEMINI_CLI_ID });
    expect(gemini.slice(1).map((m) => m.id)).toContain("gemini-4-argon");
    expect(gemini.every((m) => m.toolCall && m.wire === null && m.provider === GEMINI_CLI_ID)).toBe(true);
    expect(acpDefaultModel(findAcpAgent(OPENCODE_CLI_ID)!).name).toBe("Default - OpenCode's own choice");
    expect(staticAcpModels(findAcpAgent(OPENCODE_CLI_ID)!).map((m) => m.id)).toEqual(["default"]);
  });
});

describe("listAcpModels", () => {
  const opencode = findAcpAgent(OPENCODE_CLI_ID)!;

  it("asks `opencode models --verbose` once a day and caches the answer", async () => {
    const cacheDir = tempDir();
    const runs: Array<{ exe: string; args: string[]; permission: string | undefined }> = [];
    let now = 1_000_000;
    const run = async (exe: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
      runs.push({ exe, args, permission: o.env.OPENCODE_PERMISSION });
      return { code: 0, stdout: VERBOSE, stderr: "" };
    };
    const first = await listAcpModels(opencode, { exe: "/usr/bin/opencode", cacheDir, run, now: () => now, env: {} });
    expect(first.map((m) => m.id)).toEqual(["default", "opencode/big-pickle", "github-copilot/claude-sonnet-5.5", "amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ exe: "/usr/bin/opencode", args: ["models", "--verbose"] });
    expect(fs.existsSync(path.join(cacheDir, "acp-models-opencode-cli.json"))).toBe(true);

    now += 60_000;
    const cached = await listAcpModels(opencode, { exe: "/usr/bin/opencode", cacheDir, run, now: () => now });
    expect(cached.map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(runs).toHaveLength(1);

    // A day later, or on request, it asks again.
    await listAcpModels(opencode, { exe: "/usr/bin/opencode", cacheDir, run, now: () => now, refresh: true });
    now += 25 * 60 * 60 * 1000;
    await listAcpModels(opencode, { exe: "/usr/bin/opencode", cacheDir, run, now: () => now });
    expect(runs).toHaveLength(3);
  });

  it("falls back to a stale cache, then to 'default' alone, and never throws", async () => {
    const cacheDir = tempDir();
    let now = 0;
    const good = async () => ({ code: 0, stdout: "opencode/big-pickle\n", stderr: "" });
    await listAcpModels(opencode, { exe: "opencode", cacheDir, run: good, now: () => now });
    now += 3 * 24 * 60 * 60 * 1000;
    const broken = async (): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      throw new Error("spawn opencode ENOENT");
    };
    expect((await listAcpModels(opencode, { exe: "opencode", cacheDir, run: broken, now: () => now })).map((m) => m.id)).toEqual(["default", "opencode/big-pickle"]);
    expect((await listAcpModels(opencode, { exe: "opencode", run: broken })).map((m) => m.id)).toEqual(["default"]);
    const empty = async () => ({ code: 1, stdout: "Error: not configured\n", stderr: "" });
    expect((await listAcpModels(opencode, { exe: "opencode", run: empty })).map((m) => m.id)).toEqual(["default"]);
    expect((await listAcpModels(opencode, { exe: null })).map((m) => m.id)).toEqual(["default"]);
  });

  it("gives static agents their list without running anything", async () => {
    const gemini = findAcpAgent(GEMINI_CLI_ID)!;
    const run = async () => {
      throw new Error("must not run");
    };
    const models = await listAcpModels(gemini, { exe: "/usr/bin/gemini", run });
    expect(models[0].id).toBe("default");
    expect(models.length).toBe(gemini.staticModels.length + 1);
  });
});
