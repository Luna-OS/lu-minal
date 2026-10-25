// The Roblox Studio tools: agents read the open place's tree and properties, edit scripts and
// instances, run Luau and read Studio's output through the bridge (ctx.services.roblox, see
// src/roblox/). Every tool is offered to Claude Code agents too (mcp: true). Results are compact
// text for the model; the panel shows "studio tree", "studio edit <path>" (with the diff), ...
import { PLUGIN_VERSION } from "../roblox/plugin-source.js";
import {
  connectSteps,
  notConnectedMessage,
  type CreateInstanceResult,
  type DeleteInstanceResult,
  type FindInstancesResult,
  type InstanceRef,
  type PingResult,
  type PropertiesResult,
  type PropertyFailure,
  type RobloxCommand,
  type RunLuauResult,
  type ScriptResult,
  type SelectionResult,
  type SetPropertiesResult,
  type SetScriptResult,
  type TreeNode,
} from "../roblox/protocol.js";
import type { RobloxLogLine } from "../roblox/types.js";
import { describeChange, makeDiff } from "./diff.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const VERB = "studio";

const PATH_HELP =
  'Paths start at game: "game.Workspace.Model.Part", "Workspace/Model/Part" or "workspace.Model[\'Odd Name\']" (brackets for names with spaces or dots).';

const VALUE_HELP =
  "Values: numbers, strings, booleans; Vector3 as [x,y,z] or {\"type\":\"Vector3\",\"x\":0,\"y\":5,\"z\":0}; Vector2 as [x,y]; " +
  'Color3 as "#rrggbb" or {"type":"Color3","r":1,"g":0.5,"b":0} (0..1); BrickColor by name ("Bright red"); ' +
  "UDim2 as [xScale,xOffset,yScale,yOffset]; UDim as [scale,offset]; " +
  'CFrame as {"type":"CFrame","position":[x,y,z],"rotation":[rx,ry,rz]} (degrees) or {"position":[...],"lookAt":[...]}; ' +
  'enums as "Enum.Material.Neon" or just "Neon"; NumberRange as [min,max]; instance references as a path; "Pivot" (a CFrame) moves a whole model.';

// ---- small helpers -----------------------------------------------------------------------------

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** An object; Roblox encodes an empty table as [], so arrays count as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function int(value: unknown, fallback: number, low: number, high: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.floor(n)));
}

function fail(content: string, detail?: string): ToolResult {
  return { content, isError: true, display: { detail: detail ?? clip(content, 70) } };
}

/** The not-connected answer, or null when Studio is there. */
function notConnected(ctx: ToolContext): ToolResult | null {
  const status = ctx.services.roblox.status();
  if (status.connected) return null;
  return fail(notConnectedMessage(status), status.listening ? "Studio not connected" : "bridge not running");
}

function studioError(err: unknown): ToolResult {
  const message = errText(err);
  return fail(/^Roblox Studio/.test(message) ? message : `Roblox Studio: ${message}`, clip(message, 70));
}

/** Runs `fn` when Studio is connected; plugin errors become error results. */
async function withStudio(ctx: ToolContext, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const gate = notConnected(ctx);
  if (gate) return gate;
  try {
    return await fn();
  } catch (err) {
    return studioError(err);
  }
}

function send<T>(ctx: ToolContext, command: RobloxCommand, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  return ctx.services.roblox.call<T>(command, args, timeoutMs);
}

