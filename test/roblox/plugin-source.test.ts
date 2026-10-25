import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PLUGIN_SOURCE, PLUGIN_VERSION } from "../../src/roblox/plugin-source.js";
import { DEFAULT_ROBLOX_PORT, PLUGIN_HEADER, ROBLOX_COMMANDS } from "../../src/roblox/protocol.js";
import { checkLuauStructure } from "./luau-check.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const luauFile = path.join(root, "roblox", "LuMinal.server.luau");
const tsFile = path.join(root, "src", "roblox", "plugin-source.ts");
/** Git may check files out with CRLF on Windows; compare by content. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

describe("the bundled Studio plugin", () => {
  it("is exactly roblox/LuMinal.server.luau", () => {
    expect(PLUGIN_SOURCE).toBe(lf(fs.readFileSync(luauFile, "utf8")));
  });

  it("matches what scripts/gen-roblox-plugin.mjs generates (run it after editing the .luau file)", async () => {
    const script = pathToFileURL(path.join(root, "scripts", "gen-roblox-plugin.mjs")).href;
    const { renderPluginModule } = (await import(script)) as { renderPluginModule: (source: string) => string };
    expect(lf(fs.readFileSync(tsFile, "utf8"))).toBe(renderPluginModule(fs.readFileSync(luauFile, "utf8")));
    // CRLF input generates the same module.
    expect(renderPluginModule(PLUGIN_SOURCE.replace(/\n/g, "\r\n"))).toBe(renderPluginModule(PLUGIN_SOURCE));
  });

  it("has the version and default port the TypeScript side expects", () => {
    expect(PLUGIN_SOURCE).toMatch(new RegExp(`^local PLUGIN_VERSION = "${PLUGIN_VERSION.replace(/\./g, "\\.")}"$`, "m"));
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PLUGIN_SOURCE).toMatch(new RegExp(`^local DEFAULT_PORT = ${DEFAULT_ROBLOX_PORT}$`, "m"));
    expect(PLUGIN_SOURCE).toContain('local HOST = "127.0.0.1"');
  });

  it("implements every command the tools send", () => {
    const table = /local COMMANDS: \{ \[string\]: \(any\) -> any \} = \{([\s\S]*?)\n\}/.exec(PLUGIN_SOURCE);
    expect(table).not.toBeNull();
    const names = [...table![1].matchAll(/^\s*(\w+) = (command\w+),$/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual([...ROBLOX_COMMANDS].sort());
    for (const match of table![1].matchAll(/= (command\w+),/g)) {
      expect(PLUGIN_SOURCE).toContain(`local ${match[1]} = function(`);
    }
  });

  it("speaks the bridge's protocol", () => {
    expect(PLUGIN_SOURCE).toContain(`["${PLUGIN_HEADER}"] = PLUGIN_VERSION`);
    for (const route of ['"/hello"', '"/poll?session="', '"/result"', '"/log"', '"/bye"']) expect(PLUGIN_SOURCE).toContain(route);
    expect(PLUGIN_SOURCE).toContain("HttpService:RequestAsync");
    expect(PLUGIN_SOURCE).toContain("LogService.MessageOut:Connect");
    // Its own lines never go back to lu-minal.
    expect(PLUGIN_SOURCE).toMatch(/string\.sub\(message, 1, #LOG_PREFIX\) == LOG_PREFIX/);
  });

  it("keeps edits undoable and the place safe", () => {
    expect(PLUGIN_SOURCE).toContain("TryBeginRecording");
    expect(PLUGIN_SOURCE).toContain("FinishRecording");
    expect(PLUGIN_SOURCE).toContain("SetWaypoint");
    expect(PLUGIN_SOURCE).toContain("UpdateSourceAsync");
    expect(PLUGIN_SOURCE).toContain("Refusing to delete the place itself");
    expect(PLUGIN_SOURCE).toContain("Refusing to delete the service");
    expect(PLUGIN_SOURCE).toContain("RunService:IsEdit()");
  });

  it("uses the settings for auto-connect and the port", () => {
    expect(PLUGIN_SOURCE).toContain('plugin:CreateToolbar("lu-minal")');
    expect(PLUGIN_SOURCE).toMatch(/CreateButton\(\s*"luminal-connect"/);
    expect(PLUGIN_SOURCE).toContain('"Connect"');
    expect(PLUGIN_SOURCE).toContain("plugin:GetSetting(key)");
    expect(PLUGIN_SOURCE).toContain("plugin:SetSetting(key, value)");
  });

  it("is plain ASCII English", () => {
    expect(PLUGIN_SOURCE).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
  });

  it("is structurally sound Luau (blocks and brackets balance)", () => {
    expect(checkLuauStructure(PLUGIN_SOURCE)).toEqual([]);
  });
});

describe("checkLuauStructure", () => {
  it("accepts well-formed code, if-expressions included", () => {
    const ok = [
      "local function f(x: number): number",
      "\tlocal y = if x > 0 then x else -x",
      "\tfor i = 1, 3 do",
      "\t\tif i == 2 then",
      "\t\t\tcontinue",
      "\t\telseif i == 3 then",
      "\t\t\tbreak",
      "\t\telse",
      "\t\t\ty += 1",
      "\t\tend",
      "\tend",
      "\trepeat y -= 1 until y < 0",
      "\tlocal t = { a = [[long ]] .. \"end\", b = function() return 1 end }",
      "\t-- end end end",
      "\t--[[ function ( { ]]",
      "\tpcall(function()",
      "\t\t(t :: any).a = 1",
      "\tend)",
      "\treturn y",
      "end",
    ].join("\n");
    expect(checkLuauStructure(ok)).toEqual([]);
  });

  it("finds missing ends, stray brackets and ambiguous calls", () => {
    expect(checkLuauStructure("if x then\n\tprint(1)\n")).toEqual(['line 1: "if" is never closed']);
    expect(checkLuauStructure("local t = { 1, 2\nlocal u = 3")).toEqual(['line 1: "{" is never closed']);
    expect(checkLuauStructure("print(1))")[0]).toMatch(/"\)" closes "nothing"/);
    expect(checkLuauStructure("local a = b\n(c or d):Destroy()")[0]).toMatch(/starting with "\("/);
    expect(checkLuauStructure('local s = "open')[0]).toMatch(/unclosed string/);
  });
});
