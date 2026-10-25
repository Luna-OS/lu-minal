import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createLineSplitter,
  describeRpcError,
  RPC_CODES,
  RpcClosedError,
  RpcError,
  RpcPeer,
  RpcTimeoutError,
} from "../../src/agents/acp/rpc.js";

/** A peer wired to two pipes: what it writes, and a way to feed it lines. */
function pair(opts: Partial<ConstructorParameters<typeof RpcPeer>[0]> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: any[] = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      written.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  });
  const notes: Array<{ method: string; params: unknown }> = [];
  const strays: string[] = [];
  const peer = new RpcPeer({
    input,
    output,
    onNotification: (method, params) => notes.push({ method, params }),
    onStray: (line) => strays.push(line),
    ...opts,
  });
  const feed = (text: string) => input.write(text);
  const send = (obj: unknown) => feed(`${JSON.stringify(obj)}\n`);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { peer, input, output, written, notes, strays, feed, send, tick };
}

describe("createLineSplitter", () => {
  it("splits LF and CRLF lines and keeps a partial line until it ends", () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push('{"a":1}\r\n{"b"');
    expect(lines).toEqual(['{"a":1}']);
    s.push(":2}\n\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', ""]);
    s.push("tail");
    s.end();
    expect(lines.at(-1)).toBe("tail");
  });
});

