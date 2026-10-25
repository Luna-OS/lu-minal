// The settings file: atomic saves and the recent-folders list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, rememberRecent, saveConfig } from "../../src/core/config.js";

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
