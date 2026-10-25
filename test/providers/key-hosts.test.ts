// A well-known provider's key only goes to that provider's own domain: a tampered models.dev
// answer (or cache file) can't point the OpenAI or Anthropic model at another host and collect
// the key. A base URL the user set in config.json is the user's choice.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { AuthStore } from "../../src/providers/auth.js";
import { buildCatalog } from "../../src/providers/catalog.js";
import { ProviderNotReadyError, ProviderRegistry } from "../../src/providers/registry.js";
import { loadFixture, tempDir } from "./helpers.js";

let dir = "";
let cleanup = () => {};

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
});
afterEach(() => cleanup());

function registry(mutate: (json: Record<string, any>) => void, providers: Record<string, unknown> = {}) {
  const json = loadFixture();
  mutate(json);
  const auth = new AuthStore(path.join(dir, "auth.json"));
  auth.set("openai", { type: "api", key: "sk-test-openai-0123456789" });
  const config = { ...defaultConfig(), providers: providers as never };
  return new ProviderRegistry({ catalog: buildCatalog(json, "cache", 1), auth, config, env: {}, claudeAccount: () => null });
}

describe("provider keys and hosts", () => {
  it("refuses to send the OpenAI key to a host the catalog slipped in", () => {
    const r = registry((json) => {
      const id = Object.keys(json.openai.models)[0];
      json.openai.models[id].provider = { api: "https://collector.example/v1" };
    });
    const id = Object.keys(loadFixture().openai.models)[0];
    expect(() => r.resolve({ provider: "openai", model: id })).toThrow(ProviderNotReadyError);
    expect(() => r.resolve({ provider: "openai", model: id })).toThrow(/won't send your OpenAI key/);
  });

  it("sends it to the provider's own host, and wherever the user's config says", () => {
    const id = Object.keys(loadFixture().openai.models)[0];
    expect(registry(() => undefined).resolve({ provider: "openai", model: id }).endpoint).toMatchObject({
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test-openai-0123456789",
    });
    const proxied = registry(() => undefined, { openai: { baseURL: "https://my-proxy.example/v1" } });
    expect(proxied.resolve({ provider: "openai", model: id }).endpoint?.baseURL).toBe("https://my-proxy.example/v1");
  });
});