function tool<A extends Record<string, unknown>>(t: Tool<A>): Tool {
  return t as unknown as Tool;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name as a path segment would write it: `Part` or `['Odd Name']`. */
function nameLabel(name: string): string {
  return IDENT.test(name) ? name : `['${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

function failures(list: PropertyFailure[]): string {
  return list.map((f) => `  ${f.name}: ${f.error}`).join("\n");
}

function refLine(ref: InstanceRef): string {
  return `${ref.path} (${ref.className})`;
}

// ---- formatting --------------------------------------------------------------------------------

function n(value: unknown): string {
  return typeof value === "number" ? String(value) : String(value ?? "?");
}

/** A property value (as the plugin encodes it) the way the model reads it. */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "nil";
  if (typeof value === "string") return /^Enum\.\w+\.\w+$/.test(value) ? value : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value !== "object") return String(value);
  const v = value as Record<string, unknown>;
  const pair = (u: unknown) => {
    const d = asRecord(u);
    return `${n(d.scale)}, ${n(d.offset)}`;
  };
  switch (v.type) {
    case "Vector3":
      return `Vector3(${n(v.x)}, ${n(v.y)}, ${n(v.z)})`;
    case "Vector2":
      return `Vector2(${n(v.x)}, ${n(v.y)})`;
    case "Color3":
      return `Color3(${typeof v.hex === "string" ? v.hex : `${n(v.r)}, ${n(v.g)}, ${n(v.b)}`})`;
    case "BrickColor":
      return `BrickColor(${JSON.stringify(v.name ?? "")})`;
    case "UDim":
      return `UDim(${n(v.scale)}, ${n(v.offset)})`;
    case "UDim2":
      return `UDim2(${pair(v.x)}, ${pair(v.y)})`;
    case "CFrame": {
      const pos = asArray<unknown>(v.position).map(n).join(", ");
      const rot = asArray<unknown>(v.rotation).map(n).join(", ");
      return `CFrame(pos ${pos}; rot ${rot})`;
    }
    case "NumberRange":
      return `NumberRange(${n(v.min)}, ${n(v.max)})`;
    case "Rect":
      return `Rect(${asArray<unknown>(v.min).map(n).join(", ")}; ${asArray<unknown>(v.max).map(n).join(", ")})`;
    case "Instance":
      return typeof v.path === "string" ? v.path : "nil";
    case "Font":
      return `Font(${JSON.stringify(v.family ?? "")}, ${n(v.weight)}, ${n(v.style)})`;
    default:
      if (typeof v.type === "string" && v.value !== undefined) return `${v.type}(${String(v.value)})`;
      return JSON.stringify(value);
  }
}

/** A tree as indented lines ("Model (Model, 3 children)"), and how many instances it shows. */
export function formatTree(root: TreeNode): { text: string; count: number } {
  const lines: string[] = [];
  let count = 0;
  const visit = (node: TreeNode, depth: number) => {
    count++;
    const children = asArray<TreeNode>(node.children);
    const label = depth === 0 ? node.path : nameLabel(node.name);
    const extra = node.childCount > 0 && children.length === 0 ? `, ${plural(node.childCount, "child", "children")}` : "";
    lines.push(`${"  ".repeat(depth)}${label} (${node.className}${extra})`);
    for (const child of children) visit(child, depth + 1);
    if (node.more && node.more > 0) {
      const what = node.path === "game" ? "other services" : "more";
      lines.push(`${"  ".repeat(depth + 1)}… ${node.more} ${what}`);
    }
  };
  visit(root, 0);
  return { text: lines.join("\n"), count };
}

/** get_properties' result as "Name = value" lines, then attributes and tags. */
export function formatProperties(result: PropertiesResult): string {
  const lines = [`${result.path} (${result.className})`];
  for (const p of asArray<{ name: string; value?: unknown }>(result.properties)) {
    lines.push(`  ${p.name} = ${formatValue(p.value)}`);
  }
  const attributes = Object.entries(asRecord(result.attributes));
  if (attributes.length) {
    lines.push("Attributes:");
    for (const [key, value] of attributes.sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${key} = ${formatValue(value)}`);
  }
  const tags = asArray<string>(result.tags);
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  const missing = asArray<string>(result.missing);
  if (missing.length) lines.push(`Not found (no such property or attribute): ${missing.join(", ")}`);
  return lines.join("\n");
}

/** run_luau's result: the output, the returned values and the error. */
export function formatRun(result: RunLuauResult): string {
  const lines: string[] = [];
  const output = asArray<{ kind: string; text: string }>(result.output);
  if (output.length) {
    lines.push("Output:");
    for (const o of output) lines.push(o.kind === "warn" ? `warn: ${o.text}` : o.text);
    if (result.truncated) lines.push("… (more output was cut off)");
  }
  const returns = asArray<string>(result.returns);
  if (returns.length) lines.push(`Returned: ${returns.join(", ")}`);
  if (result.error) lines.push(`${result.timedOut ? "Timed out" : "Error"}: ${result.error}`);
  if (!lines.length) lines.push("Ran without output or return values.");
  return lines.join("\n");
}

const LOG_KINDS: Record<string, string> = {
  MessageOutput: "",
  MessageInfo: "info: ",
  MessageWarning: "warn: ",
  MessageError: "error: ",
};

