import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/providers/types.js";
import { parseToolArguments, repairJson } from "../../src/providers/wire/convert.js";
import {
  errorFromResponse,
  errorMessageFrom,
  joinURL,
  mergeHeaders,
  openStream,
  parseRetryAfter,
  statusForErrorCode,
} from "../../src/providers/wire/http.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

describe("joinURL", () => {
  it("never produces a double slash", () => {
    expect(joinURL("https://api.example.com/v1", "chat/completions")).toBe("https://api.example.com/v1/chat/completions");
    expect(joinURL("https://api.example.com/v1/", "chat/completions")).toBe("https://api.example.com/v1/chat/completions");
    expect(joinURL("https://api.example.com/v1///", "/messages")).toBe("https://api.example.com/v1/messages");
    expect(joinURL("http://127.0.0.1:11434/v1", "responses")).toBe("http://127.0.0.1:11434/v1/responses");
  });
});

describe("mergeHeaders", () => {
  it("lets later parts replace earlier ones regardless of case", () => {
    const merged = mergeHeaders(
      { Authorization: "Bearer a", "Content-Type": "application/json" },
      { authorization: "Bearer b", "HTTP-Referer": "https://lu-minal.dev" },
      undefined,
    );
    expect(merged).toEqual({
      authorization: "Bearer b",
      "Content-Type": "application/json",
      "HTTP-Referer": "https://lu-minal.dev",
    });
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  it("reads seconds, fractional seconds, HTTP dates and retry-after-ms", () => {
    expect(parseRetryAfter(new Headers({ "retry-after": "12" }), now)).toBe(12_000);
    expect(parseRetryAfter(new Headers({ "retry-after": "1.5" }), now)).toBe(1500);
    expect(parseRetryAfter(new Headers({ "retry-after": "Sun, 25 Oct 2026 12:00:30 GMT" }), now)).toBe(30_000);
    expect(parseRetryAfter(new Headers({ "retry-after": "Sun, 25 Oct 2026 11:00:00 GMT" }), now)).toBe(0);
    expect(parseRetryAfter(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), now)).toBe(250);
  });

  it("returns null when there is nothing usable", () => {
    expect(parseRetryAfter(new Headers(), now)).toBeNull();
    expect(parseRetryAfter(new Headers({ "retry-after": "soon" }), now)).toBeNull();
    expect(parseRetryAfter(new Headers({ "retry-after": "" }), now)).toBeNull();
  });
});

describe("errorMessageFrom", () => {
  it("understands the common error shapes", () => {
    expect(errorMessageFrom('{"error":{"message":"Invalid API key","type":"invalid_request_error"}}')).toBe("Invalid API key");
    expect(errorMessageFrom('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("Overloaded");
    expect(errorMessageFrom('{"error":{"error":{"message":"nested"}}}')).toBe("nested");
    expect(errorMessageFrom('{"error":"model not found"}')).toBe("model not found");
    expect(errorMessageFrom('{"message":"Too many requests"}')).toBe("Too many requests");
    expect(errorMessageFrom('{"detail":"Not authenticated"}')).toBe("Not authenticated");
    expect(errorMessageFrom('[{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}]')).toBe(
      "API key not valid.",
    );
    expect(
      errorMessageFrom('{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"upstream rate-limited"}}}'),
    ).toBe("Provider returned error: upstream rate-limited");
    expect(errorMessageFrom("<html>bad gateway</html>")).toBeNull();
    expect(errorMessageFrom("{}")).toBeNull();
  });
});

describe("errorFromResponse", () => {
  it("keeps the status, body and Retry-After", async () => {
    const res = jsonResponse(429, { error: { message: "Rate limit reached for requests", type: "requests" } }, { "retry-after": "3" });
    const err = await errorFromResponse(res);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("Rate limit reached for requests");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.retryable).toBe(true);
    expect(err.body).toContain("Rate limit reached");
  });

  it("falls back to plain text, or to the status line for HTML pages", async () => {
    const plain = await errorFromResponse(new Response("upstream connect error", { status: 503 }));
    expect(plain.message).toBe("upstream connect error");
    const html = await errorFromResponse(
      new Response("<!DOCTYPE html><html><body>502</body></html>", { status: 502, statusText: "Bad Gateway" }),
    );
    expect(html.message).toBe("HTTP 502 Bad Gateway");
    expect(html.body).toContain("<!DOCTYPE html>");
  });
});

describe("statusForErrorCode", () => {
  it("maps numbers and names", () => {
    expect(statusForErrorCode(502)).toBe(502);
    expect(statusForErrorCode("429")).toBe(429);
    expect(statusForErrorCode("rate_limit_exceeded")).toBe(429);
    expect(statusForErrorCode("overloaded_error")).toBe(529);
    expect(statusForErrorCode("invalid_request_error")).toBe(400);
    expect(statusForErrorCode("something_new")).toBe(500);
    expect(statusForErrorCode(200, 418)).toBe(418);
    expect(statusForErrorCode(undefined)).toBe(500);
  });
});

describe("openStream", () => {
  it("rejects a response without a body as retryable", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 200 }));
    const err = await openStream({ fetchImpl: fetch, url: "https://x/y", headers: {}, body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
  });

  it("turns a 200 JSON error body into a ProviderError", async () => {
    const { fetch } = fakeFetch(jsonResponse(200, { error: { code: 429, message: "slow down" } }));
    const err = await openStream({ fetchImpl: fetch, url: "https://x/y", headers: {}, body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("slow down");
    expect(err.status).toBe(429);
  });
});

describe("repairJson / parseToolArguments", () => {
  it("parses valid objects and unwraps double-encoded JSON", () => {
    expect(parseToolArguments('{"path":"src/App.tsx","limit":20}')).toEqual({ path: "src/App.tsx", limit: 20 });
    expect(parseToolArguments(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });

  it("drops trailing garbage after the object", () => {
    expect(parseToolArguments('{"command":"npm test"}}')).toEqual({ command: "npm test" });
    expect(parseToolArguments('{"a":1}{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArguments('{"a":"}"} <|tool_call_end|>')).toEqual({ a: "}" });
  });

  it("closes missing braces, brackets and strings", () => {
    expect(parseToolArguments('{"path":"a.ts","edits":[{"old":"x","new":"y"}')).toEqual({
      path: "a.ts",
      edits: [{ old: "x", new: "y" }],
    });
    expect(parseToolArguments('{"text":"cut off')).toEqual({ text: "cut off" });
    expect(parseToolArguments('{"text":"ends with escape \\')).toEqual({ text: "ends with escape " });
  });

  it("removes trailing commas and dangling keys", () => {
    expect(parseToolArguments('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
    expect(parseToolArguments('{"a":1,"b":')).toEqual({ a: 1, b: null });
    expect(parseToolArguments('{"a":1,"b"')).toEqual({ a: 1 });
    expect(repairJson('{"only"')).toBe("{}");
  });

  it("strips a markdown code fence", () => {
    expect(parseToolArguments('```json\n{"a":[1]}\n```')).toEqual({ a: [1] });
  });

  it("gives {} for anything that is not an object", () => {
    expect(parseToolArguments("[1,2,3]")).toEqual({});
    expect(parseToolArguments("42")).toEqual({});
    expect(parseToolArguments("not json at all")).toEqual({});
    expect(parseToolArguments('{"a": tru')).toEqual({});
    expect(repairJson("no braces")).toBeNull();
  });
});
