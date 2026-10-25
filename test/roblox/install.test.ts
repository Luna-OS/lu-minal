import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_FILE_NAME,
  installPlugin,
  installedPluginVersion,
  noPluginsDirMessage,
  renderPlugin,
  robloxPluginsDir,
} from "../../src/roblox/install.js";
import { PLUGIN_SOURCE, PLUGIN_VERSION } from "../../src/roblox/plugin-source.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-roblox-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Creates `rel` (posix-style) under `root`. */
function mkdirs(root: string, rel: string): string {
  const dir = path.join(root, ...rel.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const FLATPAK_USERS = ".var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio/drive_c/users";

/** What robloxPluginsDir builds for Linux (posix joins, also when the suite runs on Windows). */
function linuxPlugins(base: string, users: string, user: string): string {
  return path.posix.join(base, users, user, "AppData", "Local", "Roblox", "Plugins");
}

describe("robloxPluginsDir", () => {
  it("uses %LOCALAPPDATA%\\Roblox\\Plugins on Windows", () => {
    expect(
      robloxPluginsDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Luna\\AppData\\Local" }, home: "C:\\Users\\Luna" }),
    ).toBe("C:\\Users\\Luna\\AppData\\Local\\Roblox\\Plugins");
    // Without LOCALAPPDATA it falls back to the home folder's AppData\Local.
    expect(robloxPluginsDir({ platform: "win32", env: {}, home: "D:\\Profiles\\luna" })).toBe(
      "D:\\Profiles\\luna\\AppData\\Local\\Roblox\\Plugins",
    );
  });

  it("uses ~/Documents/Roblox/Plugins on macOS", () => {
    expect(robloxPluginsDir({ platform: "darwin", env: {}, home: "/Users/luna" })).toBe("/Users/luna/Documents/Roblox/Plugins");
  });

  it("finds Studio inside Vinegar's Flatpak prefix on Linux", () => {
    const home = tempDir();
    const users = mkdirs(home, FLATPAK_USERS);
    mkdirs(users, "Public");
    mkdirs(users, "luna");
    expect(robloxPluginsDir({ platform: "linux", env: { USER: "luna" }, home })).toBe(linuxPlugins(home, FLATPAK_USERS, "luna"));
  });

  it("picks the prefix's only user when $USER has no folder there", () => {
    const home = tempDir();
    const users = mkdirs(home, FLATPAK_USERS);
    mkdirs(users, "Public");
    mkdirs(users, "steamuser");
    expect(robloxPluginsDir({ platform: "linux", env: { USER: "someone-else" }, home })).toBe(
      linuxPlugins(home, FLATPAK_USERS, "steamuser"),
    );
  });

  it("finds a native (non-Flatpak) Vinegar under XDG_DATA_HOME", () => {
    const home = tempDir();
    const data = mkdirs(home, "data");
    const users = mkdirs(data, "vinegar/prefixes/studio/drive_c/users");
    mkdirs(users, "luna");
    expect(robloxPluginsDir({ platform: "linux", env: { USER: "luna", XDG_DATA_HOME: data }, home })).toBe(
      linuxPlugins(data, "vinegar/prefixes/studio/drive_c/users", "luna"),
    );
  });

  it("returns null on Linux without Vinegar", () => {
    const home = tempDir();
    expect(robloxPluginsDir({ platform: "linux", env: { USER: "luna" }, home })).toBeNull();
    // A prefix that was never started has no users folder yet.
    mkdirs(home, ".var/app/org.vinegarhq.Vinegar/data/vinegar/prefixes/studio");
    expect(robloxPluginsDir({ platform: "linux", env: { USER: "luna" }, home })).toBeNull();
  });

  it("lets LU_MINAL_ROBLOX_PLUGINS override every OS", () => {
    expect(
      robloxPluginsDir({ platform: "win32", env: { LU_MINAL_ROBLOX_PLUGINS: "E:\\Roblox\\Plugins", LOCALAPPDATA: "C:\\x" }, home: "C:\\Users\\Luna" }),
    ).toBe("E:\\Roblox\\Plugins");
    expect(robloxPluginsDir({ platform: "darwin", env: { LU_MINAL_ROBLOX_PLUGINS: "~/rbx/plugins" }, home: "/Users/luna" })).toBe(
      "/Users/luna/rbx/plugins",
    );
    expect(robloxPluginsDir({ platform: "linux", env: { LU_MINAL_ROBLOX_PLUGINS: "/opt/studio//Plugins/" }, home: "/home/luna" })).toBe(
      "/opt/studio/Plugins/",
    );
    // Blank means unset.
    expect(robloxPluginsDir({ platform: "darwin", env: { LU_MINAL_ROBLOX_PLUGINS: "  " }, home: "/Users/luna" })).toBe(
      "/Users/luna/Documents/Roblox/Plugins",
    );
  });

  it("explains what to do per OS when there is no folder", () => {
    expect(noPluginsDirMessage("linux")).toMatch(/Vinegar/);
    expect(noPluginsDirMessage("linux")).toContain("LU_MINAL_ROBLOX_PLUGINS");
    expect(noPluginsDirMessage("win32")).toContain("LU_MINAL_ROBLOX_PLUGINS");
    expect(noPluginsDirMessage("win32")).not.toMatch(/Vinegar/);
  });
});

describe("renderPlugin", () => {
  it("bakes the port in and changes nothing else", () => {
    const rendered = renderPlugin(51234);
    expect(rendered).toMatch(/^local DEFAULT_PORT = 51234$/m);
    expect(rendered).not.toMatch(/^local DEFAULT_PORT = 44766$/m);
    const before = PLUGIN_SOURCE.split("\n");
    const after = rendered.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((line, i) => line !== before[i])).toEqual(["local DEFAULT_PORT = 51234"]);
    expect(renderPlugin()).toBe(PLUGIN_SOURCE);
  });

  it("rejects ports outside 1..65535", () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) expect(() => renderPlugin(port)).toThrow(/1 to 65535/);
  });
});