function clock(at: number): string {
  const d = new Date(at);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Studio output lines as "[12:01:02] warn: text". */
export function formatOutput(lines: RobloxLogLine[]): string {
  return lines.map((l) => `[${clock(l.at)}] ${LOG_KINDS[l.type] ?? `${l.type}: `}${l.text}`).join("\n");
}

/** Replaces the single occurrence of `oldText` in `source`; an error text when it is missing or ambiguous. */
export function replaceOnce(source: string, oldText: string, newText: string): { source: string } | { error: string } {
  if (!oldText) return { error: "oldText is empty." };
  const at = source.indexOf(oldText);
  if (at < 0) return { error: "oldText was not found in the script. Read it again with roblox_get_script and copy the text exactly." };
  if (source.indexOf(oldText, at + 1) >= 0) {
    return { error: "oldText occurs more than once in the script; include more surrounding lines so it is unique." };
  }
  return { source: source.slice(0, at) + newText + source.slice(at + oldText.length) };
}

// ---- the tools ---------------------------------------------------------------------------------

const statusTool = tool<Record<string, never>>({
  name: "roblox_status",
  description:
    "Show whether Roblox Studio is connected to lu-minal: the open place, Studio's version and the plugin's version. " +
    "When it isn't connected, the answer says how the user connects it.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  mcp: true,
  describe: () => ({ verb: VERB, target: "status" }),
  run: async (_args, ctx) => {
    const roblox = ctx.services.roblox;
    const status = roblox.status();
    if (!status.listening) return { content: notConnectedMessage(status), display: { detail: "bridge not running" } };
    if (!status.connected) {
      const seen = status.lastSeen ? ` Studio was last seen ${new Date(status.lastSeen).toISOString()}.` : "";
      return {
        content: `The bridge is listening on 127.0.0.1:${status.port}, but Roblox Studio is not connected.${seen}\n${connectSteps(status.port)}`,
        display: { detail: "not connected" },
      };
    }
    const place = status.place;
    const lines = [
      `Roblox Studio${status.studioVersion ? ` ${status.studioVersion}` : ""} is connected` +
        (place ? `: place "${place.name}" (placeId ${place.placeId}, gameId ${place.gameId}).` : "."),
    ];
    try {
      const ping = await roblox.call<PingResult>("ping", {}, 5000);
      const version = str(ping?.pluginVersion);
      lines.push(`The lu-minal plugin ${version ?? "(unknown version)"} answers.`);
      if (version && version !== PLUGIN_VERSION) {
        lines.push(`This lu-minal ships plugin ${PLUGIN_VERSION}; ask the user to run "lu-minal roblox install" and restart Studio.`);
      }
    } catch (err) {
      lines.push(`The plugin did not answer a ping: ${errText(err)}`);
    }
    lines.push(`${plural(roblox.output().length, "line")} of Studio output buffered (roblox_output).`);
    return { content: lines.join("\n"), display: { detail: place ? `connected · ${place.name}` : "connected" } };
  },
});

const runLuauTool = tool<{ code: string; timeout?: number }>({
  name: "roblox_run_luau",
  description:
    "Run Luau code in Roblox Studio (edit mode, plugin context: game, workspace and every service are available). " +
    "Returns what it printed (print / warn) and its return values. Use it to inspect things the other tools don't cover, " +
    "or for bulk changes; changes made this way are not one undo step, so prefer the dedicated tools for edits.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "The Luau code; `return` values are reported." },
      timeout: { type: "number", description: "Seconds to wait for it (default 20, max 120)." },
    },
    required: ["code"],
    additionalProperties: false,
  },
  risk: "exec",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `run ${clip(String(args.code ?? "").split("\n").find((l) => l.trim()) ?? "", 50)}`.trim() }),
  approval: (args) => ({ risk: "exec", summary: "run Luau in Roblox Studio", detail: String(args.code ?? "") }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      if (typeof args.code !== "string" || !args.code.trim()) return fail("Give the Luau code to run in `code`.");
      const timeout = int(args.timeout, 20, 1, 120);
      const result = await send<RunLuauResult>(ctx, "run_luau", { code: args.code, timeout }, (timeout + 10) * 1000);
      const output = asArray<unknown>(result?.output);
      const text = formatRun(result ?? { output: [], returns: [] });
      if (result?.error) return { content: text, isError: true, display: { detail: clip(result.error, 70) } };
      return {
        content: text,
        display: { detail: output.length ? plural(output.length, "line") + " of output" : "✓ ran" },
      };
    }),
});

