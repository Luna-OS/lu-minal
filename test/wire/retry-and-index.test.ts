import { afterEach, describe, expect, it, vi } from "vitest";
import { streamWithRetry } from "../../src/providers/retry.js";
import { ProviderError, type ChatRequest, type WireKind } from "../../src/providers/types.js";
import { createChatClient, parseSSE } from "../../src/providers/wire/index.js";
import { collect, collectUntilError, doneOf, fakeFetch, jsonResponse, sse, sseResponse, textOf } from "./helpers.js";

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "m",
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  ...over,
});

const okStreams: Record<WireKind, () => string> = {
  "openai-chat": () =>
    sse([
      { data: { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] } },
      { data: "[DONE]" },
    ]),
  "openai-responses": () =>
    sse([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "m", delta: "Hello" } },
      { event: "response.completed", data: { type: "response.completed", response: { status: "completed", output: [] } } },
    ]),
  anthropic: () =>
    sse([
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ]),
};

const paths: Record<WireKind, string> = {
  "openai-chat": "chat/completions",
  "openai-responses": "responses",
  anthropic: "messages",
};

describe("streamWithRetry with the wire clients", () => {
  for (const wire of Object.keys(okStreams) as WireKind[]) {
    it(`${wire}: retries a 503 that happens before the first event`, async () => {
      const { fetch, calls } = fakeFetch(
        () => jsonResponse(503, { error: { message: "Service temporarily unavailable" } }, { "retry-after": "2" }),
        () => sseResponse(okStreams[wire]()),
      );
      const client = createChatClient(wire, { baseURL: "https://api.test/v1/", apiKey: "k" }, fetch);
      const sleeps: number[] = [];
      const retries: unknown[] = [];
      const out = await collect(
        streamWithRetry(client, request(), {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          onRetry: (error) => retries.push(error),
        }),
      );
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.url === `https://api.test/v1/${paths[wire]}`)).toBe(true);
      expect(sleeps).toEqual([2000]);
      expect(retries).toHaveLength(1);
      expect(retries[0]).toBeInstanceOf(ProviderError);
      expect(retries[0]).toMatchObject({ status: 503 });
      expect(textOf(out)).toBe("Hello");
      expect(doneOf(out).message.content).toBe("Hello");
    });
  }

  it("does not retry an error that comes after the first event", async () => {
    const broken = sse([
      { data: { choices: [{ index: 0, delta: { content: "Hel" } }] } },
      { data: { error: { code: 503, message: "upstream went away" } } },
    ]);
    const { fetch, calls } = fakeFetch(() => sseResponse(broken), () => sseResponse(okStreams["openai-chat"]()));
    const client = createChatClient("openai-chat", { baseURL: "https://api.test/v1" }, fetch);
    const { events, error } = await collectUntilError(streamWithRetry(client, request(), { sleep: async () => {} }));
    expect(textOf(events)).toBe("Hel");
    expect(error).toMatchObject({ status: 503, message: "upstream went away" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(401, { error: { message: "bad key" } }));
    const client = createChatClient("anthropic", { baseURL: "https://api.test/v1" }, fetch);
    const { error } = await collectUntilError(streamWithRetry(client, request(), { sleep: async () => {} }));
    expect(error).toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });
});

describe("createChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("picks the client for each wire", () => {
    for (const wire of ["openai-chat", "openai-responses", "anthropic"] as const) {
      expect(createChatClient(wire, { baseURL: "https://x" }).wire).toBe(wire);
    }
    expect(() => createChatClient("grpc" as WireKind, { baseURL: "https://x" })).toThrow(/Unknown wire/);
  });

  it("uses globalThis.fetch (looked up at call time) when no fetch is given", async () => {
    const client = createChatClient("openai-chat", { baseURL: "https://x/v1" });
    const stub = vi.fn(async () => sseResponse(okStreams["openai-chat"]()));
    vi.stubGlobal("fetch", stub);
    const out = await collect(client.stream(request()));
    expect(stub).toHaveBeenCalledTimes(1);
    expect((stub.mock.calls[0] as unknown[])[0]).toBe("https://x/v1/chat/completions");
    expect(textOf(out)).toBe("Hello");
  });

  it("passes the request's signal to fetch, and an abort ends the stream", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse([{ data: { choices: [{ index: 0, delta: { content: "Hi" } }] } }])));
      },
      pull() {
        return new Promise(() => {}); // stalls
      },
    });
    const { fetch, calls } = fakeFetch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const client = createChatClient("openai-chat", { baseURL: "https://x/v1" }, fetch);
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of client.stream(request({ signal: controller.signal }))) {
          if (e.type === "text") {
            seen.push(e.text);
            controller.abort();
          }
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0].signal).toBe(controller.signal);
    expect(seen).toEqual(["Hi"]);
  });

  it("re-exports parseSSE", () => {
    expect(typeof parseSSE).toBe("function");
  });
});

describe("quota exhaustion", () => {
  it("does not retry a free-tier quota that is used up", async () => {
    const { ProviderError } = await import("../../src/providers/types.js");
    const { isQuotaExhausted, isRetryable } = await import("../../src/providers/retry.js");
    const free = new ProviderError(
      "Free usage limit reached. Free models work in OpenCode (https://opencode.ai)",
      429,
      null,
      '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}',
    );
    expect(isQuotaExhausted(free)).toBe(true);
    expect(isRetryable(free)).toBe(false);
    const busy = new ProviderError("Too many requests", 429, 1000);
    expect(isQuotaExhausted(busy)).toBe(false);
    expect(isRetryable(busy)).toBe(true);
  });
});
