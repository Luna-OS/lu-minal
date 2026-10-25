import { afterEach, describe, expect, it } from "vitest";
import { RobloxBridge } from "../../src/roblox/bridge.js";
import { PLUGIN_VERSION } from "../../src/roblox/plugin-source.js";
import { ROBLOX_COMMANDS, type TreeNode } from "../../src/roblox/protocol.js";
import type { RobloxApi, RobloxLogLine, RobloxStatus } from "../../src/roblox/types.js";
import { formatTree, formatValue, replaceOnce, robloxTools } from "../../src/tools/roblox.js";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types.js";
import { makeCtx, services } from "../tools/helpers.js";
import { FakePlugin } from "./helpers.js";

type Handler = (args: Record<string, any>) => unknown;

/** A RobloxApi with scripted answers per command; records every call. */
class FakeStudio implements RobloxApi {
  connected = true;
  listening = true;
  calls: Array<{ command: string; args: Record<string, any>; timeoutMs?: number }> = [];
  handlers: Record<string, Handler> = {};
  log: RobloxLogLine[] = [];

  status(): RobloxStatus {
    return {
      listening: this.listening,
      port: 44766,
      connected: this.listening && this.connected,
      place: this.connected ? { name: "Moon Obby", placeId: 1818, gameId: 9090 } : null,
      studioVersion: this.connected ? "0.651.0.6510833" : null,
      lastSeen: this.connected ? Date.now() : null,
      error: this.listening ? null : "Port 44766 is already in use (is another lu-minal running?).",
    };
  }

  async call<T>(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    this.calls.push({ command, args: args as Record<string, any>, timeoutMs });
    const handler = this.handlers[command];
    if (!handler) throw new Error(`no handler for ${command}`);
    return (await handler(args as Record<string, any>)) as T;
  }