const getTreeTool = tool<{ path?: string; depth?: number; maxChildren?: number }>({
  name: "roblox_get_tree",
  description:
    "List the instance tree of the open place (names and classes), from `path` (default game: the main services) down `depth` levels. " +
    `Call it before editing to learn the place's structure. ${PATH_HELP}`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: 'Where to start (default "game").' },
      depth: { type: "number", description: "Levels below the start to list (default 2, max 10)." },
      maxChildren: { type: "number", description: "Children listed per instance (default 50)." },
    },
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `tree ${str(args.path) ?? "game"}` }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const root = await send<TreeNode>(ctx, "get_tree", {
        path: str(args.path) ?? "game",
        depth: int(args.depth, 2, 0, 10),
        maxChildren: int(args.maxChildren, 50, 1, 500),
      });
      const { text, count } = formatTree(root);
      return { content: text, display: { detail: plural(count, "instance") } };
    }),
});

const getPropertiesTool = tool<{ path: string; names?: string[] }>({
  name: "roblox_get_properties",
  description:
    "Read an instance's properties: the common ones for its class (Position, Size, Color, Material, Anchored, Text, Value, ...) " +
    `plus its attributes and tags, or exactly the properties named in \`names\`. ${PATH_HELP}`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The instance" },
      names: { type: "array", items: { type: "string" }, description: "Only these properties (or attributes)" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `props ${str(args.path) ?? "?"}` }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const path = str(args.path);
      if (!path) return fail("Give the instance's `path`.");
      const names = asArray<unknown>(args.names).filter((x): x is string => typeof x === "string" && x.trim() !== "");
      const result = await send<PropertiesResult>(ctx, "get_properties", names.length ? { path, names } : { path });
      return { content: formatProperties(result), display: { detail: plural(asArray(result.properties).length, "property", "properties") } };
    }),
});

const getScriptTool = tool<{ path: string }>({
  name: "roblox_get_script",
  description: `Read a Script, LocalScript or ModuleScript's source (the editor's text when it is open in Studio). ${PATH_HELP}`,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "The script" } },
    required: ["path"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `read ${str(args.path) ?? "?"}` }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const path = str(args.path);
      if (!path) return fail("Give the script's `path`.");
      const result = await send<ScriptResult>(ctx, "get_script", { path });
      const source = typeof result.source === "string" ? result.source : "";
      const head = `${result.path} (${result.className}, ${plural(result.lineCount, "line")}${result.open ? ", open in the editor" : ""})`;
      return {
        content: source ? `${head}\n\`\`\`lua\n${source}${source.endsWith("\n") ? "" : "\n"}\`\`\`` : `${head}\n(empty)`,
        display: { detail: plural(result.lineCount, "line") },
      };
    }),
});

const setScriptTool = tool<{ path: string; source?: string; oldText?: string; newText?: string }>({
  name: "roblox_set_script",
  description:
    "Change a script's source in Roblox Studio (one undo step; open editors update too). Give either `source` (the whole new source) " +
    "or `oldText` + `newText` to replace one exact, unique passage (read the script first with roblox_get_script). " +
    "To make a new script use roblox_create_instance with `source`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The script" },
      source: { type: "string", description: "The complete new source" },
      oldText: { type: "string", description: "Text to replace (must occur exactly once)" },
      newText: { type: "string", description: "What replaces oldText" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  risk: "edit",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `edit ${str(args.path) ?? "?"}` }),
  approval: (args) => ({
    risk: "edit",
    summary: `edit script ${str(args.path) ?? "?"} in Roblox Studio`,
    detail:
      typeof args.source === "string"
        ? args.source
        : `- ${String(args.oldText ?? "").split("\n").join("\n- ")}\n+ ${String(args.newText ?? "").split("\n").join("\n+ ")}`,
  }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const path = str(args.path);
      if (!path) return fail("Give the script's `path`.");
      const replacing = typeof args.oldText === "string";
      if (typeof args.source !== "string" && !replacing) return fail("Give `source` (the whole new source) or `oldText` and `newText`.");
      const current = await send<ScriptResult>(ctx, "get_script", { path });
      const oldSource = typeof current.source === "string" ? current.source : "";
      let newSource: string;
      if (typeof args.source === "string") {
        newSource = args.source;
      } else {
        const replaced = replaceOnce(oldSource, String(args.oldText), String(args.newText ?? ""));
        if ("error" in replaced) return fail(replaced.error, "text not found");
        newSource = replaced.source;
      }
      if (newSource === oldSource) {
        return { content: `${current.path} already has this source; nothing changed.`, display: { target: `edit ${current.path}`, detail: "no changes" } };
      }
      const result = await send<SetScriptResult>(ctx, "set_script", { path: current.path, source: newSource });
      const diff = makeDiff(oldSource, newSource);
      const change = describeChange(diff.added, diff.removed);
      return {
        content: `Updated ${result.path}: ${change} (${plural(result.lineCount, "line")} now). Undo in Studio with Ctrl+Z.`,
        display: { target: `edit ${result.path}`, detail: change, diff: diff.lines, added: diff.added, removed: diff.removed },
      };
    }),
});

