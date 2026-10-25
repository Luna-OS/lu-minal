// Retries for provider calls: 408/409/429/5xx and dropped connections get another try with
// exponential backoff (honouring Retry-After). A stream is only retried before its first event, so
// nothing the user already saw is repeated.
import { ProviderError, type ChatClient, type ChatRequest, type StreamEvent } from "./types.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/**
 * A 429 that won't clear up by waiting: a free tier's quota is used up (OpenCode Zen's
 * "FreeUsageLimitError", "quota exceeded", "insufficient_quota").
 */
export function isQuotaExhausted(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error.status !== 429) return false;
  return /free\s*usage\s*limit|FreeUsageLimitError|quota\s*(exceeded|reached)|insufficient_quota|exceeded your current quota/i.test(
    `${error.message} ${error.body}`,
  );
}

/** Whether an error is worth retrying: a retryable HTTP status or a dropped connection. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable && !isQuotaExhausted(error);
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  const code = (error as { code?: string }).code ?? (error.cause as { code?: string } | undefined)?.code;
  if (code && NETWORK_CODES.has(code)) return true;
  return error instanceof TypeError && /fetch failed|network|terminated|socket/i.test(error.message);
}

export function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delayFor(error: unknown, attempt: number, base: number, max: number): number {
  if (error instanceof ProviderError && error.retryAfterMs !== null) {
    return Math.min(Math.max(error.retryAfterMs, 0), max);
  }
  const exp = base * 2 ** (attempt - 1);
  return Math.min(exp + Math.floor(Math.random() * base * 0.25), max);
}

/** Calls `fn` until it succeeds, an error is not retryable, or the retries run out. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > retries || !isRetryable(error) || opts.signal?.aborted) throw error;
      const delay = delayFor(error, attempt, opts.baseDelayMs ?? 1000, opts.maxDelayMs ?? 30_000);
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
}

/**
 * `client.stream(request)` with retries for failures that happen before the first event. Once an
 * event was yielded, an error is passed on as it is.
 */
export async function* streamWithRetry(
  client: ChatClient,
  request: ChatRequest,
  opts: RetryOptions = {},
): AsyncGenerator<StreamEvent, void, void> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const event of client.stream(request)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      if (yielded || attempt > retries || !isRetryable(error) || request.signal?.aborted) throw error;
      const delay = delayFor(error, attempt, opts.baseDelayMs ?? 1000, opts.maxDelayMs ?? 30_000);
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay, request.signal);
    }
  }
}
