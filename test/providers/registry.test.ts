import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../src/core/config.js";
import type { ClaudeAccount } from "../../src/core/types.js";
import { AuthStore } from "../../src/providers/auth.js";
import { buildCatalog, type Catalog } from "../../src/providers/catalog.js";
import type { ModelInfo } from "../../src/providers/models.js";
import { listOllamaModels } from "../../src/providers/ollama.js";
import { OPENROUTER_HEADERS, ProviderNotReadyError, ProviderRegistry } from "../../src/providers/registry.js";
import { fakeFetch, json, loadFixture, tempDir } from "./helpers.js";

const signedIn: ClaudeAccount = {
  installed: true,
  exe: "/usr/local/bin/claude",
  version: "3.1.0",
  loggedIn: true,
  authMethod: "claude.ai",
  email: "luna@example.com",
  organization: null,
  plan: "max",
};

function notReady(fn: () => unknown): ProviderNotReadyError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderNotReadyError);
    return err as ProviderNotReadyError;
  }
  throw new Error("expected a ProviderNotReadyError");
}

describe("ProviderRegistry", () => {
  let dir: string;
  let cleanup: () => void;
  let auth: AuthStore;
  let config: Config;
  let env: NodeJS.ProcessEnv;
  let account: ClaudeAccount | null;
  let catalog: Catalog;
  let registry: ProviderRegistry;

  const make = (overrides: Partial<{ catalog: Catalog }> = {}) =>
    new ProviderRegistry({
      catalog: overrides.catalog ?? catalog,
      auth,
      config,
      env,
      claudeAccount: () => account,
    });

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    auth = new AuthStore(path.join(dir, "auth.json"));
    config = defaultConfig();
    env = {};
    account = null;
    catalog = buildCatalog(loadFixture(), "cache", 1);
    registry = make();
  });
  afterEach(() => cleanup());

  describe("resolve", () => {
    it("runs OpenCode's free models without a key, using the key 'public'", () => {
      const r = registry.resolve({ provider: "opencode", model: "big-pickle" });
      expect(r.wire).toBe("openai-chat");
      expect(r.endpoint).toEqual({ baseURL: "https://opencode.ai/inference/openai/v1", apiKey: "public" });
      expect(r.model.free).toBe(true);
      expect(r.provider.id).toBe("opencode");
    });

    it("asks for an OpenCode key for paid models, and uses one when there", () => {
      const err = notReady(() => registry.resolve({ provider: "opencode", model: "kimi-k2.5" }));
      expect(err.providerId).toBe("opencode");
      expect(err.hint).toContain("/login opencode");

      env.OPENCODE_API_KEY = "zen-key";
      expect(registry.resolve({ provider: "opencode", model: "kimi-k2.5" }).endpoint?.apiKey).toBe("zen-key");
      // The free ones then use the real key too.
      expect(registry.resolve({ provider: "opencode", model: "big-pickle" }).endpoint?.apiKey).toBe("zen-key");
    });

    it("follows a model-level wire and endpoint override", () => {
      env.OPENCODE_API_KEY = "zen-key";
      const opus = registry.resolve({ provider: "opencode", model: "claude-opus-5-5" });
      expect(opus.wire).toBe("anthropic");
      expect(opus.endpoint?.baseURL).toBe("https://opencode.ai/inference/anthropic/v1");
      const gpt = registry.resolve({ provider: "opencode", model: "gpt-6.1-sol" });
      expect(gpt.wire).toBe("openai-responses");
      expect(gpt.endpoint?.baseURL).toBe("https://opencode.ai/inference/openai/v1");
    });

    it("sends OpenRouter's attribution headers and the stored OAuth key", () => {
      auth.set("openrouter", { type: "oauth", key: "sk-or-v1-xyz", createdAt: 1 });
      const r = registry.resolve({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
      expect(r.endpoint).toEqual({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-v1-xyz",
        headers: { "HTTP-Referer": "https://github.com/Luna-OS/lu-minal", "X-Title": "lu-minal" },
      });
      expect(r.wire).toBe("openai-chat");
    });

    it("merges config headers over OpenRouter's", () => {
      env.OPENROUTER_API_KEY = "sk-or-env";
      config.providers.openrouter = { headers: { "X-Title": "my fork", "X-Extra": "1" } };
      const r = registry.resolve({ provider: "openrouter", model: "openai/gpt-6.1-sol" });
      expect(r.endpoint?.headers).toEqual({ ...OPENROUTER_HEADERS, "X-Title": "my fork", "X-Extra": "1" });
      expect(r.endpoint?.apiKey).toBe("sk-or-env");
    });

    it("accepts any OpenRouter model id", () => {
      env.OPENROUTER_API_KEY = "k";
      const r = registry.resolve({ provider: "openrouter", model: "mistralai/brand-new:free" });
      expect(r.model).toMatchObject({ id: "mistralai/brand-new:free", free: true, toolCall: true, wire: "openai-chat" });
    });

    it("needs an OpenRouter key and says how to get one", () => {
      const err = notReady(() => registry.resolve({ provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" }));
      expect(err.providerId).toBe("openrouter");
      expect(err.hint).toBe("Sign in with /login openrouter (opens your browser), or set OPENROUTER_API_KEY.");
      expect(err.message).toContain("OpenRouter");
    });

    it("talks to MiniMax over the Anthropic wire", () => {
      env.MINIMAX_API_KEY = "mm";
      const r = registry.resolve({ provider: "minimax", model: "MiniMax-M3" });
      expect(r.wire).toBe("anthropic");
      expect(r.endpoint).toEqual({ baseURL: "https://api.minimax.io/anthropic/v1", apiKey: "mm" });
    });

    it("prefers auth.json over the environment", () => {
      env.MINIMAX_API_KEY = "from-env";
      auth.set("minimax", { type: "api", key: "from-auth" });
      expect(registry.resolve({ provider: "minimax", model: "MiniMax-M3" }).endpoint?.apiKey).toBe("from-auth");
    });

    it("hands Claude Code models to the CLI (no endpoint, no wire)", () => {
      account = signedIn;
      const r = registry.resolve({ provider: "claude-code", model: "opus" });
      expect(r.endpoint).toBeNull();
      expect(r.wire).toBeNull();
      expect(r.provider.kind).toBe("claude-code");
      // The CLI takes ids lu-minal doesn't list.
      expect(registry.resolve({ provider: "claude-code", model: "opusplan" }).model.id).toBe("opusplan");
    });

    it("explains a missing or signed-out Claude Code", () => {
      account = { ...signedIn, loggedIn: false };
      expect(notReady(() => registry.resolve({ provider: "claude-code", model: "opus" })).hint).toBe(
        "Run /login claude to sign in with your Claude subscription.",
      );
      account = { ...signedIn, installed: false, loggedIn: false, exe: null };
      expect(notReady(() => registry.resolve({ provider: "claude-code", model: "sonnet" })).hint).toContain("Install Claude Code");
      // Not probed yet: let the driver find out.
      account = null;
      expect(registry.resolve({ provider: "claude-code", model: "sonnet" }).endpoint).toBeNull();
    });

    it("refuses unknown providers and models", () => {
      const unknown = notReady(() => registry.resolve({ provider: "nope", model: "x" }));
      expect(unknown.providerId).toBe("nope");
      expect(unknown.message).toBe('Unknown provider "nope".');
      env.ANTHROPIC_API_KEY = "a";
      const model = notReady(() => registry.resolve({ provider: "anthropic", model: "claude-imaginary-9" }));
      expect(model.hint).toContain("providers.anthropic.models");
    });

    it("refuses unsupported providers until config.json gives them a base URL", () => {
      env.AWS_BEARER_TOKEN_BEDROCK = "aws";
      const modelId = registry.models("amazon-bedrock", { includeDeprecated: true })[0].id;
      const err = notReady(() => registry.resolve({ provider: "amazon-bedrock", model: modelId }));
      expect(err.hint).toContain("providers.amazon-bedrock.baseURL");
      expect(registry.isConnected("amazon-bedrock")).toBe(false);

      config.providers["amazon-bedrock"] = { baseURL: "https://bedrock-proxy.internal/v1/" };
      const r = registry.resolve({ provider: "amazon-bedrock", model: modelId });
      expect(r.wire).toBe("openai-chat");
      expect(r.endpoint?.baseURL).toBe("https://bedrock-proxy.internal/v1");
      expect(registry.provider("amazon-bedrock")!.supported).toBe(true);
    });

    it("applies a config base URL to models that inherit it, not to ones with their own", () => {
      config.providers.opencode = { baseURL: "https://zen-proxy.example/v1", wire: "openai-chat" };
      expect(registry.resolve({ provider: "opencode", model: "big-pickle" }).endpoint?.baseURL).toBe("https://zen-proxy.example/v1");
      env.OPENCODE_API_KEY = "k";
      const opus = registry.resolve({ provider: "opencode", model: "claude-opus-5-5" });
      expect(opus.endpoint?.baseURL).toBe("https://opencode.ai/inference/anthropic/v1");
      expect(opus.wire).toBe("anthropic");
    });

    it("lets config change a provider's wire", () => {
      env.MINIMAX_API_KEY = "mm";
      config.providers.minimax = { baseURL: "https://api.minimax.io/v1", wire: "openai-chat" };
      const r = registry.resolve({ provider: "minimax", model: "MiniMax-M3" });
      expect(r.wire).toBe("openai-chat");
      expect(r.endpoint?.baseURL).toBe("https://api.minimax.io/v1");
    });

    it("fills URL templates from the environment", () => {
      const templated = buildCatalog(
        {
          snowflake: {
            id: "snowflake",
            npm: "@ai-sdk/openai-compatible",
            api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
            env: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_CORTEX_PAT"],
            name: "Snowflake Cortex",
            models: { "claude-sonnet-5-5": { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", tool_call: true } },
          },
        },
        "cache",
        1,
      );
      const reg = make({ catalog: templated });
      env.SNOWFLAKE_CORTEX_PAT = "pat";
      expect(reg.isConnected("snowflake")).toBe(false);
      expect(reg.connectionHint("snowflake")).toBe("Add a key with /login snowflake, or set SNOWFLAKE_CORTEX_PAT. Also set SNOWFLAKE_ACCOUNT.");
      const err = notReady(() => reg.resolve({ provider: "snowflake", model: "claude-sonnet-5-5" }));
      expect(err.hint).toContain("SNOWFLAKE_ACCOUNT");
      env.SNOWFLAKE_ACCOUNT = "acme";
      expect(reg.isConnected("snowflake")).toBe(true);
      expect(reg.resolve({ provider: "snowflake", model: "claude-sonnet-5-5" }).endpoint).toEqual({
        baseURL: "https://acme.snowflakecomputing.com/api/v2/cortex/v1",
        apiKey: "pat",
      });
    });

    it("runs local models without a key", () => {
      const r = registry.resolve({ provider: "lmstudio", model: "qwen/qwen3-coder-30b" });
      expect(r.endpoint).toEqual({ baseURL: "http://127.0.0.1:1234/v1" });
      expect(registry.resolve({ provider: "ollama", model: "qwen3:8b" }).endpoint).toEqual({ baseURL: "http://127.0.0.1:11434/v1" });
    });
  });

  describe("custom providers", () => {
    beforeEach(() => {
      config.providers["my-vllm"] = { name: "My vLLM", baseURL: "http://localhost:8000/v1/", models: ["qwen-coder", "qwen-coder", " "] };
      config.providers["team-proxy"] = { baseURL: "https://llm.team.example/v1", wire: "anthropic", models: ["claude-x"] };
      config.providers["no-url"] = { models: ["x"] };
      config.providers["bad-url"] = { baseURL: "ftp://example" };
    });

    it("lists providers declared in config.json with a base URL", () => {
      const ids = registry.providers().map((p) => p.id);
      expect(ids).toContain("my-vllm");
      expect(ids).toContain("team-proxy");
      expect(ids).not.toContain("no-url");
      expect(ids).not.toContain("bad-url");
      expect(registry.provider("my-vllm")).toMatchObject({
        name: "My vLLM",
        kind: "local",
        auth: "none",
        wire: "openai-chat",
        baseURL: "http://localhost:8000/v1",
        supported: true,
      });
      expect(registry.provider("team-proxy")).toMatchObject({ kind: "api", auth: "optional", wire: "anthropic", env: ["TEAM_PROXY_API_KEY"] });
    });

    it("offers their configured models and accepts any other id", () => {
      expect(registry.models("my-vllm").map((m) => m.id)).toEqual(["qwen-coder"]);
      const r = registry.resolve({ provider: "my-vllm", model: "whatever-7b" });
      expect(r.endpoint).toEqual({ baseURL: "http://localhost:8000/v1" });
      expect(r.model.free).toBe(true);
    });

    it("sends a key when one exists", () => {
      env.TEAM_PROXY_API_KEY = "t";
      config.providers["team-proxy"]!.headers = { "X-Team": "moon" };
      const r = registry.resolve({ provider: "team-proxy", model: "claude-x" });
      expect(r).toMatchObject({ wire: "anthropic", endpoint: { baseURL: "https://llm.team.example/v1", apiKey: "t", headers: { "X-Team": "moon" } } });
    });

    it("adds config.json's extra ids to catalog providers too", () => {
      config.providers.anthropic = { models: ["claude-next-6"] };
      env.ANTHROPIC_API_KEY = "a";
      expect(registry.models("anthropic").map((m) => m.id)).toContain("claude-next-6");
      expect(registry.resolve({ provider: "anthropic", model: "claude-next-6" }).wire).toBe("anthropic");
    });
  });

  describe("models", () => {
    it("lists newest first, without deprecated or tool-less models by default", () => {
      const ids = registry.models("openrouter").map((m) => m.id);
      expect(ids).not.toContain("google/lyria-3-clip-preview");
      expect(ids).not.toContain("poolside/laguna-s-2.1:free"); // deprecated
      const dates = registry.models("openrouter").map((m) => m.releaseDate ?? "");
      expect([...dates].sort().reverse()).toEqual(dates);

      expect(registry.models("openrouter", { toolsOnly: false }).map((m) => m.id)).toContain("google/lyria-3-clip-preview");
      const all = registry.models("openrouter", { includeDeprecated: true }).map((m) => m.id);
      expect(all[all.length - 1]).toBe("poolside/laguna-s-2.1:free");
    });

    it("puts Claude Code's aliases first", () => {
      expect(registry.models("claude-code").slice(0, 5).map((m) => m.id)).toEqual(["default", "opus", "sonnet", "haiku", "claude-haiku-5-5"]);
    });

    it("finds deprecated models by ref and synthesizes only where any id works", () => {
      expect(registry.model({ provider: "opencode", model: "minimax-m3-free" })?.status).toBe("deprecated");
      expect(registry.model({ provider: "opencode", model: "not-a-model" })).toBeUndefined();
      expect(registry.model({ provider: "anthropic", model: "claude-9" })).toBeUndefined();
      expect(registry.model({ provider: "nope", model: "x" })).toBeUndefined();
      expect(registry.model({ provider: "lmstudio", model: "my/gguf" })).toMatchObject({ free: true, wire: "openai-chat", baseURL: "http://127.0.0.1:1234/v1" });
      expect(registry.model({ provider: "openrouter", model: "x/y" })).toMatchObject({ free: false, cost: null });
    });

    it("lists Ollama's pulled models once they are set", async () => {
      expect(registry.models("ollama")).toEqual([]);
      const fetchImpl = fakeFetch(() =>
        json({
          models: [
            { name: "qwen3:8b", model: "qwen3:8b", modified_at: "2026-10-01T10:00:00Z", details: { parameter_size: "8.2B", family: "qwen3" } },
            { name: "llama3.3:70b", model: "llama3.3:70b", modified_at: "2026-09-01T10:00:00Z", details: { parameter_size: "70.6B" } },
          ],
        }),
      );
      registry.setLocalModels("ollama", await listOllamaModels(undefined, fetchImpl));
      expect(registry.models("ollama").map((m) => m.id)).toEqual(["qwen3:8b", "llama3.3:70b"]);
      expect(registry.resolve({ provider: "ollama", model: "qwen3:8b" })).toMatchObject({
        wire: "openai-chat",
        endpoint: { baseURL: "http://127.0.0.1:11434/v1" },
      });
      registry.setLocalModels("ollama", []);
      expect(registry.models("ollama")).toEqual([]);
    });
  });

  describe("free models", () => {
    const refs = (models: ModelInfo[]) => models.map((m) => `${m.provider}/${m.id}`);

    it("lists tool-calling, current, free models with OpenCode's first", () => {
      const free = refs(registry.freeModels());
      expect(free).toEqual(expect.arrayContaining(["opencode/big-pickle", "opencode/glm-5.3-flash-free", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"]));
      expect(free).not.toContain("opencode/minimax-m3-free"); // deprecated
      expect(free).not.toContain("openrouter/google/lyria-3-clip-preview"); // no tools
      expect(free[0].startsWith("opencode/")).toBe(true);
    });

    it("counts OpenCode as connected without a key, OpenRouter only with one", () => {
      let free = refs(registry.freeModels({ connectedOnly: true }));
      expect(free).toContain("opencode/big-pickle");
      expect(free.some((r) => r.startsWith("openrouter/"))).toBe(false);
      env.OPENROUTER_API_KEY = "k";
      free = refs(registry.freeModels({ connectedOnly: true }));
      expect(free).toContain("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    });
  });

  describe("sign-in state", () => {
    it("knows who is connected", () => {
      expect(registry.isConnected("claude-code")).toBe(false);
      account = { ...signedIn, loggedIn: false };
      expect(registry.isConnected("claude-code")).toBe(false);
      account = signedIn;
      expect(registry.isConnected("claude-code")).toBe(true);

      expect(registry.isConnected("opencode")).toBe(true);
      expect(registry.isConnected("ollama")).toBe(true);
      expect(registry.isConnected("lmstudio")).toBe(true);
      expect(registry.isConnected("openrouter")).toBe(false);
      expect(registry.isConnected("google")).toBe(false);
      env.GEMINI_API_KEY = "g";
      expect(registry.isConnected("google")).toBe(true);
      auth.set("groq", { type: "api", key: "gsk" });
      expect(registry.isConnected("groq")).toBe(true);
      expect(registry.isConnected("nope")).toBe(false);
    });

    it("explains how to sign in", () => {
      expect(registry.connectionHint("claude-code")).toBe("Install Claude Code (npm install -g @anthropic-ai/claude-code) and run /login claude.");
      account = { ...signedIn, loggedIn: false };
      expect(registry.connectionHint("claude-code")).toBe("Run /login claude to sign in with your Claude subscription.");
      expect(registry.connectionHint("openrouter")).toContain("/login openrouter");
      expect(registry.connectionHint("minimax")).toBe("Add a key with /login minimax, or set MINIMAX_API_KEY.");
      expect(registry.connectionHint("ollama")).toContain("ollama serve");
      expect(registry.connectionHint("amazon-bedrock")).toContain("can't talk to Amazon Bedrock");
      expect(registry.connectionHint("nope")).toContain("Unknown provider");
    });
  });

  describe("providers", () => {
    it("lists featured providers first", () => {
      expect(registry.providers().slice(0, 4).map((p) => p.id)).toEqual(["claude-code", "opencode", "openrouter", "anthropic"]);
    });

    it("applies config names and keeps catalog providers when overridden", () => {
      config.providers.groq = { name: "Groq (work)" };
      expect(registry.provider("groq")!.name).toBe("Groq (work)");
      expect(registry.providers().filter((p) => p.id === "groq")).toHaveLength(1);
    });

    it("swaps catalogs", () => {
      const small = buildCatalog({ deepseek: { id: "deepseek", npm: "@ai-sdk/openai-compatible", api: "https://api.deepseek.com", env: ["DEEPSEEK_API_KEY"], name: "DeepSeek", models: { "deepseek-v4-pro": { id: "deepseek-v4-pro", tool_call: true, release_date: "2026-08-13" } } } }, "network", 2);
      registry.setCatalog(small);
      expect(registry.provider("minimax")).toBeUndefined();
      expect(registry.models("deepseek").map((m) => m.id)).toEqual(["deepseek-v4-pro"]);
    });
  });

  describe("search", () => {
    const refs = (models: ModelInfo[]) => models.map((m) => `${m.provider}/${m.id}`);

    it("matches every term against provider/model and the name, case-insensitively", () => {
      const hits = refs(registry.search("Claude SONNET"));
      expect(hits).toEqual(expect.arrayContaining(["anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "claude-code/claude-sonnet-5-5"]));
      expect(hits.every((r) => r.toLowerCase().includes("sonnet"))).toBe(true);
      expect(refs(registry.search("openrouter nemotron free"))).toEqual(["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"]);
      expect(registry.search("big pickle").map((m) => m.id)).toEqual(["big-pickle"]); // via the name "Big Pickle"
      expect(registry.search("zzz-nothing")).toEqual([]);
    });

    it("ranks connected providers first", () => {
      // Nobody connected: the featured order decides.
      let hits = refs(registry.search("sonnet 5"));
      expect(hits[0]).toBe("claude-code/claude-sonnet-5-5");
      expect(hits.indexOf("openrouter/anthropic/claude-sonnet-5.5")).toBeLessThan(hits.indexOf("anthropic/claude-sonnet-5-5"));
      env.ANTHROPIC_API_KEY = "a";
      hits = refs(registry.search("sonnet 5"));
      expect(hits[0]).toBe("anthropic/claude-sonnet-5-5");
      account = signedIn;
      hits = refs(registry.search("sonnet 5"));
      expect(hits[0].startsWith("claude-code/")).toBe(true);
    });

    it("respects the limit and lists everything for an empty query", () => {
      expect(registry.search("claude", 3)).toHaveLength(3);
      expect(registry.search("").length).toBeGreaterThan(20);
      expect(registry.search("   ", 5)).toHaveLength(5);
    });
  });

  describe("defaults", () => {
    it("starts leads on Claude Code's Opus when signed in", () => {
      account = signedIn;
      expect(registry.defaultLeadModel()).toEqual({ provider: "claude-code", model: "opus" });
      expect(registry.defaultWorkerModel({ provider: "claude-code", model: "opus" })).toEqual({ provider: "claude-code", model: "sonnet" });
    });

    it("honours config.json's lead model when its provider is connected", () => {
      account = signedIn;
      config.leadModel = { provider: "minimax", model: "MiniMax-M3" };
      expect(registry.defaultLeadModel()).toEqual({ provider: "claude-code", model: "opus" });
      env.MINIMAX_API_KEY = "mm";
      expect(registry.defaultLeadModel()).toEqual({ provider: "minimax", model: "MiniMax-M3" });
    });

    it("picks the newest Claude Sonnet with an Anthropic key", () => {
      env.ANTHROPIC_API_KEY = "a";
      expect(registry.defaultLeadModel()).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    });

    it("picks a strong tool-calling model on OpenRouter", () => {
      env.OPENROUTER_API_KEY = "k";
      expect(registry.defaultLeadModel()).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
    });

    it("falls back to OpenCode's Big Pickle, else the free model with the largest context", () => {
      expect(registry.defaultLeadModel()).toEqual({ provider: "opencode", model: "big-pickle" });
      const fixture = loadFixture();
      delete fixture.opencode.models["big-pickle"];
      const reg = make({ catalog: buildCatalog(fixture, "cache", 1) });
      expect(reg.defaultLeadModel()).toEqual({ provider: "opencode", model: "nemotron-3-ultra-free" });
    });

    it("gives workers config's worker model, else the lead's", () => {
      const lead = { provider: "opencode", model: "big-pickle" };
      expect(registry.defaultWorkerModel(lead)).toEqual(lead);
      config.workerModel = { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" };
      expect(registry.defaultWorkerModel(lead)).toEqual(lead); // not connected
      env.OPENROUTER_API_KEY = "k";
      expect(registry.defaultWorkerModel(lead)).toEqual(config.workerModel);
    });
  });
});
