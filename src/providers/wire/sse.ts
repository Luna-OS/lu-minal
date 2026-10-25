// Server-sent events: a small parser for the `text/event-stream` bodies all three wire protocols
// stream. It follows the WHATWG event-stream rules (LF, CRLF and lone CR line ends, multi-line
// `data:` fields, `:` comment lines, `event:` names) and, unlike a browser, also dispatches a last
// event that has no blank line after it, because some providers close the stream that way.
import { abortError } from "../retry.js";

/** One dispatched event: its `event:` name (null when none was given) and its joined `data:` lines. */
export interface SSEMessage {
  event: string | null;
  data: string;
}

/**
 * Reads `body` as an event stream and yields one message per event. Bytes are decoded as UTF-8
 * across chunk boundaries, so a chunk may end anywhere (even inside a multi-byte character or
 * between the CR and LF of a line end). An aborted `signal` cancels the body and throws an
 * `AbortError`; leaving the loop early (break / return) cancels the body too.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage, void, void> {
  if (signal?.aborted) {
    await body.cancel().catch(() => {});
    throw abortError();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let buffer = "";
  let eventName: string | null = null;
  let data = "";
  let hasData = false;
  let finished = false;

  /** Handles one line; returns the event a blank line dispatches. */
  const line = (text: string): SSEMessage | null => {
    if (text === "") {
      const message = hasData ? { event: eventName, data } : null;
      eventName = null;
      data = "";
      hasData = false;
      return message;
    }
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data = hasData ? `${data}\n${value}` : value;
      hasData = true;
    } else if (field === "event") {
      eventName = value === "" ? null : value;
    }
    // "id" and "retry" don't matter for a one-shot POST stream; unknown fields are ignored.
    return null;
  };

  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      }
      if (signal?.aborted) throw abortError();
      if (result.done) {
        finished = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(result.value, { stream: true });
      }

      let pos = 0;
      let cr = buffer.indexOf("\r");
      let lf = buffer.indexOf("\n");
      while (pos < buffer.length) {
        if (cr !== -1 && cr < pos) cr = buffer.indexOf("\r", pos);
        if (lf !== -1 && lf < pos) lf = buffer.indexOf("\n", pos);
        let end: number;
        let next: number;
        if (cr !== -1 && (lf === -1 || cr < lf)) {
          // A CR at the very end may be the first half of a CRLF split across chunks.
          if (cr === buffer.length - 1 && !finished) break;
          end = cr;
          next = buffer.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1;
        } else if (lf !== -1) {
          end = lf;
          next = lf + 1;
        } else {
          break;
        }
        const message = line(buffer.slice(pos, end));
        pos = next;
        if (message) yield message;
      }
      buffer = buffer.slice(pos);

      if (finished) {
        if (buffer !== "") {
          const message = line(buffer);
          buffer = "";
          if (message) yield message;
        }
        const last = line("");
        if (last) yield last;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) await reader.cancel().catch(() => {});
  }
}
