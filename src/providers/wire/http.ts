// HTTP plumbing the three wire clients share: joining URLs, merging headers, the streaming POST,
// and turning error responses (and errors inside a stream) into ProviderErrors that carry what
// the retry logic (src/providers/retry.ts) needs: the status and Retry-After.
import { ProviderError, type FetchLike } from "../types.js";
import { isRecord, safeJsonParse } from "./convert.js";
import { parseSSE, type SSEMessage } from "./sse.js";

/** `globalThis.fetch`, looked up on every call (so tests and polyfills can replace it later). */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** "https://x/v1/" + "/chat/completions" -> "https://x/v1/chat/completions" (never "//"). */
export function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Merges header records left to right. Names are compared without case, so a caller's
 * "authorization" replaces the client's "Authorization" instead of being sent next to it.
 */
export function mergeHeaders(...parts: Array<Record<string, string> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const part of parts) {
    if (!part) continue;
    for (const [name, value] of Object.entries(part)) {
      if (typeof value !== "string") continue;
      const lower = name.toLowerCase();
      const previous = names.get(lower);
      if (previous !== undefined) delete out[previous];
      names.set(lower, name);
      out[name] = value;
    }
  }
  return out;
}

/**
 * How long a provider asked us to wait, in ms: `retry-after-ms` (OpenAI), then `Retry-After` as
 * seconds or as an HTTP date. Null when there is no usable header.
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\s*\d+(\.\d+)?\s*$/.test(ms)) return Math.round(Number(ms));
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return null;
  if (/^\s*\d+(\.\d+)?\s*$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

const MAX_MESSAGE = 1000;

function clip(text: string, max = MAX_MESSAGE): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
}

/**
 * The human-readable message in an error body, if there is one. Understands the shapes providers
 * use: `{error:{message}}` (OpenAI, Anthropic, OpenRouter; OpenRouter's `metadata.raw` is
 * appended), `{error:{error:{message}}}`, `{error:"..."}`, `{message}`, `{detail}`, and Gemini's
 * `[{error:{...}}]`.
 */
export function errorMessageFrom(text: string): string | null {
  let json = safeJsonParse(text);
  if (Array.isArray(json)) json = json[0];
  if (!isRecord(json)) return null;
  const err = json.error;
  if (typeof err === "string" && err.trim()) {
    return clip(typeof json.message === "string" && json.message.trim() ? `${err}: ${json.message}` : err);
  }
  if (isRecord(err)) {
    if (typeof err.message === "string" && err.message.trim()) {
      const raw = isRecord(err.metadata) ? err.metadata.raw : undefined;
      if (typeof raw === "string" && raw.trim() && !err.message.includes(raw)) {
        return clip(`${err.message}: ${raw}`);
      }
      return clip(err.message);
    }
    if (isRecord(err.error) && typeof err.error.message === "string" && err.error.message.trim()) {
      return clip(err.error.message);
    }
  }
  if (typeof json.message === "string" && json.message.trim()) return clip(json.message);
  if (typeof json.detail === "string" && json.detail.trim()) return clip(json.detail);
  if (Array.isArray(json.detail) && isRecord(json.detail[0]) && typeof json.detail[0].msg === "string") {
    return clip(json.detail[0].msg);
  }
  return null;
}

/** Builds the ProviderError for a non-2xx response (reads the body). */
export async function errorFromResponse(res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => "");
  let message = errorMessageFrom(text);
  if (!message) {
    const plain = text.trim();
    // HTML error pages (gateways, Cloudflare) say nothing useful in a terminal.
    message = plain && !plain.startsWith("<")
      ? clip(plain)
      : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  }
  return new ProviderError(message, res.status, parseRetryAfter(res.headers), text);
}

const CODE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  invalid_prompt: 400,
  context_length_exceeded: 400,
  string_above_max_length: 400,
  authentication_error: 401,
  invalid_api_key: 401,
  billing_error: 402,
  insufficient_quota: 402,
  permission_error: 403,
  not_found_error: 404,
  model_not_found: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  rate_limit_exceeded: 429,
  api_error: 500,
  server_error: 500,
  internal_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
  overloaded: 529,
};

/**
 * An HTTP-like status for an error that arrived inside a stream, from its `code` / `type`: a
 * number between 400 and 599 is taken as it is, known names are mapped ("rate_limit_exceeded" ->
 * 429, "overloaded_error" -> 529, ...), anything else gives `fallback`.
 */
export function statusForErrorCode(code: unknown, fallback = 500): number {
  if (typeof code === "number" && code >= 400 && code < 600) return Math.trunc(code);
  if (typeof code === "string") {
    if (/^\d{3}$/.test(code)) {
      const n = Number(code);
      if (n >= 400 && n < 600) return n;
    }
    const known = CODE_STATUS[code.toLowerCase()];
    if (known !== undefined) return known;
  }
  return fallback;
}

/** What a streaming POST answered with: an event stream, or (from some servers) plain JSON. */
export type StreamBody =
  | { kind: "events"; events: AsyncGenerator<SSEMessage, void, void> }
  | { kind: "json"; value: unknown; text: string };

/**
 * POSTs `body` as JSON and opens the answer. Non-2xx -> ProviderError (see `errorFromResponse`);
 * no body -> ProviderError (status 502, so it is retried); a JSON answer holding `error` ->
 * ProviderError; any other JSON answer is handed back for the client to convert.
 */
export async function openStream(opts: {
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}): Promise<StreamBody> {
  const res = await opts.fetchImpl(opts.url, {
    method: "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new ProviderError("The provider answered without a response body.", 502);
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("json") && !type.includes("event-stream")) {
    const text = await res.text();
    const value = safeJsonParse(text);
    if (value === undefined) {
      throw new ProviderError("The provider sent invalid JSON instead of an event stream.", 502, null, text);
    }
    const err = isRecord(value) ? value.error : undefined;
    if (err !== undefined && err !== null) {
      const status = isRecord(err) ? statusForErrorCode(err.code ?? err.status ?? err.type) : 500;
      throw new ProviderError(errorMessageFrom(text) ?? "The provider returned an error.", status, null, text);
    }
    return { kind: "json", value, text };
  }
  return { kind: "events", events: parseSSE(res.body, opts.signal) };
}
