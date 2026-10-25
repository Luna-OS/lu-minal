import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acpDefaultModel, parseOpenCodeModels } from "../../src/agents/acp/models.js";
import type { AcpPreset } from "../../src/agents/acp/presets.js";
import { defaultConfig, type Config } from "../../src/core/config.js";
import { AuthStore } from "../../src/providers/auth.js";
import { acpBuiltinModels, acpBuiltinProviders, buildCatalog } from "../../src/providers/catalog.js";
import { formatModelRef, parseModelRef } from "../../src/providers/models.js";
import { ProviderNotReadyError, ProviderRegistry } from "../../src/providers/registry.js";
import { loadFixture, tempDir } from "../providers/helpers.js";

describe("ACP providers", () => {
  let cleanup: () => void;
  let config: Config;
  let installed: Record<string, string>;
  let asked: string[];
  let registry: ProviderRegistry;

  beforeEach(() => {
    const t = tempDir();
    cleanup = t.cleanup;
    config = defaultConfig();
    installed = {};
    asked = [];
    registry = new ProviderRegistry({
      catalog: buildCatalog(loadFixture(), "cache", 1),
      auth: new AuthStore(path.join(t.dir, "auth.json")),
      config,
      env: {},
      claudeAccount: () => null,
      acpProgram: (preset: AcpPreset) => {
        asked.push(preset.id);
        return installed[preset.command] ?? null;
      },
    });
  });
  afterEach(() => cleanup());

  it("are catalog builtins of kind acp, signed in by their CLI", () => {
    expect(acpBuiltinProviders()).toEqual([
      { id: "opencode-cli", name: "OpenCode (CLI)", kind: "acp", auth: "cli", wire: null, baseURL: null, env: [], doc: "https://opencode.ai/docs/acp/", supported: true, featured: false },
      { id: "gemini-cli", name: "Gemini CLI", kind: "acp", auth: "cli", wire: null, baseURL: null, env: [], doc: "https://github.com/google-gemini/gemini-cli", supported: true, featured: false },
    ]);
    const models = acpBuiltinModels();
    expect(models.filter((m) => m.id === "default").map((m) => m.provider)).toEqual(["opencode-cli", "gemini-cli"]);
    expect(models.some((m) => m.provider === "gemini-cli" && m.id === "gemini-3.8-flash")).toBe(true);
  });

  it("are listed with the other providers, custom ones from config.json too", () => {
    config.acpAgents = { goose: { name: "Goose", command: "goose", args: ["acp"], models: ["gpt-6"] } };
    const ids = registry.providers().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["opencode-cli", "gemini-cli", "goose"]));
    expect(ids.filter((id) => id === "opencode-cli")).toHaveLength(1);
    expect(registry.provider("goose")).toMatchObject({ id: "goose", name: "Goose", kind: "acp", auth: "cli", supported: true });
    expect(registry.acpPreset("goose")).toMatchObject({ command: "goose", args: ["acp"] });
    expect(registry.acpPreset("opencode")).toBeNull(); // the HTTP provider stays what it is
    // The featured order is unchanged.
    expect(registry.providers().slice(0, 4).map((p) => p.id)).toEqual(["claude-code", "opencode", "openrouter", "anthropic"]);
  });

  it("never shadow catalog or custom HTTP providers", () => {
    config.acpAgents = { groq: { command: "groq-acp" }, "my-vllm": { command: "x" } };
    config.providers["my-vllm"] = { baseURL: "http://localhost:8000/v1" };
    expect(registry.provider("groq")?.kind).toBe("api");
    expect(registry.provider("my-vllm")?.kind).toBe("local");
    expect(registry.acpPreset("groq")).toBeNull();
    expect(registry.acpPreset("my-vllm")).toBeNull();
  });

  it("are connected when their program is installed", () => {
    expect(registry.isConnected("opencode-cli")).toBe(false);
    installed.opencode = "/usr/bin/opencode";
    expect(registry.isConnected("opencode-cli")).toBe(true);
    expect(registry.acpProgram("opencode-cli")).toBe("/usr/bin/opencode");
    expect(registry.isConnected("gemini-cli")).toBe(false);
    expect(asked).toContain("gemini-cli");
  });

  it("explain how to install and sign in", () => {
    expect(registry.connectionHint("opencode-cli")).toBe(
      "Install OpenCode (CLI) (npm install -g opencode-ai (or: curl -fsSL https://opencode.ai/install | bash)). OpenCode's free models need no sign-in; run `opencode auth login` to add your own providers (Anthropic, OpenAI, GitHub Copilot, ...).",
    );
    installed.gemini = "/usr/bin/gemini";
    expect(registry.connectionHint("gemini-cli")).toContain("Login with Google");
    config.acpAgents = { goose: { command: "goose" } };
    expect(registry.connectionHint("goose")).toContain("`goose` was not found");
  });

  it("offer 'default' first, their own models, and accept any id the CLI knows", () => {
    expect(registry.models("opencode-cli").map((m) => m.id)).toEqual(["default"]);
    registry.setLocalModels("opencode-cli", parseOpenCodeModels("opencode/big-pickle\nanthropic/claude-sonnet-5-5\n"));
    expect(registry.models("opencode-cli").map((m) => m.id)).toEqual(["default", "opencode/big-pickle", "anthropic/claude-sonnet-5-5"]);
    const gemini = registry.models("gemini-cli").map((m) => m.id);
    expect(gemini[0]).toBe("default");
    expect(gemini).toContain("gemini-4-argon");
    // The model id is the CLI's own "provider/model": the ref keeps every slash.
    const ref = parseModelRef("opencode-cli/opencode/big-pickle")!;
    expect(ref).toEqual({ provider: "opencode-cli", model: "opencode/big-pickle" });
    expect(formatModelRef(ref)).toBe("opencode-cli/opencode/big-pickle");
    expect(registry.model({ provider: "opencode-cli", model: "openai/gpt-6-sol" })).toMatchObject({ id: "openai/gpt-6-sol", provider: "opencode-cli", wire: null, baseURL: null });
  });

  it("resolve without an endpoint once installed", () => {
    let err: unknown;
    try {
      registry.resolve({ provider: "opencode-cli", model: "default" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderNotReadyError);
    expect((err as ProviderNotReadyError).message).toBe("OpenCode (CLI) isn't installed.");
    expect((err as ProviderNotReadyError).hint).toContain("npm install -g opencode-ai");
    installed.opencode = "/usr/bin/opencode";
    const resolved = registry.resolve({ provider: "opencode-cli", model: "opencode/big-pickle" });
    expect(resolved).toMatchObject({ endpoint: null, wire: null, provider: { kind: "acp" }, model: { id: "opencode/big-pickle" } });
  });

  it("stay out of the free list (their free models are listed by their own providers)", () => {
    installed.opencode = "/usr/bin/opencode";
    registry.setLocalModels("opencode-cli", [{ ...acpDefaultModel({ id: "opencode-cli", name: "OpenCode" }), id: "opencode/big-pickle", free: true }]);
    expect(registry.freeModels().some((m) => m.provider === "opencode-cli")).toBe(false);
    expect(registry.search("big pickle").map((m) => `${m.provider}/${m.id}`)).toEqual(expect.arrayContaining(["opencode/big-pickle", "opencode-cli/opencode/big-pickle"]));
  });

  it("caches where a program is for a minute and forgets it on refreshAcp()", () => {
    const t = tempDir();
    try {
      const real = new ProviderRegistry({
        catalog: buildCatalog(loadFixture(), "cache", 1),
        auth: new AuthStore(path.join(t.dir, "auth.json")),
        config: defaultConfig(),
        env: { PATH: "" },
        claudeAccount: () => null,
      });
      expect(real.isConnected("gemini-cli")).toBe(false);
      real.refreshAcp();
      expect(real.acpProgram("gemini-cli")).toBeNull();
      expect(real.acpProgram("groq")).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});
