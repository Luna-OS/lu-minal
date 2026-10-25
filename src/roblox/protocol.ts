// The wire protocol between lu-minal's bridge (src/roblox/bridge.ts) and the Studio plugin
// (roblox/LuMinal.server.luau): the port, the marker header, every command the plugin understands
// with its arguments and results, and the messages shown when Studio is not connected. The agent
// tools (src/tools/roblox.ts) only send the commands listed here; a test checks that the plugin
// implements every one of them.
import type { RobloxStatus } from "./types.js";

/** The bridge's default port (config `roblox.port`). */
export const DEFAULT_ROBLOX_PORT = 44766;

/**
 * The header every plugin request carries (the value is the plugin's version). Browsers cannot
 * send a custom header to another origin without a CORS preflight, which the bridge never approves.
 */
export const PLUGIN_HEADER = "X-LuMinal-Plugin";

/** Every command the plugin implements. */
export const ROBLOX_COMMANDS = [
  "ping",
  "run_luau",
  "get_tree",
  "get_properties",
  "get_script",
  "set_script",
  "create_instance",
  "set_properties",
  "delete_instance",
  "get_selection",
  "set_selection",
  "find_instances",
] as const;

export type RobloxCommand = (typeof ROBLOX_COMMANDS)[number];

/**
 * A property value as JSON. Plain numbers, strings and booleans pass through; Roblox types are
 * tagged objects: {"type":"Vector3","x":0,"y":5,"z":0}, {"type":"Color3","r":1,"g":0,"b":0,"hex":"#ff0000"},
 * {"type":"UDim2","x":{"scale":0.5,"offset":0},"y":{...}}, {"type":"CFrame","position":[x,y,z],"rotation":[rx,ry,rz]}
 * (degrees, XYZ order), {"type":"BrickColor","name":"Bright red"}, {"type":"NumberRange","min":1,"max":2},
 * {"type":"Instance","path":"game.Workspace.Part","className":"Part"}. Enum items are strings ("Enum.Material.Neon").
 */
export type RobloxValue = null | boolean | number | string | RobloxValue[] | { [key: string]: RobloxValue };

/** An instance as results list it. */
export interface InstanceRef {
  path: string;
  className: string;
}

/** A property the plugin could not set. */
export interface PropertyFailure {
  name: string;
  error: string;
}

/** `ping` {} */
export interface PingResult {
  pluginVersion: string;
  studioVersion: string | null;
  place: { name: string; placeId: number; gameId: number };
}

/** `run_luau` { code, timeout? (seconds, default 20, max 120) } */
export interface RunLuauArgs {
  code: string;
  timeout?: number;
}

export interface RunLuauResult {
  /** Everything the code printed (print / warn), in order. */
  output: Array<{ kind: "print" | "warn"; text: string }>;
  /** The returned values, each tostring'ed (instances as paths, strings quoted). */
  returns: string[];
  /** The runtime error, when the code failed (the output before it is kept). */
  error?: string;
  timedOut?: boolean;
  /** Output beyond the plugin's limit was dropped. */
  truncated?: boolean;
}

/** `get_tree` { path = "game", depth = 2, maxChildren = 50 } */
export interface GetTreeArgs {
  path?: string;
  depth?: number;
  maxChildren?: number;
}

export interface TreeNode {
  name: string;
  className: string;
  path: string;
  childCount: number;
  /** Present when the node was expanded (within `depth`). */
  children?: TreeNode[];
  /** How many children were left out (maxChildren, the node budget, or internal services under game). */
  more?: number;
}

/** `get_properties` { path, names? } */
export interface GetPropertiesArgs {
  path: string;
  names?: string[];
}

export interface PropertiesResult {
  path: string;
  className: string;
  /** In a stable order: Name, ClassName, Parent first, then the class's common properties. */
  properties: Array<{ name: string; value?: RobloxValue }>;
  /** Roblox encodes an empty table as [], so this may be an empty array. */
  attributes?: Record<string, RobloxValue> | RobloxValue[];
  tags?: string[];
  /** Requested names that are neither a property nor an attribute. */
  missing?: string[];
}

/** `get_script` { path } */
export interface ScriptResult {
  path: string;
  className: string;
  source: string;
  lineCount: number;
  /** The script is open in a Studio editor tab (the source is the editor's, unsaved edits included). */
  open?: boolean;
}

/** `set_script` { path, source } */
export interface SetScriptResult {
  path: string;
  lineCount: number;
  /** "editor": ScriptEditorService:UpdateSourceAsync; "source": the .Source fallback. */
  method: "editor" | "source";
}

/** `create_instance` { className, parent, name?, properties?, attributes?, source? } */
export interface CreateInstanceArgs {
  className: string;
  parent: string;
  name?: string;
  properties?: Record<string, RobloxValue>;
  attributes?: Record<string, RobloxValue>;
  source?: string;
}

export interface CreateInstanceResult {
  path: string;
  className: string;
  failed?: PropertyFailure[];
}

/** `set_properties` { path, properties, attributes? } */
export interface SetPropertiesResult {
  /** The path after the change (Name or Parent may have changed it). */
  path: string;
  changed: string[];
  failed: PropertyFailure[];
}

/** `delete_instance` { path } */
export interface DeleteInstanceResult {
  path: string;
  className: string;
  descendants: number;
}

/** `get_selection` {} and `set_selection` { paths } */
export interface SelectionResult {
  selection: InstanceRef[];
  /** set_selection: paths that did not resolve. */
  missing?: string[];
}

/** `find_instances` { root = "game", className?, name?, limit = 100 } */
export interface FindInstancesArgs {
  root?: string;
  className?: string;
  name?: string;
  limit?: number;
}

export interface FindInstancesResult {
  root: string;
  matches: InstanceRef[];
  /** All matches, including the ones beyond `limit`. */
  total: number;
  truncated: boolean;
}

/** How to connect Studio, for errors and the agents. */
export function connectSteps(port: number): string {
  return (
    'To connect Roblox Studio: 1) install the plugin once with "lu-minal roblox install" (or /roblox in lu-minal) and restart Studio, ' +
    "2) when Studio asks whether the lu-minal plugin may send HTTP requests to localhost, allow it, " +
    `3) click "Connect" on the lu-minal toolbar in Studio's Plugins tab. The bridge listens on 127.0.0.1:${port}.`
  );
}

/** Why a command can't be sent right now, with what to do about it. */
export function notConnectedMessage(status: RobloxStatus): string {
  if (!status.listening) {
    return (
      `The Roblox Studio bridge is not running${status.error ? `: ${status.error}` : "."} ` +
      'Restart it from /roblox in lu-minal, or change the port (roblox.port in the settings) and reinstall the plugin with "lu-minal roblox install".'
    );
  }
  return `Roblox Studio is not connected. ${connectSteps(status.port)}`;
}
