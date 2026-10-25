// OpenRouter's browser sign-in (OAuth PKCE): a one-shot HTTP server on the loopback interface
// receives the redirect, trades the code for an API key and answers the browser with a small Moon
// page. Also reads a key's usage and limit for the header's balance display.
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderBalance } from "../core/types.js";
import type { FetchLike } from "./types.js";

/** The page the user approves the sign-in on. */
export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
/** Where the code from the redirect is traded for a key. */
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auths/keys";
/** A key's usage and limit. */
export const OPENROUTER_KEY_INFO_URL = "https://openrouter.ai/api/v1/key";
const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** A PKCE verifier (32 random bytes, base64url) and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A running sign-in: open `url` in the browser and wait for `result` (the new API key). */
export interface OAuthLogin {
  url: string;
  /** Resolves with the key; rejects on an error, the timeout or `cancel()`. */
  result: Promise<string>;
  /** Stops waiting (result rejects with an AbortError) and closes the local server. */
  cancel(): void;
}

/** Options for `startOpenRouterLogin`. */
export interface OpenRouterLoginOptions {
  /** The preferred local port (default 3000); a busy one falls back to a free random port. */
  port?: number;
  fetchImpl?: FetchLike;
  /** How long to wait for the browser (default 5 minutes). */
  timeoutMs?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page the browser shows after the redirect, in the Moon palette. */
function page(ok: boolean, message: string): string {
  const accent = ok ? "#7fe3c6" : "#ff9db5";
  const title = ok ? "Signed in" : "Sign-in failed";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lu-minal - ${title}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(ellipse at top, #1a1640 0%, #0b0920 70%);
    color: #e9e6ff; font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    max-width: 28rem; margin: 1rem; padding: 2rem 2.25rem; border-radius: 1rem;
    background: rgba(25, 21, 58, 0.85); border: 1px solid rgba(185, 174, 251, 0.25);
    box-shadow: 0 0 40px rgba(185, 174, 251, 0.12); text-align: center;
  }
  .moon { font-size: 2.5rem; }
  h1 { margin: 0.5rem 0; font-size: 1.35rem; color: ${accent}; }
  p { margin: 0; color: #b9aefb; }
</style>
</head>
<body>
<div class="card">
  <div class="moon">&#9790;</div>
  <h1>${title}</h1>
  <p>${escapeHtml(message)}</p>
</div>
</body>
</html>
`;
}

function cancelledError(): Error {
  const err = new Error("OpenRouter sign-in was cancelled.");
  err.name = "AbortError";
  return err;
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: http.Server): void {
  if (!server.listening) return;
  server.close();
  // Optional calls: not every runtime the binaries are built with has them.
  server.closeIdleConnections?.();
  // A browser may hold a keep-alive socket open; don't let it keep the server around.
  setTimeout(() => server.closeAllConnections?.(), 1000).unref();
}

/** A late server error (a broken socket) must not crash the app. */
function keepAlive(servers: http.Server[]): http.Server[] {
  for (const s of servers) s.on("error", () => {});
  return servers;
}

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * Listens on 127.0.0.1 and, where IPv6 exists, ::1 on the same port, so "localhost" reaches us
 * whichever address the browser resolves it to. A busy port (on either address) moves on to a
 * random free one.
 */
async function listenLoopback(handler: http.RequestListener, preferred: number): Promise<{ port: number; servers: http.Server[] }> {
  const candidates = [preferred, 0, 0, 0, 0];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    const v4 = http.createServer(handler);
    let port: number;
    try {
      port = await listen(v4, candidate, "127.0.0.1");
    } catch (err) {
      lastError = err;
      if (code(err) === "EADDRINUSE" || code(err) === "EACCES") continue;
      throw err;
    }
    const v6 = http.createServer(handler);
    try {
      await listen(v6, port, "::1");
      return { port, servers: keepAlive([v4, v6]) };
    } catch (err) {
      if (code(err) === "EADDRINUSE" || code(err) === "EACCES") {
        // Something else answers on [::1]:port; a browser preferring IPv6 would reach it.
        lastError = err;
        closeServer(v4);
        continue;
      }
      // No IPv6 loopback here (EADDRNOTAVAIL, EAFNOSUPPORT, ...): IPv4 alone is fine.
      return { port, servers: keepAlive([v4]) };
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Couldn't open a local port for the sign-in.");
}

async function exchangeCode(fetchImpl: FetchLike, authCode: string, verifier: string): Promise<string> {
  const res = await fetchImpl(OPENROUTER_KEY_EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code: authCode, code_verifier: verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const detail = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(`OpenRouter refused the sign-in (${res.status}${typeof detail === "string" ? `: ${detail}` : ""}).`);
  }
  const key = (body as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || !key) throw new Error("OpenRouter's answer had no key.");
  return key;
}

/**
 * Starts OpenRouter's PKCE sign-in. Open the returned `url` in the browser (openExternal); after
 * the user approves, OpenRouter redirects to http://localhost:PORT/callback?code=..., the code is
 * exchanged for a key and `result` resolves with it. The local servers are closed in every case.
 */
export async function startOpenRouterLogin(opts: OpenRouterLoginOptions = {}): Promise<OAuthLogin> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const { verifier, challenge } = createPkcePair();

  let settled = false;
  let exchanging = false;
  let resolveResult!: (key: string) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Nobody may be listening yet when it fails (e.g. cancel right away): no unhandled rejection.
  result.catch(() => {});

  let servers: http.Server[] = [];
  let timer: NodeJS.Timeout | null = null;
  const finish = (outcome: { key: string } | { error: Error }) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    for (const s of servers) closeServer(s);
    if ("key" in outcome) resolveResult(outcome.key);
    else rejectResult(outcome.error);
  };

  const respond = (res: http.ServerResponse, status: number, html: string, after?: () => void) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    res.end(html, after);
  };

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Not found");
      return;
    }
    if (settled || exchanging) {
      respond(res, 409, page(false, "This sign-in is already finished. Go back to lu-minal."));
      return;
    }
    const error = url.searchParams.get("error");
    const authCode = url.searchParams.get("code");
    if (error || !authCode) {
      const message = error
        ? `OpenRouter reported: ${url.searchParams.get("error_description") ?? error}`
        : "OpenRouter sent no code.";
      respond(res, 400, page(false, `${message} Try /login openrouter again.`), () =>
        finish({ error: new Error(message) }),
      );
      return;
    }
    exchanging = true;
    exchangeCode(fetchImpl, authCode, verifier).then(
      (key) => {
        if (settled) {
          respond(res, 409, page(false, "This sign-in was cancelled. Go back to lu-minal."));
          return;
        }
        respond(res, 200, page(true, "Signed in to OpenRouter - you can close this tab and go back to lu-minal."), () =>
          finish({ key }),
        );
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        respond(res, 502, page(false, `${e.message} Try /login openrouter again.`), () => finish({ error: e }));
      },
    );
  };

  const listening = await listenLoopback(handler, opts.port ?? DEFAULT_PORT);
  servers = listening.servers;
  const callback = `http://localhost:${listening.port}/callback`;
  const url =
    `${OPENROUTER_AUTH_URL}?callback_url=${encodeURIComponent(callback)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  timer = setTimeout(
    () => finish({ error: new Error("OpenRouter sign-in timed out. Try /login openrouter again.") }),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timer.unref();

  return {
    url,
    result,
    cancel: () => finish({ error: cancelledError() }),
  };
}

/**
 * A key's usage and limit (USD) from GET /api/v1/key; null when the request fails or the answer
 * isn't the expected shape.
 */
export async function fetchOpenRouterBalance(
  key: string,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): Promise<ProviderBalance | null> {
  try {
    const res = await fetchImpl(OPENROUTER_KEY_INFO_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { usage?: unknown; limit?: unknown } } | null;
    const data = body?.data;
    if (!data || typeof data !== "object") return null;
    const amount = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      provider: "openrouter",
      label: "OpenRouter",
      used: amount(data.usage),
      limit: amount(data.limit),
      unit: "usd",
      at: Date.now(),
    };
  } catch {
    return null;
  }
}
