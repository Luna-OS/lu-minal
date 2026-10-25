import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RobloxBridge, isLoopbackHost, type RobloxBridgeOptions } from "../../src/roblox/bridge.js";
import { PLUGIN_VERSION } from "../../src/roblox/plugin-source.js";
import { FakePlugin, request, waitFor } from "./helpers.js";

/** Catches a rejection right away (so it is never "unhandled"); resolves to the error. */
function caught(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => new Error("expected a rejection"),
    (err: Error) => err,
  );
}

const bridges: RobloxBridge[] = [];

async function startBridge(opts: RobloxBridgeOptions = {}): Promise<{ bridge: RobloxBridge; port: number; plugin: FakePlugin }> {
  const bridge = new RobloxBridge({ port: 0, pollTimeoutMs: 2000, ...opts });
  bridges.push(bridge);
  await bridge.start();
  const port = bridge.status().port;
  return { bridge, port, plugin: new FakePlugin(port) };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.stop()));
});

describe("RobloxBridge lifecycle", () => {
  it("listens on a free loopback port and reports its status", async () => {
    const { bridge, port } = await startBridge();
    expect(port).toBeGreaterThan(0);
    expect(bridge.status()).toMatchObject({
      listening: true,
      port,
      connected: false,
      place: null,
      studioVersion: null,
      lastSeen: null,
      error: null,
      pluginVersion: null,
    });
  });

  it("does not throw when the port is taken, and says why", async () => {
    const { port } = await startBridge();
    const second = new RobloxBridge({ port });
    bridges.push(second);
    await expect(second.start()).resolves.toBeUndefined();
    const status = second.status();
    expect(status.listening).toBe(false);
    expect(status.port).toBe(port);
    expect(status.error).toMatch(/already in use/);
    await expect(second.call("ping", {})).rejects.toThrow(/not running.*already in use/s);
  });

  it("says when the port isn't allowed, on Windows with its reserved port ranges", async () => {
    // EACCES: a privileged port elsewhere, a range Hyper-V, WSL or Docker reserved on Windows.
    const listen = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server) {
      process.nextTick(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied"), { code: "EACCES" })));
      return this;
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      const errorOn = async (value: NodeJS.Platform) => {
        Object.defineProperty(process, "platform", { ...platform, value });
        try {
          const bridge = new RobloxBridge({ port: 50_123 });
          bridges.push(bridge);
          await bridge.start();
          expect(bridge.status().listening).toBe(false);
          return bridge.status().error ?? "";
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      };
      expect(await errorOn("linux")).toMatch(/^Not allowed to listen on port 50123\. Choose another roblox\.port/);
      expect(await errorOn("win32")).toMatch(/^Not allowed to listen on port 50123 \(Windows keeps .*excludedportrange.*\)\. Choose another/);
    } finally {
      listen.mockRestore();
    }
  });

  it("refuses to bind to anything but loopback", async () => {
    const bridge = new RobloxBridge({ port: 0, host: "0.0.0.0" });
    bridges.push(bridge);
    await bridge.start();
    expect(bridge.status().listening).toBe(false);
    expect(bridge.status().error).toMatch(/loopback/);
  });

  it("stops (rejecting pending calls) and starts again", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const pending = caught(bridge.call("get_tree", {}));
    await bridge.stop();
    expect((await pending).message).toMatch(/stopped/);
    expect(bridge.status()).toMatchObject({ listening: false, connected: false, error: null });
    await bridge.start();
    expect(bridge.status().listening).toBe(true);
  });

  it("knows which hosts are loopback", () => {
    for (const h of ["127.0.0.1", "127.3.2.1", "localhost", "::1", "[::1]", "LOCALHOST"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.5", "evil.example", "127.0.0.1.evil.example", "::"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("RobloxBridge protocol", () => {
  it("connects on hello and reports the place", async () => {
    const { bridge, plugin } = await startBridge();
    let notified = 0;
    bridge.subscribe(() => notified++);
    const hello = await plugin.hello();
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ ok: true, pluginVersion: PLUGIN_VERSION });
    expect(typeof hello.body.session).toBe("string");
    expect(notified).toBeGreaterThan(0);
    expect(bridge.status()).toMatchObject({
      connected: true,
      place: { name: "Moon Obby", placeId: 1818, gameId: 9090 },
      studioVersion: "0.651.0.6510833",
      pluginVersion: PLUGIN_VERSION,
      pluginOutdated: false,
    });
    expect(bridge.status().lastSeen).toBeGreaterThan(Date.now() - 5000);
  });

  it("round-trips a call through poll and result (call first, then poll)", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const call = bridge.call<{ name: string }>("get_tree", { path: "game.Workspace", depth: 1 });
    const served = await plugin.serveOnce((command, args) => ({
      ok: true,
      result: { name: "Workspace", className: "Workspace", path: "game.Workspace", childCount: 2, echo: { command, args } },
    }));
    expect(served).toEqual({ command: "get_tree", args: { path: "game.Workspace", depth: 1 } });
    await expect(call).resolves.toMatchObject({ name: "Workspace", echo: { command: "get_tree", args: { depth: 1 } } });
  });

  it("hands a command to a poll that is already waiting", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const poll = plugin.poll();
    await waitFor(() => bridge.status().connected);
    await new Promise((r) => setTimeout(r, 30)); // the poll is parked on the server now
    const call = bridge.call("get_selection", {});
    const reply = await poll;
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ command: "get_selection", args: {} });
    await plugin.result(reply.body.id, { ok: true, result: { selection: [] } });
    await expect(call).resolves.toEqual({ selection: [] });
  });

  it("runs queued commands in order, one per poll", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const first = bridge.call("get_script", { path: "game.ServerScriptService.Main" });
    const second = bridge.call("get_script", { path: "game.ServerScriptService.Util" });
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      await plugin.serveOnce((_command, args) => {
        seen.push(args.path);
        return { ok: true, result: { source: `-- ${args.path}` } };
      });
    }
    expect(seen).toEqual(["game.ServerScriptService.Main", "game.ServerScriptService.Util"]);
    await expect(first).resolves.toEqual({ source: "-- game.ServerScriptService.Main" });
    await expect(second).resolves.toEqual({ source: "-- game.ServerScriptService.Util" });
  });

  it("rejects with the plugin's error message", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const call = caught(bridge.call("get_properties", { path: "Workspace.Nope" }));
    await plugin.serveOnce(() => ({ ok: false, error: "No 'Nope' in game.Workspace (its children: Camera, Terrain, Baseplate)." }));
    expect((await call).message).toBe("No 'Nope' in game.Workspace (its children: Camera, Terrain, Baseplate).");
  });

  it("answers 204 when no command arrives before the poll timeout", async () => {
    const { bridge, plugin } = await startBridge({ pollTimeoutMs: 80 });
    await plugin.hello();
    const started = Date.now();
    const reply = await plugin.poll();
    expect(reply.status).toBe(204);
    expect(reply.text).toBe("");
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(bridge.status().connected).toBe(true);
  });

  it("answers 409 to a poll with an unknown session, so the plugin says hello again", async () => {
    const { plugin } = await startBridge();
    plugin.session = "from-a-previous-run";
    const reply = await plugin.poll();
    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatch(/hello/);
  });

  it("rejects bad JSON and unknown routes", async () => {
    const { port } = await startBridge();
    expect((await request(port, "POST", "/hello", { body: "{not json" })).status).toBe(400);
    expect((await request(port, "GET", "/nope")).status).toBe(404);
    expect((await request(port, "DELETE", "/poll")).status).toBe(404);
  });

  it("collects Studio's output, oldest first, within maxOutput, and notifies", async () => {
    const { bridge, plugin } = await startBridge({ maxOutput: 3 });
    await plugin.hello();
    let notified = 0;
    bridge.subscribe(() => notified++);
    const reply = await plugin.log([
      { type: "MessageOutput", text: "Hello world!", at: 1_760_000_000_000 },
      { type: "MessageWarning", text: "Infinite yield possible on 'ReplicatedStorage:WaitForChild(\"Remotes\")'", at: 1_760_000_001 },
      { type: "MessageError", text: "ServerScriptService.Main:12: attempt to index nil with 'Health'" },
      { type: "MessageInfo", text: "Stack End" },
      { text: 42 } as never,
    ]);
    expect(reply.body).toEqual({ ok: true, received: 4 });
    expect(notified).toBeGreaterThan(0);
    const out = bridge.output();
    expect(out.map((l) => l.type)).toEqual(["MessageWarning", "MessageError", "MessageInfo"]);
    expect(out[0].at).toBe(1_760_000_001_000); // seconds become milliseconds
    expect(out[1].at).toBeGreaterThan(Date.now() - 5000);
    expect(bridge.output(1)).toEqual([out[2]]);
    expect(bridge.output(0)).toEqual([]);
    // Copies: changing them doesn't change the bridge.
    out[0].text = "changed";
    expect(bridge.output()[0].text).not.toBe("changed");
    bridge.clearOutput();
    expect(bridge.output()).toEqual([]);
  });

  it("disconnects on bye and rejects what was in flight", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const call = caught(bridge.call("run_luau", { code: "task.wait(10)" }));
    const queued = caught(bridge.call("get_tree", {}));
    const reply = await plugin.poll();
    expect(reply.body.command).toBe("run_luau");
    await plugin.bye();
    expect((await call).message).toMatch(/disconnected.*"run_luau" may not have finished/);
    expect((await queued).message).toMatch(/disconnected.*"get_tree" was not sent/);
    expect(bridge.status()).toMatchObject({ connected: false, place: null });
  });

  it("sends commands to the newest Studio session", async () => {
    const { bridge, port } = await startBridge();
    const older = new FakePlugin(port);
    const newer = new FakePlugin(port);
    await older.hello({ name: "Old Place", placeId: 1, gameId: 1 });
    await newer.hello({ name: "New Place", placeId: 2, gameId: 2 });
    expect(bridge.status().place?.name).toBe("New Place");
    const call = bridge.call("ping", {});
    const served = await newer.serveOnce(() => ({ ok: true, result: "pong from new" }));
    expect(served?.command).toBe("ping");
    await expect(call).resolves.toBe("pong from new");
    // When the newer one leaves, the older one takes over.
    await newer.bye();
    expect(bridge.status().place?.name).toBe("Old Place");
  });
});

