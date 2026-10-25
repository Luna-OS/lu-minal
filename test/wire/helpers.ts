// Test helpers for the wire clients: byte streams cut at awkward places, SSE text, and a fake
// fetch that records each request and answers with prepared responses.
import type { FetchLike, StreamEvent } from "../../src/providers/types.js";

const encoder = new TextEncoder();

/** A body that emits `chunks` one by one (strings are UTF-8 encoded). */
export function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> & { cancelled: () => boolean } {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return Object.assign(stream, { cancelled: () => cancelled });
}

/**
 * Cuts the UTF-8 bytes of `text` into pieces whose sizes cycle through `sizes`, so chunk borders
 * land inside JSON strings, line ends and multi-byte characters.
 */
export function splitBytes(text: string, sizes: number[] = [1, 7, 3, 13, 2, 29, 5]): Uint8Array[] {
  const bytes = encoder.encode(text);
  const out: Uint8Array[] = [];
  let pos = 0;
  let k = 0;
  while (pos < bytes.length) {
    const size = Math.max(1, sizes[k++ % sizes.length]);
    out.push(bytes.slice(pos, pos + size));
    pos += size;
  }
  return out;
}

/** SSE text for `events` (data objects are JSON-encoded). */
export function sse(events: Array<{ event?: string; data: unknown }>, eol = "\n"): string {
  return events
    .map((e) => {
      const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
      return `${e.event ? `event: ${e.event}${eol}` : ""}data: ${data}${eol}${eol}`;
    })
    .join("");
}

/** A 200 event-stream response whose body arrives in awkward chunks. */
export function sseResponse(text: string, sizes?: number[]): Response {
  return new Response(streamOf(splitBytes(text, sizes)), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

/** A JSON response with a status (and optional headers). */
export function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface RecordedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: any;
  signal: AbortSignal | null | undefined;
}

/** A fetch that records requests and answers with `responses` in order (a function is called). */
export function fakeFetch(...responses: Array<Response | (() => Response)>): { fetch: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  let n = 0;
  const fetch: FetchLike = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      signal: init?.signal,
    });
    const next = responses[Math.min(n++, responses.length - 1)];
    if (!next) throw new Error("fakeFetch: no response prepared");
    return typeof next === "function" ? next() : next;
  };
  return { fetch, calls };
}

/** Runs a stream to the end and returns its events. */
export async function collect(gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Runs a stream until it throws; returns the events before the error and the error. */
export async function collectUntilError(gen: AsyncIterable<StreamEvent>): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const e of gen) events.push(e);
  } catch (error) {
    return { events, error };
  }
  throw new Error("expected the stream to fail");
}

export const textOf = (events: StreamEvent[]) =>
  events.map((e) => (e.type === "text" ? e.text : "")).join("");

export const reasoningOf = (events: StreamEvent[]) =>
  events.map((e) => (e.type === "reasoning" ? e.text : "")).join("");

export const doneOf = (events: StreamEvent[]) => {
  const last = events[events.length - 1];
  if (!last || last.type !== "done") throw new Error("the last event is not done");
  return last;
};