const createInstanceTool = tool<{
  className: string;
  parent: string;
  name?: string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  source?: string;
}>({
  name: "roblox_create_instance",
  description:
    "Create an instance in Roblox Studio (one undo step): a Part, Model, Folder, Script, LocalScript, ModuleScript, ScreenGui, ... " +
    `under \`parent\`, with optional name, properties, attributes and (for scripts) source. ${PATH_HELP} ${VALUE_HELP}`,
  parameters: {
    type: "object",
    properties: {
      className: { type: "string", description: "The class, e.g. Part, Script, ModuleScript, Folder" },
      parent: { type: "string", description: 'Where to put it, e.g. "game.Workspace" or "ServerScriptService"' },
      name: { type: "string" },
      properties: { type: "object", description: "Property name -> value", additionalProperties: true },
      attributes: { type: "object", description: "Attribute name -> value", additionalProperties: true },
      source: { type: "string", description: "Source code, for scripts" },
    },
    required: ["className", "parent"],
    additionalProperties: false,
  },
  risk: "edit",
  mcp: true,
  describe: (args) => ({
    verb: VERB,
    target: `new ${str(args.className) ?? "?"}${args.name ? ` ${args.name}` : ""} in ${str(args.parent) ?? "?"}`,
  }),
  approval: (args) => ({
    risk: "edit",
    summary: `create ${str(args.className) ?? "?"} in ${str(args.parent) ?? "?"} (Roblox Studio)`,
    detail: JSON.stringify({ name: args.name, properties: args.properties, attributes: args.attributes, source: args.source }, null, 2),
  }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const className = str(args.className);
      const parent = str(args.parent);
      if (!className || !parent) return fail("Give `className` and `parent`.");
      const payload: Record<string, unknown> = { className, parent };
      if (str(args.name)) payload.name = args.name;
      if (Object.keys(asRecord(args.properties)).length) payload.properties = args.properties;
      if (Object.keys(asRecord(args.attributes)).length) payload.attributes = args.attributes;
      if (typeof args.source === "string") payload.source = args.source;
      const result = await send<CreateInstanceResult>(ctx, "create_instance", payload);
      const failed = asArray<PropertyFailure>(result.failed);
      const lines = [`Created ${result.path} (${result.className}).`];
      if (failed.length) lines.push(`These could not be set:\n${failures(failed)}`);
      const diff = typeof args.source === "string" && args.source ? makeDiff("", args.source) : null;
      return {
        content: lines.join("\n"),
        display: {
          target: `new ${result.path}`,
          detail: failed.length ? `created, ${plural(failed.length, "property", "properties")} failed` : diff ? `${plural(diff.added, "line")}` : "created",
          ...(diff ? { diff: diff.lines, added: diff.added, removed: 0 } : {}),
        },
      };
    }),
});