describe("installPlugin", () => {
  it("writes the plugin with the port into the folder (creating it) and returns its path", async () => {
    const dir = path.join(tempDir(), "Roblox", "Plugins");
    const file = await installPlugin({ dir, port: 45000 });
    expect(file).toBe(path.join(dir, PLUGIN_FILE_NAME));
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("local DEFAULT_PORT = 45000");
    expect(text).toContain(`local PLUGIN_VERSION = "${PLUGIN_VERSION}"`);
    expect(installedPluginVersion({ dir })).toBe(PLUGIN_VERSION);
    // No temp files left behind.
    expect(fs.readdirSync(dir)).toEqual([PLUGIN_FILE_NAME]);
  });

  it("replaces an older install", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, PLUGIN_FILE_NAME), 'local PLUGIN_VERSION = "0.0.1"\nlocal DEFAULT_PORT = 1\n');
    expect(installedPluginVersion({ dir })).toBe("0.0.1");
    await installPlugin({ dir });
    expect(fs.readFileSync(path.join(dir, PLUGIN_FILE_NAME), "utf8")).toBe(PLUGIN_SOURCE);
    expect(installedPluginVersion({ dir })).toBe(PLUGIN_VERSION);
  });

  it.runIf(process.platform !== "win32")("writes the plugin readable only by the user, since it carries the token", async () => {
    const dir = tempDir();
    const file = await installPlugin({ dir, token: "ab".repeat(32) });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Also when it replaces a plugin someone else could read.
    fs.chmodSync(file, 0o644);
    await installPlugin({ dir, token: "cd".repeat(32) });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("uses LU_MINAL_ROBLOX_PLUGINS when no folder is given", async () => {
    const dir = tempDir();
    vi.stubEnv("LU_MINAL_ROBLOX_PLUGINS", dir);
    expect(robloxPluginsDir()).toBe(path.normalize(dir));
    const file = await installPlugin({ port: 44767 });
    expect(path.dirname(file)).toBe(path.normalize(dir));
    expect(fs.readFileSync(file, "utf8")).toContain("local DEFAULT_PORT = 44767");
  });

  it.runIf(process.platform === "linux")("throws a clear message on Linux without Vinegar", async () => {
    const home = tempDir();
    vi.stubEnv("LU_MINAL_ROBLOX_PLUGINS", "");
    vi.stubEnv("LU_MINAL_HOME_DIR", home);
    vi.stubEnv("XDG_DATA_HOME", path.join(home, "data"));
    await expect(installPlugin()).rejects.toThrow(/No Roblox Studio plugins folder found.*Vinegar/s);
  });

  it("reports a folder it can't write to", async () => {
    const blocker = path.join(tempDir(), "a-file");
    fs.writeFileSync(blocker, "not a folder");
    await expect(installPlugin({ dir: path.join(blocker, "Plugins") })).rejects.toThrow(/Could not write the Studio plugin/);
  });

  it("returns null for the installed version when nothing is installed", () => {
    expect(installedPluginVersion({ dir: tempDir() })).toBeNull();
  });
});
