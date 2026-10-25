import { describe, expect, it } from "vitest";
import { listOllamaModels, ollamaRoot } from "../../src/providers/ollama.js";
import { fakeFetch, json } from "./helpers.js";

/** What `GET /api/tags` returns on a real Ollama server. */
const TAGS = {
  models: [
    {
      name: "qwen3-coder:30b",
      model: "qwen3-coder:30b",
      modified_at: "2026-10-20T09:12:44.123456789+02:00",
      size: 18556701256,
      digest: "06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca",
      details: { parent_model: "", format: "gguf", family: "qwen3moe", families: ["qwen3moe"], parameter_size: "30.5B", quantization_level: "Q4_K_M" },
    },
    {
      name: "nomic-embed-text:latest",
      model: "nomic-embed-text:latest",
      modified_at: "2026-06-01T10:00:00Z",
      size: 274302450,
      digest: "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f",
      details: { format: "gguf", family: "nomic-bert", families: ["nomic-bert"], parameter_size: "137M", quantization_level: "F16" },
    },
    {
      name: "mxbai-large:latest",
      model: "mxbai-large:latest",
      modified_at: "2026-06-02T10:00:00Z",
      details: { family: "bert", families: ["bert"], parameter_size: "334M" },
    },
    {
      name: "llama3.3:70b",
      model: "llama3.3:70b",
      modified_at: "2026-08-15T18:30:00Z",
      details: { format: "gguf", family: "llama", families: ["llama"], parameter_size: "70.6B", quantization_level: "Q4_K_M" },
    },
    { name: "llama3.3:70b", model: "llama3.3:70b" },
    { model: "gpt-oss:20b" },
    { name: 42 },
    "garbage",
  ],
};

describe("listOllamaModels", () => {
  it("turns pulled models into ollama models", async () => {
    const fetchImpl = fakeFetch(() => json(TAGS));
    const models = await listOllamaModels(undefined, fetchImpl);
    expect(fetchImpl.calls[0].url).toBe("http://127.0.0.1:11434/api/tags");
    expect(fetchImpl.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(models.map((m) => m.id)).toEqual(["qwen3-coder:30b", "llama3.3:70b", "gpt-oss:20b"]);
    expect(models[0]).toEqual({
      id: "qwen3-coder:30b",
      name: "qwen3-coder:30b (30.5B)",
      provider: "ollama",
      wire: "openai-chat",
      baseURL: "http://127.0.0.1:11434/v1",
      contextWindow: null,
      maxOutput: null,
      toolCall: true,
      reasoning: false,
      free: true,
      cost: { input: 0, output: 0 },
      status: null,
      releaseDate: "2026-10-20",
    });
    expect(models[2]).toMatchObject({ name: "gpt-oss:20b", releaseDate: null });
  });

  it("accepts the root, a trailing slash or the /v1 URL", async () => {
    for (const base of ["http://192.168.1.20:11434", "http://192.168.1.20:11434/", "http://192.168.1.20:11434/v1/"]) {
      const fetchImpl = fakeFetch(() => json(TAGS));
      const models = await listOllamaModels(base, fetchImpl);
      expect(fetchImpl.calls[0].url).toBe("http://192.168.1.20:11434/api/tags");
      expect(models[0].baseURL).toBe("http://192.168.1.20:11434/v1");
    }
    expect(ollamaRoot("http://localhost:11434/api")).toBe("http://localhost:11434");
  });

  it("returns [] when Ollama isn't running or answers oddly", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(await listOllamaModels(undefined, fakeFetch(() => Promise.reject(refused)))).toEqual([]);
    expect(await listOllamaModels(undefined, fakeFetch(() => json({ error: "boom" }, 500)))).toEqual([]);
    expect(await listOllamaModels(undefined, fakeFetch(() => new Response("not json")))).toEqual([]);
    expect(await listOllamaModels(undefined, fakeFetch(() => json({ models: "nope" })))).toEqual([]);
    expect(await listOllamaModels(undefined, fakeFetch(() => json(null)))).toEqual([]);
    expect(await listOllamaModels(undefined, fakeFetch(() => json({ models: [] })))).toEqual([]);
  });

  it("gives up after 1.5 seconds", async () => {
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    expect(await listOllamaModels(undefined, hanging)).toEqual([]);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
  });
});
