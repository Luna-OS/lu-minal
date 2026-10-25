import { describe, expect, it } from "vitest";
import { parseSSE, type SSEMessage } from "../../src/providers/wire/sse.js";
import { splitBytes, streamOf } from "./helpers.js";

async function all(chunks: Array<string | Uint8Array>, signal?: AbortSignal): Promise<SSEMessage[]> {
  const out: SSEMessage[] = [];
  for await (const m of parseSSE(streamOf(chunks), signal)) out.push(m);
  return out;
}

describe("parseSSE", () => {
  it("parses LF-separated events with and without event names", async () => {
    const text = 'event: message_start\ndata: {"a":1}\n\ndata: {"b":2}\n\n';
    expect(await all([text])).toEqual([
      { event: "message_start", data: '{"a":1}' },
      { event: null, data: '{"b":2}' },
    ]);
  });

  it("handles CRLF and lone CR line ends", async () => {
    const crlf = "event: ping\r\ndata: one\r\n\r\ndata: two\r\n\r\n";
    expect(await all([crlf])).toEqual([
      { event: "ping", data: "one" },
      { event: null, data: "two" },
    ]);
    expect(await all(["data: a\r\rdata: b\r\r"])).toEqual([
      { event: null, data: "a" },
      { event: null, data: "b" },
    ]);
  });

  it("does not see an extra blank line when CR and LF land in different chunks", async () => {
    // "data: x\r" | "\ndata: y\r\n\r\n" - the CRLF after x is one line end, not two.
    const events = await all(["data: x\r", "\ndata: y\r", "\n\r", "\n"]);
    expect(events).toEqual([{ event: null, data: "x\ny" }]);
  });

  it("joins multi-line data fields with newlines", async () => {
    const text = "data: first line\ndata: second line\ndata:\ndata: fourth\n\n";
    expect(await all([text])).toEqual([{ event: null, data: "first line\nsecond line\n\nfourth" }]);
  });

  it("ignores comments and unknown fields, and removes exactly one leading space", async () => {
    const text = ": keep-alive\n:another\nid: 7\nretry: 1000\nfoo: bar\ndata:no-space\n\ndata:   three spaces\n\n";
    expect(await all([text])).toEqual([
      { event: null, data: "no-space" },
      { event: null, data: "  three spaces" },
    ]);
  });

  it("treats a field name without a colon as an empty value", async () => {
    expect(await all(["data\n\n"])).toEqual([{ event: null, data: "" }]);
  });

  it("does not dispatch an event without data, and resets the event name after each event", async () => {
    const text = "event: lonely\n\ndata: plain\n\nevent: named\ndata: x\n\ndata: y\n\n";
    expect(await all([text])).toEqual([
      { event: null, data: "plain" },
      { event: "named", data: "x" },
      { event: null, data: "y" },
    ]);
  });

  it("decodes multi-byte UTF-8 split at every byte boundary", async () => {
    const text = 'event: delta\ndata: {"text":"h\u00e9llo \u{1F319} gr\u00fc\u00df \u4e16\u754c"}\n\n';
    const events = await all(splitBytes(text, [1]));
    expect(events).toEqual([{ event: "delta", data: '{"text":"h\u00e9llo \u{1F319} gr\u00fc\u00df \u4e16\u754c"}' }]);
  });

  it("survives arbitrary chunking of a long stream", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`event: e${i}\r\ndata: {"i":${i},"s":"\u00e4\u00f6\u00fc ${i}"}\r\n\r\n`);
    const text = `: hello\r\n\r\n${lines.join("")}`;
    const events = await all(splitBytes(text, [3, 1, 17, 2, 64, 5]));
    expect(events).toHaveLength(200);
    expect(events[137]).toEqual({ event: "e137", data: '{"i":137,"s":"\u00e4\u00f6\u00fc 137"}' });
  });

  it("dispatches a final event that has no trailing blank line", async () => {
    expect(await all(["data: one\n\n", "data: last"])).toEqual([
      { event: null, data: "one" },
      { event: null, data: "last" },
    ]);
    expect(await all(["event: end\ndata: [DONE]\n"])).toEqual([{ event: "end", data: "[DONE]" }]);
    expect(await all(["data: cr-terminated\r"])).toEqual([{ event: null, data: "cr-terminated" }]);
  });

  it("strips a UTF-8 byte order mark", async () => {
    expect(await all([new Uint8Array([0xef, 0xbb]), new Uint8Array([0xbf]), "data: x\n\n"])).toEqual([
      { event: null, data: "x" },
    ]);
  });

  it("yields nothing for an empty body", async () => {
    expect(await all([])).toEqual([]);
  });

  it("stops with an AbortError and cancels the body when the signal aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new TextEncoder().encode("data: first\n\n"));
        }
        // then hang forever, like a stalled connection
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: string[] = [];
    const run = (async () => {
      for await (const m of parseSSE(body, controller.signal)) {
        seen.push(m.data);
        setTimeout(() => controller.abort(), 5);
      }
    })();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["first"]);
    expect(cancelled).toBe(true);
  });

  it("throws at once for an already aborted signal", async () => {
    const body = streamOf(["data: x\n\n"]);
    const gen = parseSSE(body, AbortSignal.abort());
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(body.cancelled()).toBe(true);
  });

  it("cancels the body when the consumer stops early", async () => {
    const body = streamOf(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]);
    for await (const m of parseSSE(body)) {
      expect(m.data).toBe("1");
      break;
    }
    expect(body.cancelled()).toBe(true);
  });

  it("passes on a stream error", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls++ === 0) c.enqueue(new TextEncoder().encode("data: ok\n\n"));
        else c.error(new TypeError("terminated"));
      },
    });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const m of parseSSE(body)) seen.push(m.data);
      })(),
    ).rejects.toThrow("terminated");
    expect(seen).toEqual(["ok"]);
  });
});