  output(limit?: number): RobloxLogLine[] {
    return limit === undefined ? [...this.log] : this.log.slice(Math.max(0, this.log.length - limit));
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

const tools = robloxTools();
const byName = new Map(tools.map((t) => [t.name, t]));

function get(name: string): Tool {
  const t = byName.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function setup(): { studio: FakeStudio; ctx: ToolContext } {
  const studio = new FakeStudio();
  return { studio, ctx: makeCtx({ services: services({ roblox: studio }) }) };
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return get(name).run(args, ctx);
}

function riskOf(t: Tool, args: Record<string, unknown>, ctx: ToolContext) {
  return typeof t.risk === "function" ? t.risk(args, ctx) : t.risk;
}

const WORKSPACE_TREE: TreeNode = {
  name: "Workspace",
  className: "Workspace",
  path: "game.Workspace",
  childCount: 5,
  children: [
    { name: "Camera", className: "Camera", path: "game.Workspace.Camera", childCount: 0 },
    { name: "Terrain", className: "Terrain", path: "game.Workspace.Terrain", childCount: 0 },
    {
      name: "Lava Pit",
      className: "Model",
      path: "game.Workspace['Lava Pit']",
      childCount: 3,
      children: [
        { name: "Lava", className: "Part", path: "game.Workspace['Lava Pit'].Lava", childCount: 1 },
        { name: "KillScript", className: "Script", path: "game.Workspace['Lava Pit'].KillScript", childCount: 0 },
      ],
      more: 1,
    },
  ],
  more: 2,
};

describe("robloxTools", () => {
  it("has every Studio tool, all offered over MCP, with the right risks", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "roblox_status",
      "roblox_run_luau",
      "roblox_get_tree",
      "roblox_get_properties",
      "roblox_get_script",
      "roblox_set_script",
      "roblox_create_instance",
      "roblox_set_properties",
      "roblox_delete_instance",
      "roblox_get_selection",
      "roblox_set_selection",
      "roblox_find",
      "roblox_output",
    ]);
    const { ctx } = setup();
    const risks = Object.fromEntries(tools.map((t) => [t.name, riskOf(t, {}, ctx)]));
    expect(risks).toEqual({
      roblox_status: "read",
      roblox_run_luau: "exec",
      roblox_get_tree: "read",
      roblox_get_properties: "read",
      roblox_get_script: "read",
      roblox_set_script: "edit",
      roblox_create_instance: "edit",
      roblox_set_properties: "edit",
      roblox_delete_instance: "edit",
      roblox_get_selection: "read",
      roblox_set_selection: "read",
      roblox_find: "read",
      roblox_output: "read",
    });
    for (const t of tools) {
      expect(t.mcp).toBe(true);
      expect(t.leadOnly).toBeFalsy();
      expect(t.parameters.type).toBe("object");
      expect(t.describe({}, ctx).verb).toBe("studio");
    }
  });

  it("tells the model how to connect Studio instead of calling it", async () => {
    const { studio, ctx } = setup();
    studio.connected = false;
    const argsFor: Record<string, Record<string, unknown>> = {
      roblox_run_luau: { code: "print(1)" },
      roblox_get_tree: {},
      roblox_get_properties: { path: "Workspace" },
      roblox_get_script: { path: "ServerScriptService.Main" },
      roblox_set_script: { path: "ServerScriptService.Main", source: "" },
      roblox_create_instance: { className: "Part", parent: "Workspace" },
      roblox_set_properties: { path: "Workspace.Part", properties: { Anchored: true } },
      roblox_delete_instance: { path: "Workspace.Part" },
      roblox_get_selection: {},
      roblox_set_selection: { paths: [] },
      roblox_find: { className: "Script" },
      roblox_output: {},
    };
    for (const [name, args] of Object.entries(argsFor)) {
      const result = await run(name, args, ctx);
      expect(result.isError, name).toBe(true);
      expect(result.content, name).toContain("lu-minal roblox install");
      expect(result.content, name).toContain('"Connect"');
      expect(result.display?.detail, name).toBe("Studio not connected");
    }
    expect(studio.calls).toEqual([]);
    const status = await run("roblox_status", {}, ctx);
    expect(status.isError).toBeFalsy();
    expect(status.content).toContain("not connected");
    expect(status.content).toContain("lu-minal roblox install");
  });

  it("says when the bridge itself is not running", async () => {
    const { studio, ctx } = setup();
    studio.listening = false;
    const result = await run("roblox_get_tree", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/bridge is not running: Port 44766 is already in use/);
    expect(result.display?.detail).toBe("bridge not running");
  });

  it("only sends commands the plugin implements", async () => {
    const { studio, ctx } = setup();
    const known = new Set<string>(ROBLOX_COMMANDS);
    const sent = new Set<string>();
    for (const command of ROBLOX_COMMANDS) studio.handlers[command] = () => ({});
    studio.handlers.get_script = () => ({ path: "game.ServerScriptService.Main", className: "Script", source: "a", lineCount: 1 });
    studio.handlers.set_script = () => ({ path: "game.ServerScriptService.Main", lineCount: 1, method: "editor" });
    studio.handlers.get_tree = () => WORKSPACE_TREE;
    const all: Array<[string, Record<string, unknown>]> = [
      ["roblox_status", {}],
      ["roblox_run_luau", { code: "return 1" }],
      ["roblox_get_tree", {}],
      ["roblox_get_properties", { path: "Workspace" }],
      ["roblox_get_script", { path: "ServerScriptService.Main" }],
      ["roblox_set_script", { path: "ServerScriptService.Main", source: "b" }],
      ["roblox_create_instance", { className: "Part", parent: "Workspace" }],
      ["roblox_set_properties", { path: "Workspace.Part", properties: { Anchored: true } }],
      ["roblox_delete_instance", { path: "Workspace.Part" }],
      ["roblox_get_selection", {}],
      ["roblox_set_selection", { paths: ["Workspace"] }],
      ["roblox_find", { name: "Lava" }],
    ];
    for (const [name, args] of all) await run(name, args, ctx);
    for (const call of studio.calls) {
      expect(known.has(call.command), call.command).toBe(true);
      sent.add(call.command);
    }
    expect([...sent].sort()).toEqual([...ROBLOX_COMMANDS].sort());
  });
});

describe("roblox_status", () => {
  it("reports the place and the plugin's version from a ping", async () => {
    const { studio, ctx } = setup();
    studio.handlers.ping = () => ({ pluginVersion: PLUGIN_VERSION, studioVersion: "0.651.0.6510833", place: { name: "Moon Obby", placeId: 1818, gameId: 9090 } });
    studio.log = [{ at: 1, type: "MessageOutput", text: "hi" }];
    const result = await run("roblox_status", {}, ctx);
    expect(result.content).toContain('place "Moon Obby" (placeId 1818, gameId 9090)');
    expect(result.content).toContain(`plugin ${PLUGIN_VERSION} answers`);
    expect(result.content).toContain("1 line of Studio output");
    expect(result.content).not.toContain("lu-minal roblox install");
    expect(result.display?.detail).toBe("connected · Moon Obby");
    expect(studio.calls[0]).toMatchObject({ command: "ping", timeoutMs: 5000 });
  });

  it("asks for a reinstall when the plugin is out of date, and survives a silent plugin", async () => {
    const { studio, ctx } = setup();
    studio.handlers.ping = () => ({ pluginVersion: "0.0.1" });
    expect((await run("roblox_status", {}, ctx)).content).toMatch(/ships plugin .*lu-minal roblox install/);
    studio.handlers.ping = () => {
      throw new Error('Roblox Studio did not answer "ping" within 5s');
    };
    const silent = await run("roblox_status", {}, ctx);
    expect(silent.isError).toBeFalsy();
    expect(silent.content).toContain("did not answer a ping");
  });
});

