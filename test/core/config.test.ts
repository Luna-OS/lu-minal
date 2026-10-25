// The settings file: atomic saves and the recent-folders list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, distrusted, loadConfig, mergeConfig, rememberRecent, rememberTrust, saveConfig } from "../../src/core/config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("saveConfig", () => {
  it("writes the config and loads it back, leaving no temp file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-config-"));
    dirs.push(dir);
    const file = path.join(dir, "nested", "config.json");
    const config = defaultConfig();
    config.theme = "moon-light";
    saveConfig(config, file);
    saveConfig(config, file);
    expect(loadConfig(file).theme).toBe("moon-light");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["config.json"]);
  });
});

describe("rememberRecent", () => {
  it("keeps one entry per folder, newest spelling first", () => {
    const config = defaultConfig();
    rememberRecent(config, "C:\\Code\\App", "win32");
    rememberRecent(config, "C:\\Code\\Other", "win32");
    rememberRecent(config, "c:\\code\\app\\", "win32");
    expect(config.recent).toEqual(["c:\\code\\app\\", "C:\\Code\\Other"]);
  });

  it("tells folders apart by case where the file system does", () => {
    const config = defaultConfig();
    rememberRecent(config, "/home/ada/App", "linux");
    rememberRecent(config, "/home/ada/app", "linux");
    expect(config.recent).toEqual(["/home/ada/app", "/home/ada/App"]);
  });
});

describe("rememberTrust", () => {
  it("keeps the folders the user didn't trust, one entry per folder", () => {
    const config = defaultConfig();
    expect(config.untrusted).toEqual([]);
    rememberTrust(config, "C:\\Code\\Clone", false, "win32");
    rememberTrust(config, "C:\\Code\\Other", false, "win32");
    rememberTrust(config, "c:\\code\\clone\\", false, "win32");
    expect(config.untrusted).toEqual(["c:\\code\\clone\\", "C:\\Code\\Other"]);
    expect(distrusted(config, "C:\\CODE\\CLONE", "win32")).toBe(true);
    rememberTrust(config, "C:\\code\\Clone", true, "win32");
    expect(config.untrusted).toEqual(["C:\\Code\\Other"]);
    expect(distrusted(config, "C:\\Code\\Clone", "win32")).toBe(false);
  });

  it("survives a save, and a broken list in the file reads as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-config-"));
    dirs.push(dir);
    const file = path.join(dir, "config.json");
    const config = defaultConfig();
    rememberTrust(config, "/home/ada/clone", false, "linux");
    saveConfig(config, file);
    expect(distrusted(loadConfig(file), "/home/ada/clone", "linux")).toBe(true);
    expect(mergeConfig({ untrusted: "/home/ada/clone" }).untrusted).toEqual([]);
  });

  it("knows a folder again through a link or (on macOS and Windows) in another case", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-trust-")));
    dirs.push(dir);
    const real = path.join(dir, "Evil-Repo");
    const link = path.join(dir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, "junction");
    const config = defaultConfig();
    rememberTrust(config, link, false);
    expect(distrusted(config, real)).toBe(true);
    expect(distrusted(config, link)).toBe(true);
    // A case-insensitive file system (macOS, Windows) finds the folder under any case.
    const otherCase = path.join(dir, "evil-repo");
    if (fs.existsSync(otherCase)) expect(distrusted(config, otherCase)).toBe(true);
    rememberTrust(config, real, true);
    expect(distrusted(config, link)).toBe(false);
    expect(config.untrusted).toEqual([]);
  });
});
