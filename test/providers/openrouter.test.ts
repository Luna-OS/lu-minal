import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPENROUTER_KEY_EXCHANGE_URL,
  createPkcePair,
  fetchOpenRouterBalance,
  startOpenRouterLogin,
  type OAuthLogin,
} from "../../src/providers/openrouter.js";
import { fakeFetch, json } from "./helpers.js";

/** A plain HTTP GET (no proxy, no keep-alive), like the browser following the redirect. */
function get(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

function callbackPort(login: OAuthLogin): number {
  const callback = new URL(login.url).searchParams.get("callback_url")!;
  return Number(new URL(callback).port);
}

function occupy(host: string, port = 0): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.end("someone else"));
    server.once("error", () => resolve(null));
    server.listen(port, host, () => resolve(server));
  });
}

const closeServer = (s: http.Server | null) =>
  new Promise<void>((resolve) => {
    if (!s) return resolve();
    s.close(() => resolve());
    s.closeAllConnections();
  });

const waitFor = async (test: () => Promise<boolean>, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

const refused = (url: string) =>
  get(url).then(
    () => false,
    (err: NodeJS.ErrnoException) => err.code === "ECONNREFUSED",
  );

describe("createPkcePair", () => {
  it("makes a 43-char base64url verifier and its S256 challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("is different every time", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("startOpenRouterLogin", () => {
  const logins: OAuthLogin[] = [];
  const blockers: Array<http.Server | null> = [];

  afterEach(async () => {
    for (const l of logins.splice(0)) l.cancel();
    for (const b of blockers.splice(0)) await closeServer(b);
  });

  const start = async (opts: Parameters<typeof startOpenRouterLogin>[0]) => {
    const login = await startOpenRouterLogin(opts);
    logins.push(login);
    return login;
  };

  it("signs in end to end: browser redirect, code exchange, key", async () => {
    const exchange = fakeFetch(() => json({ key: "sk-or-v1-fresh", user_id: "user_123" }));
    const login = await start({ port: 0, fetchImpl: exchange });

    const url = new URL(login.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge")!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const port = callbackPort(login);
    expect(url.searchParams.get("callback_url")).toBe(`http://localhost:${port}/callback`);
    expect(login.url).toContain(`callback_url=${encodeURIComponent(`http://localhost:${port}/callback`)}`);

    const page = await get(`http://127.0.0.1:${port}/callback?code=auth-code-42`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Signed in to OpenRouter - you can close this tab and go back to lu-minal.");
    expect(page.body).toContain("#0b0920");
    await expect(login.result).resolves.toBe("sk-or-v1-fresh");

    expect(exchange.calls).toHaveLength(1);
    const call = exchange.calls[0];
    expect(call.url).toBe(OPENROUTER_KEY_EXCHANGE_URL);
    expect(call.init?.method).toBe("POST");
    expect((call.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(String(call.init?.body));
    expect(body).toMatchObject({ code: "auth-code-42", code_challenge_method: "S256" });
    expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);

    expect(await waitFor(() => refused(`http://127.0.0.1:${port}/callback`))).toBe(true);
  });

  it("answers on localhost, whichever address it resolves to", async () => {
    const login = await start({ port: 0, fetchImpl: fakeFetch(() => json({ key: "k-localhost" })) });
    const page = await get(`http://localhost:${callbackPort(login)}/callback?code=c`);
    expect(page.status).toBe(200);
    await expect(login.result).resolves.toBe("k-localhost");
  });

  it("ignores other paths and keeps waiting", async () => {
    const login = await start({ port: 0, fetchImpl: fakeFetch(() => json({ key: "k" })) });
    const port = callbackPort(login);
    expect((await get(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
    expect((await get(`http://127.0.0.1:${port}/`)).status).toBe(404);
    await get(`http://127.0.0.1:${port}/callback?code=c`);
    await expect(login.result).resolves.toBe("k");
  });

  it("reports a denied sign-in to the browser and the caller", async () => {
    const exchange = fakeFetch(() => json({ key: "never" }));
    const login = await start({ port: 0, fetchImpl: exchange });
    const page = await get(`http://127.0.0.1:${callbackPort(login)}/callback?error=access_denied&error_description=${encodeURIComponent("User <cancelled>")}`);
    expect(page.status).toBe(400);
    expect(page.body).toContain("Sign-in failed");
    expect(page.body).toContain("User &#60;cancelled&#62;");
    expect(page.body).not.toContain("<cancelled>");
    await expect(login.result).rejects.toThrow(/User <cancelled>/);
    expect(exchange.calls).toHaveLength(0);
  });

  it("fails when the redirect has no code", async () => {
    const login = await start({ port: 0, fetchImpl: fakeFetch(() => json({ key: "never" })) });
    expect((await get(`http://127.0.0.1:${callbackPort(login)}/callback`)).status).toBe(400);
    await expect(login.result).rejects.toThrow("OpenRouter sent no code.");
  });

  it("fails when OpenRouter refuses the code", async () => {
    const exchange = fakeFetch(() => json({ error: { code: 403, message: "Invalid code or code_verifier" } }, 403));
    const login = await start({ port: 0, fetchImpl: exchange });
    const page = await get(`http://127.0.0.1:${callbackPort(login)}/callback?code=stale`);
    expect(page.status).toBe(502);
    expect(page.body).toContain("Invalid code or code_verifier");
    await expect(login.result).rejects.toThrow("OpenRouter refused the sign-in (403: Invalid code or code_verifier).");
  });

  it("fails when the answer has no key or the network is down", async () => {
    const noKey = await start({ port: 0, fetchImpl: fakeFetch(() => json({ ok: true })) });
    await get(`http://127.0.0.1:${callbackPort(noKey)}/callback?code=c`);
    await expect(noKey.result).rejects.toThrow("no key");

    const down = await start({ port: 0, fetchImpl: fakeFetch(() => Promise.reject(new TypeError("fetch failed"))) });
    const page = await get(`http://127.0.0.1:${callbackPort(down)}/callback?code=c`);
    expect(page.status).toBe(502);
    await expect(down.result).rejects.toThrow("fetch failed");
  });

  it("can be cancelled, which closes the server", async () => {
    const login = await start({ port: 0, fetchImpl: fakeFetch(() => json({ key: "k" })) });
    const port = callbackPort(login);
    login.cancel();
    await expect(login.result).rejects.toMatchObject({ name: "AbortError" });
    expect(await waitFor(() => refused(`http://127.0.0.1:${port}/callback?code=late`))).toBe(true);
    login.cancel(); // twice is fine
  });

  it("gives up after the timeout", async () => {
    const login = await start({ port: 0, timeoutMs: 50, fetchImpl: fakeFetch(() => json({ key: "k" })) });
    await expect(login.result).rejects.toThrow("timed out");
    expect(await waitFor(() => refused(`http://127.0.0.1:${callbackPort(login)}/callback`))).toBe(true);
  });

  it("moves to a free port when the preferred one is taken", async () => {
    const blocker = await occupy("127.0.0.1");
    blockers.push(blocker);
    const busy = (blocker!.address() as AddressInfo).port;
    const login = await start({ port: busy, fetchImpl: fakeFetch(() => json({ key: "k" })) });
    const port = callbackPort(login);
    expect(port).not.toBe(busy);
    expect(port).toBeGreaterThan(0);
    await get(`http://127.0.0.1:${port}/callback?code=c`);
    await expect(login.result).resolves.toBe("k");
  });

  it("moves on when only the IPv6 loopback port is taken", async () => {
    const blocker = await occupy("::1");
    if (!blocker) return; // no IPv6 loopback on this machine
    blockers.push(blocker);
    const busy = (blocker.address() as AddressInfo).port;
    const login = await start({ port: busy, fetchImpl: fakeFetch(() => json({ key: "k" })) });
    expect(callbackPort(login)).not.toBe(busy);
  });
});

describe("fetchOpenRouterBalance", () => {
  it("reads the key's usage and limit in USD", async () => {
    const fetchImpl = fakeFetch(() =>
      json({
        data: {
          label: "sk-or-v1-0e6...d1b",
          usage: 1.2534,
          limit: 10,
          is_free_tier: false,
          limit_remaining: 8.7466,
          rate_limit: { requests: 230, interval: "10s" },
        },
      }),
    );
    const before = Date.now();
    const balance = await fetchOpenRouterBalance("sk-or-v1-secret", fetchImpl);
    expect(balance).toMatchObject({ provider: "openrouter", label: "OpenRouter", used: 1.2534, limit: 10, unit: "usd" });
    expect(balance!.at).toBeGreaterThanOrEqual(before);
    expect(fetchImpl.calls[0].url).toBe("https://openrouter.ai/api/v1/key");
    expect((fetchImpl.calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer sk-or-v1-secret");
  });

  it("reports no limit as null", async () => {
    const balance = await fetchOpenRouterBalance("k", fakeFetch(() => json({ data: { usage: 0, limit: null, is_free_tier: true } })));
    expect(balance).toMatchObject({ used: 0, limit: null });
  });

  it("returns null on failures", async () => {
    expect(await fetchOpenRouterBalance("bad", fakeFetch(() => json({ error: { code: 401, message: "No auth credentials found" } }, 401)))).toBeNull();
    expect(await fetchOpenRouterBalance("k", fakeFetch(() => Promise.reject(new TypeError("fetch failed"))))).toBeNull();
    expect(await fetchOpenRouterBalance("k", fakeFetch(() => new Response("<html>oops</html>")))).toBeNull();
    expect(await fetchOpenRouterBalance("k", fakeFetch(() => json({ nope: true })))).toBeNull();
  });
});
