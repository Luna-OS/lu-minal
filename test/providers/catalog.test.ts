import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CATALOG_CACHE_FILE,
  baseURLFor,
  buildCatalog,
  builtinModels,
  builtinProviders,
  defaultBaseURL,
  fallbackCatalog,
  loadCatalog,
  parseModelsDev,
  sortProviders,
  templateVars,
  wireForNpm,
} from "../../src/providers/catalog.js";
import { FALLBACK_MODELS_DEV } from "../../src/providers/catalog-fallback.js";
import type { ModelInfo } from "../../src/providers/models.js";
import { fakeFetch, json, loadFixture, tempDir } from "./helpers.js";

const find = (models: ModelInfo[], provider: string, id: string) =>
  models.find((m) => m.provider === provider && m.id === id);

describe("wireForNpm / defaultBaseURL", () => {
  it("maps the OpenAI-compatible family to openai-chat", () => {
    for (const npm of [
      "@ai-sdk/openai-compatible",
      "@openrouter/ai-sdk-provider",
      "@ai-sdk/groq",
      "@ai-sdk/xai",
      "@ai-sdk/mistral",
      "@ai-sdk/deepinfra",
      "@ai-sdk/cerebras",
      "@ai-sdk/togetherai",
      "@ai-sdk/perplexity",
      "@ai-sdk/alibaba",
      "@ai-sdk/cohere",
      "@ai-sdk/google",
      "venice-ai-sdk-provider",
      "@aihubmix/ai-sdk-provider",
    ]) {
      expect(wireForNpm(npm), npm).toBe("openai-chat");
    }
  });

  it("maps Anthropic and OpenAI to their own wires", () => {
    expect(wireForNpm("@ai-sdk/anthropic")).toBe("anthropic");
    expect(wireForNpm("@ai-sdk/openai")).toBe("openai-responses");
  });

  it("returns null for SDKs lu-minal can't speak", () => {
    for (const npm of [
      "@ai-sdk/amazon-bedrock",
      "@ai-sdk/amazon-bedrock/mantle",
      "@ai-sdk/google-vertex",
      "@ai-sdk/google-vertex/anthropic",
      "@ai-sdk/azure",
      "@ai-sdk/gateway",
      "@jerome-benoit/sap-ai-provider-v2",
      "watsonx-ai-provider",
      "gitlab-ai-provider",
      "",
      null,
      undefined,
    ]) {
      expect(wireForNpm(npm), String(npm)).toBeNull();
    }
  });

  it("knows default base URLs without trailing slashes", () => {
    expect(defaultBaseURL("@ai-sdk/groq", "groq")).toBe("https://api.groq.com/openai/v1");
    expect(defaultBaseURL("@ai-sdk/xai", "xai")).toBe("https://api.x.ai/v1");
    expect(defaultBaseURL("@ai-sdk/mistral", "mistral")).toBe("https://api.mistral.ai/v1");
    expect(defaultBaseURL("@ai-sdk/deepinfra", "deepinfra")).toBe("https://api.deepinfra.com/v1/openai");
    expect(defaultBaseURL("@ai-sdk/cerebras", "cerebras")).toBe("https://api.cerebras.ai/v1");
    expect(defaultBaseURL("@ai-sdk/togetherai", "togetherai")).toBe("https://api.together.xyz/v1");
    expect(defaultBaseURL("@ai-sdk/perplexity", "perplexity")).toBe("https://api.perplexity.ai");
    expect(defaultBaseURL("@ai-sdk/alibaba", "alibaba")).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(defaultBaseURL("@ai-sdk/cohere", "cohere")).toBe("https://api.cohere.ai/compatibility/v1");
    expect(defaultBaseURL("@ai-sdk/google", "google")).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(defaultBaseURL("venice-ai-sdk-provider", "venice")).toBe("https://api.venice.ai/api/v1");
    expect(defaultBaseURL("@aihubmix/ai-sdk-provider", "aihubmix")).toBe("https://aihubmix.com/v1");
    expect(defaultBaseURL("@ai-sdk/anthropic", "anthropic")).toBe("https://api.anthropic.com/v1");
    expect(defaultBaseURL("@ai-sdk/openai", "openai")).toBe("https://api.openai.com/v1");
    expect(defaultBaseURL("@openrouter/ai-sdk-provider", "openrouter")).toBe("https://openrouter.ai/api/v1");
  });

  it("has no default for a bare openai-compatible provider it doesn't know", () => {
    expect(defaultBaseURL("@ai-sdk/openai-compatible", "somebody")).toBeNull();
    expect(defaultBaseURL("@ai-sdk/openai-compatible", "lmstudio")).toBe("http://127.0.0.1:1234/v1");
    expect(defaultBaseURL("@ai-sdk/amazon-bedrock", "amazon-bedrock")).toBeNull();
  });

  it("prefers the catalog's api, strips slashes and rejects non-http URLs", () => {
    expect(baseURLFor("@ai-sdk/openai-compatible", "https://api.deepseek.com///", "deepseek")).toBe("https://api.deepseek.com");
    expect(baseURLFor("@ai-sdk/openai-compatible", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", "x")).toBeNull();
    expect(baseURLFor("@ai-sdk/groq", undefined, "groq")).toBe("https://api.groq.com/openai/v1");
  });

  it("appends /openai to a native Gemini root", () => {
    expect(baseURLFor("@ai-sdk/google", "https://opencode.ai/inference/google/v1beta", "opencode")).toBe(
      "https://opencode.ai/inference/google/v1beta/openai",
    );
    expect(baseURLFor("@ai-sdk/google", "https://example.com/v1beta/openai/", "x")).toBe("https://example.com/v1beta/openai");
  });

  it("finds URL template variables", () => {
    expect(templateVars("https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/${X_1}/v1")).toEqual(["SNOWFLAKE_ACCOUNT", "X_1"]);
    expect(templateVars("https://api.x.ai/v1")).toEqual([]);
    expect(templateVars(null)).toEqual([]);
  });
});

describe("parseModelsDev", () => {
  const { providers, models } = parseModelsDev(loadFixture());
  const provider = (id: string) => providers.find((p) => p.id === id)!;

  it("reads every provider with its wire, base URL, env and doc", () => {
    expect(providers.map((p) => p.id).sort()).toEqual(
      ["amazon-bedrock", "anthropic", "google", "groq", "lmstudio", "minimax", "openai", "opencode", "openrouter"].sort(),
    );
    expect(provider("opencode")).toMatchObject({
      name: "OpenCode",
      kind: "api",
      auth: "optional",
      wire: "openai-chat",
      baseURL: "https://opencode.ai/inference/openai/v1",
      env: ["OPENCODE_API_KEY"],
      supported: true,
    });
    expect(provider("openrouter")).toMatchObject({ auth: "oauth", wire: "openai-chat", baseURL: "https://openrouter.ai/api/v1" });
    expect(provider("anthropic")).toMatchObject({ auth: "api-key", wire: "anthropic", baseURL: "https://api.anthropic.com/v1" });
    expect(provider("openai")).toMatchObject({ wire: "openai-responses", baseURL: "https://api.openai.com/v1" });
    expect(provider("google")).toMatchObject({
      wire: "openai-chat",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    });
    expect(provider("minimax")).toMatchObject({ wire: "anthropic", baseURL: "https://api.minimax.io/anthropic/v1" });
    expect(provider("groq")).toMatchObject({ wire: "openai-chat", baseURL: "https://api.groq.com/openai/v1" });
    expect(provider("lmstudio")).toMatchObject({ kind: "local", auth: "none", baseURL: "http://127.0.0.1:1234/v1" });
    expect(provider("anthropic").doc).toBe("https://docs.anthropic.com/en/docs/about-claude/models");
  });

  it("marks providers it can't speak as unsupported", () => {
    expect(provider("amazon-bedrock")).toMatchObject({ wire: null, baseURL: null, supported: false });
    expect(models.filter((m) => m.provider === "amazon-bedrock").every((m) => m.wire === null)).toBe(true);
  });

  it("lets a model's own provider.npm / provider.api win", () => {
    expect(find(models, "opencode", "claude-opus-5-5")).toMatchObject({
      wire: "anthropic",
      baseURL: "https://opencode.ai/inference/anthropic/v1",
    });
    expect(find(models, "opencode", "gpt-6.1-sol")).toMatchObject({
      wire: "openai-responses",
      baseURL: "https://opencode.ai/inference/openai/v1",
    });
    expect(find(models, "opencode", "gemini-4-argon")).toMatchObject({
      wire: "openai-chat",
      baseURL: "https://opencode.ai/inference/google/v1beta/openai",
    });
    // Only an api override: the provider's npm stays.
    expect(find(models, "opencode", "big-pickle")).toMatchObject({
      wire: "openai-chat",
      baseURL: "https://opencode.ai/inference/openai/v1",
    });
    // A deprecated free model with an Anthropic override.
    expect(find(models, "opencode", "minimax-m3-free")).toMatchObject({ wire: "anthropic", free: true, status: "deprecated" });
  });

  it("detects free models from a zero price", () => {
    const free = models.filter((m) => m.free).map((m) => `${m.provider}/${m.id}`);
    expect(free).toEqual(
      expect.arrayContaining([
        "opencode/big-pickle",
        "opencode/glm-5.3-flash-free",
        "opencode/nemotron-3-ultra-free",
        "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
        "openrouter/poolside/laguna-s-2.1:free",
        "lmstudio/qwen/qwen3-coder-30b",
      ]),
    );
    expect(find(models, "opencode", "kimi-k2.5")!.free).toBe(false);
    expect(find(models, "anthropic", "claude-opus-5-5")!.free).toBe(false);
  });

  it("treats a missing price as not free, except on local servers", () => {
    const gemma = find(models, "google", "gemma-4-26b-a4b-it")!;
    expect(gemma.cost).toBeNull();
    expect(gemma.free).toBe(false);

    const local = parseModelsDev({
      lmstudio: {
        id: "lmstudio",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        name: "LMStudio",
        models: { "qwen/qwen3-8b": { id: "qwen/qwen3-8b", name: "Qwen3 8B", tool_call: true, modalities: { input: ["text"], output: ["text"] } } },
      },
    });
    expect(local.models[0]).toMatchObject({ free: true, cost: null, baseURL: "http://127.0.0.1:1234/v1" });
  });

  it("maps prices, limits, flags and dates", () => {
    expect(find(models, "anthropic", "claude-opus-5-5")).toMatchObject({
      name: "Claude Opus 5.5",
      provider: "anthropic",
      toolCall: true,
      reasoning: true,
      contextWindow: 1_000_000,
      releaseDate: "2026-09-22",
      status: null,
    });
    const cost = find(models, "anthropic", "claude-opus-5-5")!.cost!;
    expect(cost.input).toBeGreaterThan(0);
    expect(typeof cost.cacheRead).toBe("number");
    expect(find(models, "minimax", "MiniMax-M2.7")!.status).toBe("deprecated");
  });

  it("skips models that don't write text and non-chat types", () => {
    expect(find(models, "google", "gemini-3.1-flash-tts-preview")).toBeUndefined(); // audio out
    expect(find(models, "openai", "gpt-image-1.5")).toBeUndefined(); // type image
    expect(find(models, "groq", "whisper-large-v3")).toBeUndefined(); // transcription
    expect(find(models, "groq", "canopylabs/orpheus-v1-english")).toBeUndefined(); // speech
    // Text plus audio still counts; the registry's toolsOnly filter drops it from agent pickers.
    expect(find(models, "openrouter", "google/lyria-3-clip-preview")).toMatchObject({ toolCall: false });
  });

  it("drops URL-template variables from the key env list and still supports templated models", () => {
    const parsed = parseModelsDev({
      snowflake: {
        id: "snowflake",
        npm: "@ai-sdk/openai-compatible",
        api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
        env: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_CORTEX_PAT"],
        name: "Snowflake",
        models: { m: { id: "m", tool_call: true } },
      },
      gateway: {
        id: "gateway",
        npm: "ai-gateway-provider",
        env: ["GW_TOKEN", "GW_ACCOUNT"],
        name: "Gateway",
        models: {
          a: { id: "a", tool_call: true, provider: { npm: "@ai-sdk/openai", api: "https://gw.example/${GW_ACCOUNT}/openai" } },
          b: { id: "b", tool_call: true },
        },
      },
    });
    const snow = parsed.providers.find((p) => p.id === "snowflake")!;
    expect(snow.env).toEqual(["SNOWFLAKE_CORTEX_PAT"]);
    expect(snow.baseURL).toContain("${SNOWFLAKE_ACCOUNT}");
    const gw = parsed.providers.find((p) => p.id === "gateway")!;
    expect(gw).toMatchObject({ wire: null, supported: true, env: ["GW_TOKEN"] });
    expect(parsed.models.find((m) => m.id === "a")).toMatchObject({ wire: "openai-responses" });
    expect(parsed.models.find((m) => m.id === "b")).toMatchObject({ wire: null, baseURL: null });
  });

  it("never throws on garbage", () => {
    expect(parseModelsDev(null)).toEqual({ providers: [], models: [] });
    expect(parseModelsDev([1, 2])).toEqual({ providers: [], models: [] });
    const odd = parseModelsDev({ x: "nope", y: { models: { z: 5, w: { tool_call: "yes", limit: { context: -1 } } } } });
    expect(odd.providers.map((p) => p.id)).toEqual(["y"]);
    expect(odd.models).toHaveLength(1);
    expect(odd.models[0]).toMatchObject({ id: "w", name: "w", toolCall: false, contextWindow: null });
  });
});

describe("builtins", () => {
  it("adds claude-code and ollama", () => {
    const [claude, ollama] = builtinProviders();
    expect(claude).toMatchObject({ id: "claude-code", name: "Claude (subscription)", kind: "claude-code", auth: "cli", wire: null, featured: true });
    expect(ollama).toMatchObject({ id: "ollama", kind: "local", auth: "none", wire: "openai-chat", baseURL: "http://127.0.0.1:11434/v1" });
  });

  it("offers the CLI aliases and every non-dated Anthropic model", () => {
    const anthropic = parseModelsDev(loadFixture()).models.filter((m) => m.provider === "anthropic");
    const models = builtinModels(anthropic);
    const ids = models.map((m) => m.id);
    expect(ids.slice(0, 4)).toEqual(["default", "opus", "sonnet", "haiku"]);
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-sonnet-4-5"]));
    expect(ids).not.toContain("claude-sonnet-4-5-20250929");
    expect(models.every((m) => m.provider === "claude-code" && m.toolCall && !m.free && m.cost === null && m.wire === null)).toBe(true);
    expect(models[0].name).toBe("Default - your plan's model");
    // An alias borrows its family's newest context window, but has no date.
    expect(models[1]).toMatchObject({ id: "opus", contextWindow: 1_000_000, releaseDate: null });
  });
});

describe("buildCatalog / fallback", () => {
  it("orders providers featured first, then alphabetically, and marks eight featured", () => {
    const catalog = buildCatalog(loadFixture(), "cache", 1);
    expect(catalog.providers.map((p) => p.id)).toEqual([
      "claude-code",
      "opencode",
      "openrouter",
      "anthropic",
      "openai",
      "google",
      "minimax",
      "ollama",
      "lmstudio",
      "amazon-bedrock",
      "groq",
    ]);
    expect(catalog.providers.filter((p) => p.featured).map((p) => p.id)).toEqual([
      "claude-code",
      "opencode",
      "openrouter",
      "anthropic",
      "openai",
      "google",
      "minimax",
      "ollama",
    ]);
    expect(catalog.models.some((m) => m.provider === "claude-code" && m.id === "opus")).toBe(true);
  });

  it("features lmstudio when an earlier featured provider is missing", () => {
    const fixture = loadFixture();
    delete fixture.minimax;
    const catalog = buildCatalog(fixture, "network", 1);
    expect(catalog.providers.find((p) => p.id === "lmstudio")!.featured).toBe(true);
    expect(catalog.providers.find((p) => p.id === "groq")!.featured).toBe(false);
  });

  it("lets builtins replace same-id catalog entries", () => {
    const fixture = loadFixture();
    fixture.ollama = { id: "ollama", npm: "@ai-sdk/openai-compatible", env: [], name: "Old", models: { x: { id: "x", tool_call: true } } };
    const catalog = buildCatalog(fixture, "network", 1);
    expect(catalog.providers.filter((p) => p.id === "ollama")).toHaveLength(1);
    expect(catalog.providers.find((p) => p.id === "ollama")!.name).toBe("Ollama");
    expect(catalog.models.some((m) => m.provider === "ollama")).toBe(false);
  });

  it("sorts unknown providers by name", () => {
    const sorted = sortProviders([
      { id: "zeta", name: "Zeta" },
      { id: "alpha", name: "alpha" },
      { id: "openai", name: "OpenAI" },
    ] as never);
    expect(sorted.map((p) => p.id)).toEqual(["openai", "alpha", "zeta"]);
  });

  it("ships a usable fallback", () => {
    const catalog = fallbackCatalog();
    expect(catalog.source).toBe("fallback");
    expect(catalog.fetchedAt).toBeNull();
    const ids = new Set(catalog.providers.map((p) => p.id));
    for (const id of ["opencode", "openrouter", "anthropic", "openai", "google", "minimax", "groq", "deepseek", "zai", "moonshotai", "xai", "mistral", "lmstudio", "claude-code", "ollama"]) {
      expect(ids.has(id), id).toBe(true);
    }
    const free = catalog.models.filter((m) => m.provider === "opencode" && m.free);
    expect(free.length).toBeGreaterThanOrEqual(3);
    expect(free.every((m) => m.toolCall && m.status !== "deprecated")).toBe(true);
    expect(catalog.models.some((m) => m.provider === "openrouter" && m.id.endsWith(":free"))).toBe(true);
    expect(find(catalog.models, "anthropic", "claude-opus-5-5")).toBeDefined();
    expect(find(catalog.models, "claude-code", "claude-fable-5-1")).toBeDefined();
    expect(Object.keys(FALLBACK_MODELS_DEV as object).length).toBe(13);
  });
});

describe("loadCatalog", () => {
  let dir: string;
  let cleanup: () => void;
  const NOW = 1_800_000_000_000;
  const HOUR = 60 * 60 * 1000;
  const cacheFile = () => path.join(dir, CATALOG_CACHE_FILE);
  const writeCacheFile = (fetchedAt: number, data: unknown) =>
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt, url: "https://models.dev/api.json", data }));

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it("uses a fresh cache without touching the network", async () => {
    writeCacheFile(NOW - HOUR, loadFixture());
    const fetchImpl = fakeFetch(() => {
      throw new Error("no network in this test");
    });
    const catalog = await loadCatalog({ cacheDir: dir, fetchImpl, now: () => NOW });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(catalog.source).toBe("cache");
    expect(catalog.fetchedAt).toBe(NOW - HOUR);
    expect(catalog.providers.some((p) => p.id === "minimax")).toBe(true);
    expect(catalog.providers[0].id).toBe("claude-code");
  });

  it("downloads when the cache is stale and writes the cache atomically", async () => {
    const stale = { opencode: loadFixture().opencode };
    writeCacheFile(NOW - 30 * HOUR, stale);
    const fetchImpl = fakeFetch(() => json(loadFixture()));
    const catalog = await loadCatalog({ cacheDir: dir, fetchImpl, now: () => NOW, url: "https://example.test/api.json" });
    expect(fetchImpl.calls.map((c) => c.url)).toEqual(["https://example.test/api.json"]);
    expect(fetchImpl.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(catalog.source).toBe("network");
    expect(catalog.fetchedAt).toBe(NOW);
    expect(catalog.providers.some((p) => p.id === "groq")).toBe(true);

    const written = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    expect(written.fetchedAt).toBe(NOW);
    expect(Object.keys(written.data)).toContain("groq");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("creates the cache dir when it is missing", async () => {
    const nested = path.join(dir, "a", "b");
    await loadCatalog({ cacheDir: nested, fetchImpl: fakeFetch(() => json(loadFixture())), now: () => NOW });
    expect(fs.existsSync(path.join(nested, CATALOG_CACHE_FILE))).toBe(true);
  });

  it("falls back to a stale cache when the download fails", async () => {
    writeCacheFile(NOW - 48 * HOUR, loadFixture());
    const catalog = await loadCatalog({ cacheDir: dir, fetchImpl: fakeFetch(() => json({ error: "down" }, 503)), now: () => NOW });
    expect(catalog.source).toBe("cache");
    expect(catalog.fetchedAt).toBe(NOW - 48 * HOUR);
  });

  it("falls back to the bundled snapshot with no cache and no network", async () => {
    const catalog = await loadCatalog({
      cacheDir: dir,
      fetchImpl: fakeFetch(() => Promise.reject(new TypeError("fetch failed"))),
      now: () => NOW,
    });
    expect(catalog.source).toBe("fallback");
    expect(catalog.providers.some((p) => p.id === "deepseek")).toBe(true);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it("rejects a download that isn't a catalog", async () => {
    for (const body of [{}, { hello: "world" }, []]) {
      const catalog = await loadCatalog({ cacheDir: dir, fetchImpl: fakeFetch(() => json(body)), now: () => NOW });
      expect(catalog.source).toBe("fallback");
    }
    const html = await loadCatalog({
      cacheDir: dir,
      fetchImpl: fakeFetch(() => new Response("<html>captive portal</html>", { status: 200 })),
      now: () => NOW,
    });
    expect(html.source).toBe("fallback");
  });

  it("gives up after the timeout", async () => {
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    const catalog = await loadCatalog({ cacheDir: dir, fetchImpl: hanging, timeoutMs: 50, now: () => NOW });
    expect(catalog.source).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("offline: never downloads, uses any cache however old", async () => {
    const fetchImpl = fakeFetch(() => json(loadFixture()));
    expect((await loadCatalog({ cacheDir: dir, fetchImpl, offline: true })).source).toBe("fallback");
    writeCacheFile(NOW - 1000 * HOUR, loadFixture());
    expect((await loadCatalog({ cacheDir: dir, fetchImpl, offline: true, now: () => NOW })).source).toBe("cache");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("treats a cache from the future as stale, and a broken cache as missing", async () => {
    writeCacheFile(NOW + 10 * HOUR, loadFixture());
    const fetchImpl = fakeFetch(() => json(loadFixture()));
    expect((await loadCatalog({ cacheDir: dir, fetchImpl, now: () => NOW })).source).toBe("network");

    fs.writeFileSync(cacheFile(), "{ not json");
    const broken = await loadCatalog({ cacheDir: dir, fetchImpl: fakeFetch(() => json({}, 500)), now: () => NOW });
    expect(broken.source).toBe("fallback");
  });

  it("accepts a plain api.json in the cache, aged by its mtime", async () => {
    fs.writeFileSync(cacheFile(), JSON.stringify(loadFixture()));
    const fetchImpl = fakeFetch(() => json({}, 500));
    const catalog = await loadCatalog({ cacheDir: dir, fetchImpl });
    expect(catalog.source).toBe("cache");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("honours maxAgeMs", async () => {
    writeCacheFile(NOW - 2 * HOUR, loadFixture());
    const fetchImpl = fakeFetch(() => json(loadFixture()));
    const catalog = await loadCatalog({ cacheDir: dir, fetchImpl, now: () => NOW, maxAgeMs: HOUR });
    expect(catalog.source).toBe("network");
  });
});