describe("RobloxBridge security", () => {
  it("refuses requests without the plugin header", async () => {
    const { port } = await startBridge();
    const reply = await request(port, "POST", "/hello", { body: { place: {} }, marker: false });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toMatch(/X-LuMinal-Plugin/);
  });

  it("refuses anything that looks like a browser", async () => {
    const { bridge, port } = await startBridge();
    const origin = await request(port, "POST", "/hello", { body: {}, headers: { Origin: "https://evil.example" } });
    expect(origin.status).toBe(403);
    expect(origin.headers["access-control-allow-origin"]).toBeUndefined();
    const nullOrigin = await request(port, "GET", "/status", { headers: { Origin: "null" } });
    expect(nullOrigin.status).toBe(403);
    const fetchSite = await request(port, "GET", "/status", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(fetchSite.status).toBe(403);
    // A CORS preflight is never approved.
    const preflight = await request(port, "OPTIONS", "/hello", {
      marker: false,
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-luminal-plugin" },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    expect(preflight.headers["access-control-allow-headers"]).toBeUndefined();
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host.
    const rebound = await request(port, "GET", "/status", { headers: { Host: `evil.example:${port}` } });
    expect(rebound.status).toBe(403);
    expect(bridge.status().connected).toBe(false);
  });

  it("accepts loopback Host headers", async () => {
    const { port } = await startBridge();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, "localhost"]) {
      expect((await request(port, "GET", "/status", { headers: { Host: host } })).status).toBe(200);
    }
  });
});

describe("RobloxBridge errors and timeouts", () => {
  it("rejects calls right away when no plugin is connected, saying how to connect", async () => {
    const { bridge } = await startBridge();
    const error = await bridge.call("get_tree", {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("not connected");
    expect(message).toContain("lu-minal roblox install");
    expect(message).toMatch(/allow/i);
    expect(message).toContain('"Connect"');
    expect(message).toContain(`127.0.0.1:${bridge.status().port}`);
  });

  it("drops a command nobody picked up when it times out", async () => {
    const { bridge, plugin } = await startBridge({ pollTimeoutMs: 150 });
    await plugin.hello();
    await expect(bridge.call("get_tree", {}, 60)).rejects.toThrow(/did not pick up "get_tree".*dropped/);
    // The next poll gets nothing: the command is gone.
    const reply = await plugin.poll();
    expect(reply.status).toBe(204);
  });

  it("times out a command the plugin took but never answered, and ignores the late answer", async () => {
    const { bridge, plugin } = await startBridge();
    await plugin.hello();
    const call = caught(bridge.call("run_luau", { code: "while true do task.wait() end" }, 120));
    const reply = await plugin.poll();
    expect((await call).message).toMatch(/did not answer "run_luau" within 0\.1s/);
    const late = await plugin.result(reply.body.id, { ok: true, result: "too late" });
    expect(late.body).toEqual({ ok: true, ignored: true });
  });

  it("counts a plugin as gone after the connected window, and notifies", async () => {
    const { bridge, plugin } = await startBridge({ connectedWindowMs: 120 });
    await plugin.hello();
    expect(bridge.status().connected).toBe(true);
    let notified = 0;
    bridge.subscribe(() => notified++);
    await waitFor(() => !bridge.status().connected, 2000);
    await waitFor(() => notified > 0, 1000);
    await expect(bridge.call("ping", {})).rejects.toThrow(/not connected/);
  });

  it("stays connected while a long poll is open, longer than the window", async () => {
    const { bridge, plugin } = await startBridge({ connectedWindowMs: 60, pollTimeoutMs: 400 });
    await plugin.hello();
    const poll = plugin.poll();
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.status().connected).toBe(true);
    const call = bridge.call("ping", {});
    const reply = await poll;
    await plugin.result(reply.body.id, { ok: true, result: { pluginVersion: PLUGIN_VERSION } });
    await expect(call).resolves.toMatchObject({ pluginVersion: PLUGIN_VERSION });
  });

  it("flags a plugin of another version as outdated", async () => {
    const { bridge, port } = await startBridge();
    await request(port, "POST", "/hello", { body: { place: { name: "P", placeId: 0, gameId: 0 }, pluginVersion: "0.0.1" } });
    expect(bridge.status()).toMatchObject({ connected: true, pluginVersion: "0.0.1", pluginOutdated: true });
  });

  it("keeps working when a listener throws, and unsubscribes", async () => {
    const { bridge, plugin } = await startBridge();
    let calls = 0;
    bridge.subscribe(() => {
      throw new Error("broken listener");
    });
    const off = bridge.subscribe(() => calls++);
    await plugin.hello();
    const before = calls;
    expect(before).toBeGreaterThan(0);
    off();
    await plugin.log([{ type: "MessageOutput", text: "x" }]);
    expect(calls).toBe(before);
  });
});