const setPropertiesTool = tool<{ path: string; properties?: Record<string, unknown>; attributes?: Record<string, unknown> }>({
  name: "roblox_set_properties",
  description:
    "Set properties (and attributes) of an instance in Roblox Studio (one undo step). Renaming (Name) and moving (Parent) work too. " +
    `${PATH_HELP} ${VALUE_HELP}`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "The instance" },
      properties: { type: "object", description: "Property name -> value", additionalProperties: true },
      attributes: { type: "object", description: "Attribute name -> value", additionalProperties: true },
    },
    required: ["path"],
    additionalProperties: false,
  },
  risk: "edit",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `set ${str(args.path) ?? "?"}` }),
  approval: (args) => ({
    risk: "edit",
    summary: `set ${Object.keys(asRecord(args.properties)).join(", ") || "attributes"} on ${str(args.path) ?? "?"} (Roblox Studio)`,
    detail: JSON.stringify({ properties: args.properties, attributes: args.attributes }, null, 2),
  }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const path = str(args.path);
      if (!path) return fail("Give the instance's `path`.");
      const properties = asRecord(args.properties);
      const attributes = asRecord(args.attributes);
      if (!Object.keys(properties).length && !Object.keys(attributes).length) {
        return fail("Give `properties` (name -> value) or `attributes` to set.");
      }
      const payload: Record<string, unknown> = { path };
      if (Object.keys(properties).length) payload.properties = properties;
      if (Object.keys(attributes).length) payload.attributes = attributes;
      const result = await send<SetPropertiesResult>(ctx, "set_properties", payload);
      const changed = asArray<string>(result.changed);
      const failed = asArray<PropertyFailure>(result.failed);
      const lines: string[] = [];
      if (changed.length) lines.push(`Set ${changed.join(", ")} on ${result.path}.`);
      if (failed.length) lines.push(`${changed.length ? "These" : "Nothing was set; these"} failed:\n${failures(failed)}`);
      return {
        content: lines.join("\n") || `Nothing changed on ${result.path}.`,
        isError: changed.length === 0 && failed.length > 0,
        display: {
          target: `set ${result.path}`,
          detail: failed.length ? `${changed.length} set, ${failed.length} failed` : plural(changed.length, "property", "properties"),
        },
      };
    }),
});

const deleteInstanceTool = tool<{ path: string }>({
  name: "roblox_delete_instance",
  description: `Delete an instance (and everything inside it) in Roblox Studio; the user can undo it with Ctrl+Z. Services and game can't be deleted. ${PATH_HELP}`,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "The instance" } },
    required: ["path"],
    additionalProperties: false,
  },
  risk: "edit",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `delete ${str(args.path) ?? "?"}` }),
  approval: (args) => ({ risk: "edit", summary: `delete ${str(args.path) ?? "?"} in Roblox Studio` }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const path = str(args.path);
      if (!path) return fail("Give the instance's `path`.");
      const result = await send<DeleteInstanceResult>(ctx, "delete_instance", { path });
      const inside = result.descendants ? ` and ${plural(result.descendants, "descendant")}` : "";
      return {
        content: `Deleted ${result.path} (${result.className})${inside}. The user can undo it in Studio with Ctrl+Z.`,
        display: { target: `delete ${result.path}`, detail: result.descendants ? `+ ${plural(result.descendants, "descendant")}` : "deleted" },
      };
    }),
});

const getSelectionTool = tool<Record<string, never>>({
  name: "roblox_get_selection",
  description: "List what the user has selected in Roblox Studio's Explorer (paths and classes). Handy when they say \"this part\".",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  risk: "read",
  mcp: true,
  describe: () => ({ verb: VERB, target: "selection" }),
  run: (_args, ctx) =>
    withStudio(ctx, async () => {
      const result = await send<SelectionResult>(ctx, "get_selection", {});
      const selection = asArray<InstanceRef>(result.selection);
      if (!selection.length) return { content: "Nothing is selected in Studio.", display: { detail: "nothing selected" } };
      return { content: selection.map(refLine).join("\n"), display: { detail: `${selection.length} selected` } };
    }),
});

const setSelectionTool = tool<{ paths: string[] }>({
  name: "roblox_set_selection",
  description: `Select instances in Roblox Studio's Explorer (to show the user what you mean). An empty list clears the selection. ${PATH_HELP}`,
  parameters: {
    type: "object",
    properties: { paths: { type: "array", items: { type: "string" }, description: "The instances to select" } },
    required: ["paths"],
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({ verb: VERB, target: `select ${plural(asArray(args.paths).length, "instance")}` }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const paths = (typeof args.paths === "string" ? [args.paths] : asArray<unknown>(args.paths)).filter(
        (p): p is string => typeof p === "string" && p.trim() !== "",
      );
      const result = await send<SelectionResult>(ctx, "set_selection", { paths });
      const selection = asArray<InstanceRef>(result.selection);
      const missing = asArray<string>(result.missing);
      const lines = [selection.length ? `Selected:\n${selection.map(refLine).join("\n")}` : "Cleared the selection."];
      if (missing.length) lines.push(`Not found: ${missing.join(", ")}`);
      return { content: lines.join("\n"), display: { detail: `${selection.length} selected${missing.length ? `, ${missing.length} not found` : ""}` } };
    }),
});