describe("RpcPeer", () => {
  it("sends requests with ids and matches the answers, in any order", async () => {
    const t = pair();
    const a = t.peer.request("initialize", { protocolVersion: 1 });
    const b = t.peer.request("session/new", { cwd: "/x", mcpServers: [] });
    await t.tick();
    expect(t.written).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/x", mcpServers: [] } },
    ]);
    expect(t.peer.pendingCount).toBe(2);
    t.send({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1" } });
    t.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    await expect(b).resolves.toEqual({ sessionId: "s1" });
    await expect(a).resolves.toEqual({ protocolVersion: 1 });
    expect(t.peer.pendingCount).toBe(0);
  });

  it("rejects with RpcError for error answers, keeping code and data", async () => {
    const t = pair();
    const p = t.peer.request("session/prompt", {});
    await t.tick();
    t.send({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: { message: "Free usage limit reached" } } });
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32603, message: "Internal error", data: { message: "Free usage limit reached" } });
    expect(describeRpcError(err)).toBe("Internal error: Free usage limit reached");
    expect(describeRpcError(new RpcError(-32000, "Authentication required"))).toBe("Authentication required");
    expect(describeRpcError(new RpcError(1, "Bad", "more detail"))).toBe("Bad: more detail");
    expect(describeRpcError(new Error("plain"))).toBe("plain");
  });

  it("sends notifications and hands incoming ones to the listener", async () => {
    const t = pair();
    expect(t.peer.notify("session/cancel", { sessionId: "s1" })).toBe(true);
    await t.tick();
    expect(t.written).toEqual([{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } }]);
    t.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "plan", entries: [] } } });
    await t.tick();
    expect(t.notes).toEqual([{ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "plan", entries: [] } } }]);
  });

  it("answers incoming requests with the handler's result or error", async () => {
    const t = pair({
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return { outcome: { outcome: "selected", optionId: (params as any).options[0].optionId } };
        if (method === "boom") throw new Error("it broke");
        if (method === "missing") throw new RpcError(RPC_CODES.methodNotFound, "Method not found: missing", { hint: "x" });
        return undefined;
      },
    });
    t.send({ jsonrpc: "2.0", id: "a1", method: "session/request_permission", params: { options: [{ optionId: "once" }] } });
    t.send({ jsonrpc: "2.0", id: 7, method: "boom" });
    t.send({ jsonrpc: "2.0", id: 8, method: "missing" });
    t.send({ jsonrpc: "2.0", id: 9, method: "nothing" });
    await t.tick();
    expect(t.written).toEqual(
      expect.arrayContaining([
        { jsonrpc: "2.0", id: "a1", result: { outcome: { outcome: "selected", optionId: "once" } } },
        { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "it broke" } },
        { jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found: missing", data: { hint: "x" } } },
        { jsonrpc: "2.0", id: 9, result: null },
      ]),
    );
  });

  it("answers method-not-found without a handler", async () => {
    const t = pair();
    t.send({ jsonrpc: "2.0", id: 3, method: "fs/read_text_file", params: {} });
    await t.tick();
    expect(t.written).toEqual([{ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "Method not found: fs/read_text_file" } }]);
  });

  it("aborts a running handler on $/cancel_request", async () => {
    let aborted = false;
    const t = pair({
      onRequest: (_m, _p, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ outcome: { outcome: "cancelled" } });
          });
        }),
    });
    t.send({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: {} });
    await t.tick();
    t.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 5 } });
    await t.tick();
    expect(aborted).toBe(true);
    expect(t.written).toEqual([{ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "cancelled" } } }]);
    expect(t.notes).toEqual([]); // $/cancel_request is the peer's own business
  });

  it("frames messages split across chunks, several per chunk, with CRLF, and skips stray lines", async () => {
    const t = pair();
    const p = t.peer.request("x");
    await t.tick();
    const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } });
    t.feed("Warning: something on stdout\r\n");
    t.feed(line.slice(0, 10));
    t.feed(`${line.slice(10)}\r\n\r\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 })}\n`);
    await expect(p).resolves.toBe(42);
    expect(t.notes).toEqual([{ method: "session/update", params: { n: 1 } }]);
    expect(t.strays).toEqual(["Warning: something on stdout"]);
    // Valid JSON that is no JSON-RPC message is stray too; batches are taken apart.
    t.feed('{"jsonrpc":"1.0","x":1}\n[{"jsonrpc":"2.0","method":"a"},{"jsonrpc":"2.0","method":"b"}]\n');
    await t.tick();
    expect(t.strays).toHaveLength(2);
    expect(t.notes.map((n) => n.method)).toEqual(["session/update", "a", "b"]);
  });

  it("ignores answers to unknown ids", async () => {
    const t = pair();
    t.send({ jsonrpc: "2.0", id: 99, result: {} });
    t.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    await t.tick();
    expect(t.strays).toEqual([]);
    expect(t.written).toEqual([]);
  });

  it("rejects waiting requests when the input ends, and refuses new ones", async () => {
    const t = pair();
    const p = t.peer.request("session/prompt", {});
    await t.tick();
    t.input.end();
    await expect(p).rejects.toBeInstanceOf(RpcClosedError);
    expect(t.peer.closed).toBe(true);
    await expect(t.peer.request("x")).rejects.toBeInstanceOf(RpcClosedError);
    expect(t.peer.notify("y")).toBe(false);
  });

  it("leaves closing to the caller with closeOnEnd: false", async () => {
    const t = pair({ closeOnEnd: false });
    const p = t.peer.request("session/prompt", {});
    await t.tick();
    t.input.end();
    await t.tick();
    expect(t.peer.closed).toBe(false);
    t.peer.close(new RpcClosedError("OpenCode stopped unexpectedly (exit code 3)."));
    await expect(p).rejects.toThrow("OpenCode stopped unexpectedly (exit code 3).");
  });

  it("times out and aborts requests", async () => {
    const t = pair();
    await expect(t.peer.request("initialize", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(RpcTimeoutError);
    const controller = new AbortController();
    const p = t.peer.request("session/new", {}, { signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
    expect(t.peer.pendingCount).toBe(0);
    // A late answer is ignored.
    t.send({ jsonrpc: "2.0", id: 2, result: {} });
    await t.tick();
  });

  it("aborts running handlers when it closes", async () => {
    let signalAborted = false;
    const t = pair({
      onRequest: (_m, _p, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
            resolve(null);
          });
        }),
    });
    t.send({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: {} });
    await t.tick();
    t.peer.close();
    await t.tick();
    expect(signalAborted).toBe(true);
    expect(t.written).toEqual([]); // nothing is written after close
  });
});