describe("roblox_run_luau", () => {
  it("asks with the code and reports output and return values", async () => {
    const { studio, ctx } = setup();
    const t = get("roblox_run_luau");
    const code = 'local n = #workspace:GetChildren()\nprint("children", n)\nwarn("careful")\nreturn n, workspace';
    expect(t.approval?.({ code }, ctx)).toEqual({ risk: "exec", summary: "run Luau in Roblox Studio", detail: code });
    expect(t.describe({ code }, ctx)).toEqual({ verb: "studio", target: "run local n = #workspace:GetChildren()" });
    studio.handlers.run_luau = () => ({
      output: [
        { kind: "print", text: "children 4" },
        { kind: "warn", text: "careful" },
      ],
      returns: ["4", "game.Workspace (Workspace)"],
      truncated: false,
    });
    const result = await t.run({ code, timeout: 5 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("Output:\nchildren 4\nwarn: careful\nReturned: 4, game.Workspace (Workspace)");
    expect(result.display?.detail).toBe("2 lines of output");
    expect(studio.calls[0]).toEqual({ command: "run_luau", args: { code, timeout: 5 }, timeoutMs: 15_000 });
  });

  it("marks runtime errors and timeouts as errors, keeping the output", async () => {
    const { studio, ctx } = setup();
    studio.handlers.run_luau = () => ({
      output: [{ kind: "print", text: "before" }],
      returns: [],
      error: "lu-minal:2: attempt to index nil with 'Health'",
    });
    const result = await run("roblox_run_luau", { code: "print('before')\nreturn nil.Health" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Output:\nbefore\nError: lu-minal:2: attempt to index nil with 'Health'");
    studio.handlers.run_luau = () => ({ output: [], returns: [], error: "Timed out after 120s; the code was stopped.", timedOut: true });
    const slow = await run("roblox_run_luau", { code: "while true do task.wait() end", timeout: 500 }, ctx);
    expect(slow.isError).toBe(true);
    expect(slow.content).toBe("Timed out: Timed out after 120s; the code was stopped.");
    expect(studio.calls[1].args.timeout).toBe(120);
  });

  it("rejects empty code without calling Studio", async () => {
    const { studio, ctx } = setup();
    expect((await run("roblox_run_luau", { code: "   " }, ctx)).isError).toBe(true);
    expect(studio.calls).toEqual([]);
  });

  it("passes the plugin's errors on", async () => {
    const { studio, ctx } = setup();
    studio.handlers.run_luau = () => {
      throw new Error("loadstring is not available to this plugin, so run_luau can't run code.");
    };
    const result = await run("roblox_run_luau", { code: "print(1)" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Roblox Studio: loadstring is not available to this plugin, so run_luau can't run code.");
  });
});

describe("roblox_get_tree", () => {
  it("prints the tree as indented lines with paths usable as-is", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_tree = () => WORKSPACE_TREE;
    const result = await run("roblox_get_tree", { path: "Workspace", depth: 2 }, ctx);
    expect(result.content).toBe(
      [
        "game.Workspace (Workspace)",
        "  Camera (Camera)",
        "  Terrain (Terrain)",
        "  ['Lava Pit'] (Model)",
        "    Lava (Part, 1 child)",
        "    KillScript (Script)",
        "    … 1 more",
        "  … 2 more",
      ].join("\n"),
    );
    expect(result.display?.detail).toBe("6 instances");
    expect(studio.calls[0]).toMatchObject({ command: "get_tree", args: { path: "Workspace", depth: 2, maxChildren: 50 } });
  });

  it("defaults to game and names the hidden services", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_tree = () => ({
      name: "Moon Obby",
      className: "DataModel",
      path: "game",
      childCount: 47,
      children: [
        { name: "Workspace", className: "Workspace", path: "game.Workspace", childCount: 3 },
        { name: "ReplicatedStorage", className: "ReplicatedStorage", path: "game.ReplicatedStorage", childCount: 0 },
      ],
      more: 45,
    });
    const result = await run("roblox_get_tree", { depth: 1 }, ctx);
    expect(result.content.split("\n")).toEqual([
      "game (DataModel)",
      "  Workspace (Workspace, 3 children)",
      "  ReplicatedStorage (ReplicatedStorage)",
      "  … 45 other services",
    ]);
    expect(studio.calls[0].args).toEqual({ path: "game", depth: 1, maxChildren: 50 });
    expect(get("roblox_get_tree").describe({}, ctx)).toEqual({ verb: "studio", target: "tree game" });
  });

  it("formats a tree and counts its nodes", () => {
    expect(formatTree({ name: "Folder", className: "Folder", path: "game.ServerStorage.Folder", childCount: 0 })).toEqual({
      text: "game.ServerStorage.Folder (Folder)",
      count: 1,
    });
  });
});

describe("roblox_get_properties", () => {
  it("formats Roblox values, attributes and tags", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_properties = () => ({
      path: "game.Workspace['Lava Pit'].Lava",
      className: "Part",
      properties: [
        { name: "Name", value: "Lava" },
        { name: "ClassName", value: "Part" },
        { name: "Parent", value: { type: "Instance", path: "game.Workspace['Lava Pit']", className: "Model" } },
        { name: "Position", value: { type: "Vector3", x: 0, y: 0.5, z: -12.25 } },
        { name: "Color", value: { type: "Color3", r: 1, g: 0.3333, b: 0, hex: "#ff5500" } },
        { name: "Material", value: "Enum.Material.Neon" },
        { name: "Anchored", value: true },
        { name: "Transparency", value: 0.25 },
        { name: "CFrame", value: { type: "CFrame", position: [0, 0.5, -12.25], rotation: [0, 90, 0] } },
        { name: "PrimaryPart" },
      ],
      attributes: { Damage: 100, Glow: { type: "Color3", r: 1, g: 0, b: 0, hex: "#ff0000" } },
      tags: ["Hazard", "Lava"],
    });
    const result = await run("roblox_get_properties", { path: "workspace['Lava Pit'].Lava" }, ctx);
    expect(result.content).toBe(
      [
        "game.Workspace['Lava Pit'].Lava (Part)",
        '  Name = "Lava"',
        '  ClassName = "Part"',
        "  Parent = game.Workspace['Lava Pit']",
        "  Position = Vector3(0, 0.5, -12.25)",
        "  Color = Color3(#ff5500)",
        "  Material = Enum.Material.Neon",
        "  Anchored = true",
        "  Transparency = 0.25",
        "  CFrame = CFrame(pos 0, 0.5, -12.25; rot 0, 90, 0)",
        "  PrimaryPart = nil",
        "Attributes:",
        "  Damage = 100",
        "  Glow = Color3(#ff0000)",
        "Tags: Hazard, Lava",
      ].join("\n"),
    );
    expect(result.display?.detail).toBe("10 properties");
    expect(studio.calls[0].args).toEqual({ path: "workspace['Lava Pit'].Lava" });
  });

  it("asks for named properties and tolerates Roblox's empty tables ([])", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_properties = () => ({
      path: "game.StarterGui.Hud.Title",
      className: "TextLabel",
      properties: [
        { name: "Text", value: "Moon Obby" },
        { name: "Size", value: { type: "UDim2", x: { scale: 1, offset: 0 }, y: { scale: 0, offset: 40 } } },
      ],
      attributes: [],
      tags: [],
      missing: ["Colour"],
    });
    const result = await run("roblox_get_properties", { path: "StarterGui.Hud.Title", names: ["Text", "Size", "Colour", 5] }, ctx);
    expect(studio.calls[0].args).toEqual({ path: "StarterGui.Hud.Title", names: ["Text", "Size", "Colour"] });
    expect(result.content).toBe(
      [
        "game.StarterGui.Hud.Title (TextLabel)",
        '  Text = "Moon Obby"',
        "  Size = UDim2(1, 0, 0, 40)",
        "Not found (no such property or attribute): Colour",
      ].join("\n"),
    );
  });

  it("formats every encoded value type", () => {
    expect(formatValue(undefined)).toBe("nil");
    expect(formatValue(null)).toBe("nil");
    expect(formatValue("Enum.Font.GothamBold")).toBe("Enum.Font.GothamBold");
    expect(formatValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatValue({ type: "Vector2", x: 1, y: 2 })).toBe("Vector2(1, 2)");
    expect(formatValue({ type: "Color3", r: 0.5, g: 0.5, b: 0.5 })).toBe("Color3(0.5, 0.5, 0.5)");
    expect(formatValue({ type: "BrickColor", name: "Bright red" })).toBe('BrickColor("Bright red")');
    expect(formatValue({ type: "UDim", scale: 0, offset: 8 })).toBe("UDim(0, 8)");
    expect(formatValue({ type: "NumberRange", min: 1, max: 3 })).toBe("NumberRange(1, 3)");
    expect(formatValue({ type: "Rect", min: [0, 0], max: [10, 20] })).toBe("Rect(0, 0; 10, 20)");
    expect(formatValue({ type: "Font", family: "rbxasset://fonts/families/GothamSSm.json", weight: "Enum.FontWeight.Bold", style: "Enum.FontStyle.Normal" })).toBe(
      'Font("rbxasset://fonts/families/GothamSSm.json", Enum.FontWeight.Bold, Enum.FontStyle.Normal)',
    );
    expect(formatValue({ type: "ColorSequence", value: "0 1 0 0 0 1 1 1 1 0" })).toBe("ColorSequence(0 1 0 0 0 1 1 1 1 0)");
    expect(formatValue([1, "a"])).toBe('[1, "a"]');
  });
});

describe("roblox_get_script", () => {
  it("returns the source in a code block", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_script = () => ({
      path: "game.ServerScriptService.Main",
      className: "Script",
      source: 'print("Hello world!")\n',
      lineCount: 1,
      open: true,
    });
    const result = await run("roblox_get_script", { path: "ServerScriptService/Main" }, ctx);
    expect(result.content).toBe('game.ServerScriptService.Main (Script, 1 line, open in the editor)\n```lua\nprint("Hello world!")\n```');
    expect(result.display?.detail).toBe("1 line");
    studio.handlers.get_script = () => ({ path: "game.ReplicatedStorage.Shared", className: "ModuleScript", source: "", lineCount: 0 });
    expect((await run("roblox_get_script", { path: "ReplicatedStorage.Shared" }, ctx)).content).toBe(
      "game.ReplicatedStorage.Shared (ModuleScript, 0 lines)\n(empty)",
    );
  });
});

describe("roblox_set_script", () => {
  const OLD = ['local Players = game:GetService("Players")', "", "Players.PlayerAdded:Connect(function(player)", '\tprint("hi", player.Name)', "end)", ""].join("\n");

  function scripted() {
    const env = setup();
    let source = OLD;
    env.studio.handlers.get_script = () => ({ path: "game.ServerScriptService.Main", className: "Script", source, lineCount: 5 });
    env.studio.handlers.set_script = (args) => {
      source = args.source;
      return { path: args.path, lineCount: args.source.split("\n").length - 1, method: "editor" };
    };
    return { ...env, current: () => source };
  }

  it("reads the old source first and shows the change as a diff", async () => {
    const { studio, ctx, current } = scripted();
    const next = OLD.replace('\tprint("hi", player.Name)', '\tprint("welcome", player.DisplayName)\n\tplayer:SetAttribute("Joined", os.time())');
    const result = await run("roblox_set_script", { path: "ServerScriptService.Main", source: next }, ctx);
    expect(studio.calls.map((c) => c.command)).toEqual(["get_script", "set_script"]);
    // It writes to the resolved path the plugin reported.
    expect(studio.calls[1].args).toEqual({ path: "game.ServerScriptService.Main", source: next });
    expect(current()).toBe(next);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("Updated game.ServerScriptService.Main: 1 line changed, 1 line added (6 lines now). Undo in Studio with Ctrl+Z.");
    expect(result.display).toMatchObject({ target: "edit game.ServerScriptService.Main", detail: "1 line changed, 1 line added", added: 2, removed: 1 });
    expect(result.display?.diff).toEqual([
      { kind: "ctx", line: 3, text: "Players.PlayerAdded:Connect(function(player)" },
      { kind: "del", line: 4, text: '\tprint("hi", player.Name)' },
      { kind: "add", line: 4, text: '\tprint("welcome", player.DisplayName)' },
      { kind: "add", line: 5, text: '\tplayer:SetAttribute("Joined", os.time())' },
      { kind: "ctx", line: 6, text: "end)" },
    ]);
  });

  it("replaces one exact passage with oldText / newText", async () => {
    const { studio, ctx, current } = scripted();
    const result = await run("roblox_set_script", { path: "ServerScriptService.Main", oldText: '"hi"', newText: '"hello"' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(current()).toBe(OLD.replace('"hi"', '"hello"'));
    expect(result.display).toMatchObject({ added: 1, removed: 1, detail: "1 line changed" });
    expect(studio.calls.map((c) => c.command)).toEqual(["get_script", "set_script"]);
  });

  it("refuses a missing or ambiguous oldText without writing", async () => {
    const { studio, ctx } = scripted();
    const missing = await run("roblox_set_script", { path: "ServerScriptService.Main", oldText: "warn(", newText: "print(" }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toMatch(/not found/);
    const twice = await run("roblox_set_script", { path: "ServerScriptService.Main", oldText: "Players", newText: "P" }, ctx);
    expect(twice.isError).toBe(true);
    expect(twice.content).toMatch(/more than once/);
    expect(studio.calls.map((c) => c.command)).toEqual(["get_script", "get_script"]);
  });

  it("does nothing when the source is unchanged", async () => {
    const { studio, ctx } = scripted();
    const result = await run("roblox_set_script", { path: "ServerScriptService.Main", source: OLD }, ctx);
    expect(result.content).toMatch(/nothing changed/);
    expect(result.display?.detail).toBe("no changes");
    expect(studio.calls.map((c) => c.command)).toEqual(["get_script"]);
  });

  it("fails when the script doesn't exist, without writing", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_script = () => {
      throw new Error("No 'Mian' in game.ServerScriptService (its children: Main).");
    };
    const result = await run("roblox_set_script", { path: "ServerScriptService.Mian", source: "print(1)" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Roblox Studio: No 'Mian' in game.ServerScriptService (its children: Main).");
    expect(studio.calls.map((c) => c.command)).toEqual(["get_script"]);
  });

  it("asks for an edit approval showing the new source", () => {
    const { ctx } = setup();
    const t = get("roblox_set_script");
    expect(t.approval?.({ path: "ServerScriptService.Main", source: "print(2)" }, ctx)).toEqual({
      risk: "edit",
      summary: "edit script ServerScriptService.Main in Roblox Studio",
      detail: "print(2)",
    });
    expect(t.approval?.({ path: "X", oldText: "a\nb", newText: "c" }, ctx)?.detail).toBe("- a\n- b\n+ c");
    expect(t.describe({ path: "ServerScriptService.Main" }, ctx)).toEqual({ verb: "studio", target: "edit ServerScriptService.Main" });
  });

  it("replaceOnce handles $ and other special characters literally", () => {
    expect(replaceOnce("a = 1", "1", "$&$1")).toEqual({ source: "a = $&$1" });
  });
});

describe("roblox_create_instance / set_properties / delete_instance", () => {
  it("creates a script with source and shows its lines", async () => {
    const { studio, ctx } = setup();
    studio.handlers.create_instance = (args) => ({ path: `game.ServerScriptService.${args.name}`, className: args.className });
    const source = 'local Lava = workspace["Lava Pit"].Lava\nLava.Touched:Connect(function(hit)\n\tlocal h = hit.Parent:FindFirstChild("Humanoid")\n\tif h then h.Health = 0 end\nend)\n';
    const result = await run(
      "roblox_create_instance",
      { className: "Script", parent: "ServerScriptService", name: "KillOnTouch", source, properties: {}, attributes: {} },
      ctx,
    );
    expect(studio.calls[0].args).toEqual({ className: "Script", parent: "ServerScriptService", name: "KillOnTouch", source });
    expect(result.content).toBe("Created game.ServerScriptService.KillOnTouch (Script).");
    expect(result.display).toMatchObject({ target: "new game.ServerScriptService.KillOnTouch", detail: "5 lines", added: 5, removed: 0 });
  });

  it("lists properties that could not be set", async () => {
    const { studio, ctx } = setup();
    studio.handlers.create_instance = () => ({
      path: "game.Workspace.Platform",
      className: "Part",
      failed: [{ name: "Materail", error: "Materail is not a valid member of Part \"Platform\"" }],
    });
    const properties = { Size: [12, 1, 12], Position: { type: "Vector3", x: 0, y: 10, z: 0 }, Materail: "Neon", Anchored: true };
    const result = await run("roblox_create_instance", { className: "Part", parent: "Workspace", name: "Platform", properties }, ctx);
    expect(studio.calls[0].args.properties).toEqual(properties);
    expect(result.content).toBe('Created game.Workspace.Platform (Part).\nThese could not be set:\n  Materail: Materail is not a valid member of Part "Platform"');
    expect(result.display?.detail).toBe("created, 1 property failed");
    expect(get("roblox_create_instance").describe({ className: "Part", name: "Platform", parent: "Workspace" }, ctx).target).toBe(
      "new Part Platform in Workspace",
    );
  });

  it("sets properties and reports partial failures", async () => {
    const { studio, ctx } = setup();
    studio.handlers.set_properties = () => ({
      path: "game.Workspace.Bridge",
      changed: ["Anchored", "Name", "@Speed"],
      failed: [{ name: "Size", error: "Expected a Vector3 such as [0,5,0]" }],
    });
    const result = await run(
      "roblox_set_properties",
      { path: "Workspace.Platform", properties: { Name: "Bridge", Anchored: true, Size: "big" }, attributes: { Speed: 16 } },
      ctx,
    );
    expect(studio.calls[0].args).toEqual({
      path: "Workspace.Platform",
      properties: { Name: "Bridge", Anchored: true, Size: "big" },
      attributes: { Speed: 16 },
    });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Set Anchored, Name, @Speed on game.Workspace.Bridge.\nThese failed:\n  Size: Expected a Vector3 such as [0,5,0]");
    expect(result.display?.detail).toBe("3 set, 1 failed");
  });

  it("is an error when nothing could be set, and needs something to set", async () => {
    const { studio, ctx } = setup();
    studio.handlers.set_properties = () => ({ path: "game.Workspace.Part", changed: [], failed: [{ name: "Color", error: "bad colour" }] });
    const result = await run("roblox_set_properties", { path: "Workspace.Part", properties: { Color: "teal" } }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Nothing was set; these failed:");
    const empty = await run("roblox_set_properties", { path: "Workspace.Part", properties: [] }, ctx);
    expect(empty.isError).toBe(true);
    expect(studio.calls).toHaveLength(1);
  });

  it("deletes and says how to undo", async () => {
    const { studio, ctx } = setup();
    studio.handlers.delete_instance = () => ({ path: "game.Workspace['Lava Pit']", className: "Model", descendants: 3 });
    const result = await run("roblox_delete_instance", { path: "workspace['Lava Pit']" }, ctx);
    expect(result.content).toBe("Deleted game.Workspace['Lava Pit'] (Model) and 3 descendants. The user can undo it in Studio with Ctrl+Z.");
    expect(get("roblox_delete_instance").approval?.({ path: "Workspace.Part" }, ctx)).toEqual({
      risk: "edit",
      summary: "delete Workspace.Part in Roblox Studio",
    });
    studio.handlers.delete_instance = () => {
      throw new Error("Refusing to delete the service Workspace.");
    };
    const refused = await run("roblox_delete_instance", { path: "Workspace" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toBe("Roblox Studio: Refusing to delete the service Workspace.");
  });
});

describe("selection, find and output", () => {
  it("reads and sets the selection", async () => {
    const { studio, ctx } = setup();
    studio.handlers.get_selection = () => ({ selection: [] });
    expect((await run("roblox_get_selection", {}, ctx)).content).toBe("Nothing is selected in Studio.");
    studio.handlers.get_selection = () => ({ selection: [{ path: "game.Workspace.Baseplate", className: "Part" }] });
    expect((await run("roblox_get_selection", {}, ctx)).content).toBe("game.Workspace.Baseplate (Part)");
    studio.handlers.set_selection = (args) => ({
      selection: [{ path: "game.Workspace.Baseplate", className: "Part" }],
      missing: args.paths.filter((p: string) => p.includes("Nope")),
    });
    const set = await run("roblox_set_selection", { paths: ["Workspace.Baseplate", "Workspace.Nope", ""] }, ctx);
    expect(studio.calls.at(-1)?.args).toEqual({ paths: ["Workspace.Baseplate", "Workspace.Nope"] });
    expect(set.content).toBe("Selected:\ngame.Workspace.Baseplate (Part)\nNot found: Workspace.Nope");
    expect(set.display?.detail).toBe("1 selected, 1 not found");
  });

  it("finds by class and name, and says when the list is cut", async () => {
    const { studio, ctx } = setup();
    expect((await run("roblox_find", {}, ctx)).isError).toBe(true);
    studio.handlers.find_instances = () => ({
      root: "game",
      matches: [
        { path: "game.ServerScriptService.Main", className: "Script" },
        { path: "game.StarterPlayer.StarterPlayerScripts.Camera", className: "LocalScript" },
      ],
      total: 7,
      truncated: true,
    });
    const result = await run("roblox_find", { className: "LuaSourceContainer", limit: 2 }, ctx);
    expect(studio.calls[0]).toMatchObject({ command: "find_instances", args: { root: "game", limit: 2, className: "LuaSourceContainer" }, timeoutMs: 60_000 });
    expect(result.content).toBe(
      "7 matches under game; the first 2:\ngame.ServerScriptService.Main (Script)\ngame.StarterPlayer.StarterPlayerScripts.Camera (LocalScript)",
    );
    expect(result.display?.detail).toBe("7 matches");
    studio.handlers.find_instances = () => ({ root: "game.Workspace", matches: [], total: 0, truncated: false });
    expect((await run("roblox_find", { root: "Workspace", name: "^Lava%d+$" }, ctx)).content).toBe("No matches under game.Workspace.");
    expect(get("roblox_find").describe({ className: "Part", name: "Lava" }, ctx).target).toBe('find Part "Lava"');
  });

  it("reads Studio's output, newest lines, optionally only problems", async () => {
    const { studio, ctx } = setup();
    const at = new Date(2026, 9, 25, 14, 5, 9).getTime();
    studio.log = [
      { at, type: "MessageOutput", text: "Hello world!" },
      { at, type: "MessageInfo", text: "Stack Begin" },
      { at, type: "MessageWarning", text: "Infinite yield possible on 'Players.Luna:WaitForChild(\"Backpack2\")'" },
      { at, type: "MessageError", text: "ServerScriptService.Main:4: attempt to index nil with 'Name'" },
    ];
    const all = await run("roblox_output", {}, ctx);
    expect(all.content.split("\n")).toEqual([
      "[14:05:09] Hello world!",
      "[14:05:09] info: Stack Begin",
      "[14:05:09] warn: Infinite yield possible on 'Players.Luna:WaitForChild(\"Backpack2\")'",
      "[14:05:09] error: ServerScriptService.Main:4: attempt to index nil with 'Name'",
    ]);
    expect(all.display?.detail).toBe("4 lines, 1 error");
    const problems = await run("roblox_output", { errorsOnly: true, limit: 1 }, ctx);
    expect(problems.content).toBe("[14:05:09] error: ServerScriptService.Main:4: attempt to index nil with 'Name'");
    studio.log = [];
    expect((await run("roblox_output", {}, ctx)).content).toBe("Studio's output is empty so far.");
    // The buffer can be read without calling the plugin.
    expect(studio.calls).toEqual([]);
  });
});

describe("the tools against a real bridge", () => {
  const bridges: RobloxBridge[] = [];
  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((b) => b.stop()));
  });

  it("drives a (fake) Studio plugin end to end", async () => {
    const bridge = new RobloxBridge({ port: 0 });
    bridges.push(bridge);
    await bridge.start();
    const ctx = makeCtx({ services: services({ roblox: bridge }) });
    const notYet = await run("roblox_get_tree", {}, ctx);
    expect(notYet.isError).toBe(true);
    expect(notYet.content).toContain(`127.0.0.1:${bridge.status().port}`);

    const plugin = new FakePlugin(bridge.status().port);
    await plugin.hello();
    const pending = run("roblox_get_tree", { path: "Workspace", depth: 1 }, ctx);
    const served = await plugin.serveOnce((command, args) => ({
      ok: true,
      result: {
        name: "Workspace",
        className: "Workspace",
        path: "game.Workspace",
        childCount: 1,
        children: [{ name: "Baseplate", className: "Part", path: "game.Workspace.Baseplate", childCount: 0 }],
        echo: { command, args },
      },
    }));
    expect(served).toEqual({ command: "get_tree", args: { path: "Workspace", depth: 1, maxChildren: 50 } });
    const result = await pending;
    expect(result.content).toBe("game.Workspace (Workspace)\n  Baseplate (Part)");

    await plugin.log([{ type: "MessageError", text: "Workspace.Script:1: boom", at: Date.now() }]);
    expect((await run("roblox_output", {}, ctx)).content).toMatch(/error: Workspace\.Script:1: boom$/);
  });
});