const findTool = tool<{ root?: string; className?: string; name?: string; limit?: number }>({
  name: "roblox_find",
  description:
    "Find instances in the open place by class (IsA, so \"BasePart\" or \"LuaSourceContainer\" match subclasses) and/or by name " +
    `(a case-insensitive substring, or a Lua pattern). Searches under \`root\` (default game). ${PATH_HELP}`,
  parameters: {
    type: "object",
    properties: {
      root: { type: "string", description: 'Where to search (default "game")' },
      className: { type: "string", description: "Class name, e.g. Script, BasePart, RemoteEvent" },
      name: { type: "string", description: "Name substring or Lua pattern" },
      limit: { type: "number", description: "Most results to list (default 100)" },
    },
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: (args) => ({
    verb: VERB,
    target: `find ${[str(args.className), str(args.name) ? JSON.stringify(args.name) : undefined].filter(Boolean).join(" ") || "?"}`,
  }),
  run: (args, ctx) =>
    withStudio(ctx, async () => {
      const className = str(args.className);
      const name = str(args.name);
      if (!className && !name) return fail("Give a `className` and/or a `name` to search for.");
      const payload: Record<string, unknown> = { root: str(args.root) ?? "game", limit: int(args.limit, 100, 1, 1000) };
      if (className) payload.className = className;
      if (name) payload.name = name;
      const result = await send<FindInstancesResult>(ctx, "find_instances", payload, 60_000);
      const matches = asArray<InstanceRef>(result.matches);
      if (!matches.length) return { content: `No matches under ${result.root}.`, display: { detail: "0 matches" } };
      const head = result.truncated
        ? `${result.total} matches under ${result.root}; the first ${matches.length}:`
        : `${plural(matches.length, "match", "matches")} under ${result.root}:`;
      return { content: `${head}\n${matches.map(refLine).join("\n")}`, display: { detail: plural(result.total ?? matches.length, "match", "matches") } };
    }),
});

const outputTool = tool<{ limit?: number; errorsOnly?: boolean }>({
  name: "roblox_output",
  description:
    "Read Roblox Studio's recent output (prints, warnings and errors from scripts, play tests and the command bar), oldest first. " +
    "Check it after changing scripts or running a play test.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "How many recent lines (default 50, max 500)" },
      errorsOnly: { type: "boolean", description: "Only warnings and errors" },
    },
    additionalProperties: false,
  },
  risk: "read",
  mcp: true,
  describe: () => ({ verb: VERB, target: "output" }),
  run: async (args, ctx) => {
    const roblox = ctx.services.roblox;
    const limit = int(args.limit, 50, 1, 500);
    let lines = roblox.output();
    if (args.errorsOnly) lines = lines.filter((l) => l.type === "MessageWarning" || l.type === "MessageError");
    lines = lines.slice(Math.max(0, lines.length - limit));
    if (!lines.length) {
      const status = roblox.status();
      if (!status.connected) return fail(notConnectedMessage(status), "Studio not connected");
      return { content: args.errorsOnly ? "No warnings or errors in Studio's output." : "Studio's output is empty so far.", display: { detail: "empty" } };
    }
    const errors = lines.filter((l) => l.type === "MessageError").length;
    return {
      content: formatOutput(lines),
      display: { detail: `${plural(lines.length, "line")}${errors ? `, ${plural(errors, "error")}` : ""}` },
    };
  },
});

/** The Roblox Studio tools (all offered over MCP too). */
export function robloxTools(): Tool[] {
  return [
    statusTool,
    runLuauTool,
    getTreeTool,
    getPropertiesTool,
    getScriptTool,
    setScriptTool,
    createInstanceTool,
    setPropertiesTool,
    deleteInstanceTool,
    getSelectionTool,
    setSelectionTool,
    findTool,
    outputTool,
  ];
}
