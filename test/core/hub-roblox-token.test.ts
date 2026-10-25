// The Roblox bridge token and the Hub: lu-minal starts even when the token file can't be written,
// and the /roblox dialog installs the plugin with the token the running bridge accepts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { AuthStore } from "../../src/providers/auth.js";
import { PLUGIN_FILE_NAME } from "../../src/roblox/install.js";
import { bridgeTokenFile } from "../../src/roblox/token.js";
import { ThemeManager } from "../../src/themes/manager.js";
import type { CommandContext } from "../../src/ui/commands.js";
import { createLaunchers } from "../../src/ui/dialogs/index.js";
import type { DialogSpec, UiServices } from "../../src/ui/store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-token-"));
  dirs.push(d);
  return d;
}

function makeHub(dir: string, configPath: string, config = defaultConfig()): Hub {
  return new Hub({
    config,
    configPath,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
}

const BRIDGE_TOKEN_LINE = /^local BRIDGE_TOKEN = "([0-9a-f]*)"$/m;

describe("the Hub and the Roblox bridge token", () => {
  it("starts when the token file can't be written, with a token for this run", () => {
    const dir = tempDir();
    // A config folder lu-minal can't create (a file is in the way).
    const blocked = path.join(dir, "config");
    fs.writeFileSync(blocked, "");
    const hub = makeHub(dir, path.join(blocked, "config.json"));
    // Never null: a bridge without a token would accept any program on this machine.
    expect(hub.robloxToken).toMatch(/^[0-9a-f]{64}$/);
    expect(hub.toasts.some((t) => t.level === "warning" && t.text.includes("Roblox"))).toBe(true);
    // Someone who turned the Studio bridge off isn't told about it.
    const config = defaultConfig();
    config.roblox.enabled = false;
    const quiet = makeHub(dir, path.join(blocked, "config.json"), config);
    expect(quiet.robloxToken).toMatch(/^[0-9a-f]{64}$/);
    expect(quiet.toasts.some((t) => t.text.includes("Roblox"))).toBe(false);
  });

  it("installs the plugin from /roblox with the running bridge's token, even after the file was deleted", async () => {
    const dir = tempDir();
    vi.stubEnv("LU_MINAL_HOME", dir);
    vi.stubEnv("LU_MINAL_ROBLOX_PLUGINS", path.join(dir, "plugins"));
    const configPath = path.join(dir, "config", "config.json");
    const hub = makeHub(dir, configPath);
    const file = bridgeTokenFile(path.dirname(configPath));
    const running = fs.readFileSync(file, "utf8").trim();
    // token.ts: deleting the file makes the next install create a new token.
    fs.rmSync(file);

    let dialog: DialogSpec | null = null;
    const ui: UiServices = {
      runInTerminal: async () => 0,
      openDialog: (d) => {
        dialog = d;
      },
      closeDialog: () => undefined,
      quit: () => undefined,
    };
    createLaunchers(hub, ui, () => ({}) as CommandContext).roblox();
    const list = (dialog as DialogSpec | null)!.render(() => undefined) as React.ReactElement<{
      onSelect: (item: { id: string }) => Promise<void>;
    }>;
    await list.props.onSelect({ id: "install" });

    const plugin = fs.readFileSync(path.join(dir, "plugins", PLUGIN_FILE_NAME), "utf8");
    expect(BRIDGE_TOKEN_LINE.exec(plugin)?.[1]).toBe(running);
    expect(hub.toasts.some((t) => t.level === "success" && t.text.startsWith("Plugin installed"))).toBe(true);
  });
});
