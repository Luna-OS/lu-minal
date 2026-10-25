// The secret lu-minal shares with its Studio plugin: made once (0600), baked into the plugin, and
// required by the bridge, so no other program on this machine can pose as Studio.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RobloxBridge } from "../../src/roblox/bridge.js";
import { renderPlugin } from "../../src/roblox/install.js";
import { PLUGIN_HEADER, TOKEN_HEADER } from "../../src/roblox/protocol.js";
import { bridgeToken } from "../../src/roblox/token.js";

let dir = "";
let bridge: RobloxBridge | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-roblox-token-"));
});
afterEach(async () => {
  await bridge?.stop();
  bridge = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the bridge token", () => {
  it("is made once, kept private and reused", () => {
    const file = path.join(dir, "config", "roblox-token");
    const token = bridgeToken(file);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(bridgeToken(file)).toBe(token);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, "garbage");
    expect(bridgeToken(file)).not.toBe(token);
  });

  it("is baked into the plugin, as hex only", () => {
    const token = "ab".repeat(32);
    expect(renderPlugin(44766, token)).toContain(`local BRIDGE_TOKEN = "${token}"`);
    expect(renderPlugin(44766)).toContain('local BRIDGE_TOKEN = ""');
    expect(() => renderPlugin(44766, '"; os.exit() --')).toThrow(/hex/);
  });

  it("is required by the bridge when it has one", async () => {
    const token = "cd".repeat(32);
    bridge = new RobloxBridge({ port: 0, token });
    await bridge.start();
    const url = `http://127.0.0.1:${bridge.status().port}/status`;
    const get = (headers: Record<string, string>) => fetch(url, { headers }).then((r) => r.status);
    expect(await get({ [PLUGIN_HEADER]: "0.1.0" })).toBe(403);
    expect(await get({ [PLUGIN_HEADER]: "0.1.0", [TOKEN_HEADER]: "ef".repeat(32) })).toBe(403);
    expect(await get({ [PLUGIN_HEADER]: "0.1.0", [TOKEN_HEADER]: token })).toBe(200);
  });

  it("tells the UI when a plugin without the token keeps knocking (reinstall it)", async () => {
    const token = "ab".repeat(32);
    bridge = new RobloxBridge({ port: 0, token });
    await bridge.start();
    let changes = 0;
    bridge.subscribe(() => changes++);
    expect(bridge.status().needsReinstall).toBe(false);
    const url = `http://127.0.0.1:${bridge.status().port}/status`;
    // An old plugin: the plugin header, no token.
    expect((await fetch(url, { headers: { [PLUGIN_HEADER]: "0.1.0" } })).status).toBe(403);
    expect(bridge.status().needsReinstall).toBe(true);
    expect(changes).toBe(1);
    // Knocking again doesn't wake the UI again.
    await fetch(url, { headers: { [PLUGIN_HEADER]: "0.1.0" } });
    expect(changes).toBe(1);
    // A request without the plugin header (not a plugin at all) is no reason to reinstall.
    const other = new RobloxBridge({ port: 0, token });
    await other.start();
    await fetch(`http://127.0.0.1:${other.status().port}/status`);
    expect(other.status().needsReinstall).toBe(false);
    await other.stop();
  });
});
