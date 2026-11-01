// Sign-ins that happen over ACP itself (Google Antigravity): lu-minal starts the agent for a moment,
// calls `authenticate` with the method the user picked (the agent opens the browser and waits for
// the sign-in), then opens a session in an empty folder to read the models the account can use.
// The same short session lists the models again later (models.ts caches them for a day).
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { killTree, spawnProgram, withProgramPath } from "../../platform/process.js";
import type { ModelInfo } from "../../providers/models.js";
import { VERSION } from "../../version.js";
import { acpModel } from "./models.js";
import { acpCommandArgs, acpEnv, type AcpAuthMethod, type AcpPreset } from "./presets.js";
import { describeRpcError, RPC_CODES, RpcClosedError, RpcError, RpcPeer } from "./rpc.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** How long the browser sign-in may take. */
export const ACP_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How long starting the agent and opening the probe session may take. */
const SETUP_TIMEOUT_MS = 120_000;

export interface AcpRunOptions {
  /** The agent's program (findAcpProgram). */
  exe: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Starts the process (tests run a fake agent); defaults to spawnProgram. */
  spawnImpl?: (exe: string, args: string[], opts: SpawnOptions) => ChildProcess;
  setupTimeoutMs?: number;
}

/**
 * The models in a session/new answer: its "model" config option (values with names, groups
 * flattened) or the older `models.availableModels`. Empty when it lists none.
 */
export function parseSessionModels(result: unknown, providerId: string): ModelInfo[] {
  const r = isObj(result) ? result : {};
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  const add = (id: string | null, name: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(acpModel(providerId, id, { name: name ?? id, reasoning: true }));
  };
  if (Array.isArray(r.configOptions)) {
    const option = r.configOptions.find((o): o is Obj => isObj(o) && (o.category === "model" || o.id === "model") && (o.type === undefined || o.type === "select"));
    const collect = (list: unknown) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        if (!isObj(item)) continue;
        if (typeof item.value === "string") add(str(item.value), str(item.name));
        else if (Array.isArray(item.options)) collect(item.options);
      }
    };
    if (option) collect(option.options);
  }
  if (!out.length && isObj(r.models) && Array.isArray(r.models.availableModels)) {
    for (const m of r.models.availableModels) if (isObj(m)) add(str(m.modelId) ?? str(m.id), str(m.name));
  }
  return out;
}

/**
 * Starts the agent, says hello and hands the connection to `work`; the process (and its children)
 * ends afterwards, however `work` ends.
 */
async function withAgent<T>(
  preset: AcpPreset,
  opts: AcpRunOptions,
  work: (rpc: RpcPeer, authMethods: AcpAuthMethod[], env: NodeJS.ProcessEnv, folder: string) => Promise<T>,
): Promise<T> {
  const env = withProgramPath(acpEnv(preset, opts.env ?? process.env), opts.exe);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-acp-"));
  const child = (opts.spawnImpl ?? spawnProgram)(opts.exe, acpCommandArgs(preset, null, { env }), {
    cwd: folder,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  // The folder goes once the process is gone (Windows won't remove a running process's folder).
  const gone = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  const rpc = new RpcPeer({
    input: child.stdout!,
    output: child.stdin!,
    closeOnEnd: false,
    // Nothing runs in these sessions: every question of the agent's is refused.
    onRequest: () => {
      throw new RpcError(RPC_CODES.methodNotFound, "lu-minal only signs in here.");
    },
  });
  const lastLog = () => stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  child.on("exit", (code) => rpc.close(new RpcClosedError(`${preset.name} stopped (exit code ${code ?? "?"})${lastLog() ? `: ${lastLog().slice(0, 200)}` : "."}`)));
  child.on("error", (err) => rpc.close(new RpcClosedError(`${preset.name} couldn't start: ${err.message}`)));
  const onAbort = () => rpc.close(new RpcClosedError("Cancelled."));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const init = await rpc.request<unknown>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "lu-minal", title: "lu-minal", version: VERSION },
      },
      { timeoutMs: opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS },
    );
    const r = isObj(init) ? init : {};
    const methods: AcpAuthMethod[] = Array.isArray(r.authMethods)
      ? r.authMethods.filter((m): m is Obj => isObj(m) && typeof m.id === "string").map((m) => ({ id: m.id as string, name: str(m.name) ?? (m.id as string) }))
      : [];
    return await work(rpc, methods, env, folder);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    rpc.close(new RpcClosedError("Done."));
    killTree(child);
    const removeFolder = () => fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }, () => undefined);
    const late = setTimeout(removeFolder, 10_000);
    late.unref?.();
    void gone.then(() => {
      clearTimeout(late);
      removeFolder();
    });
  }
}

/** Opens a session in the empty folder and reads its models (signing in first when the agent asks and can be). */
async function probeModels(preset: AcpPreset, rpc: RpcPeer, methods: AcpAuthMethod[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<ModelInfo[]> {
  const open = () => rpc.request<unknown>("session/new", { cwd, mcpServers: [] }, { timeoutMs });
  let result: unknown;
  try {
    result = await open();
  } catch (err) {
    if (!(err instanceof RpcError) || err.code !== RPC_CODES.authRequired) throw err;
    const methodId = preset.autoAuth?.(methods, env) ?? null;
    if (!methodId) throw err;
    await rpc.request("authenticate", { methodId }, { timeoutMs });
    result = await open();
  }
  return parseSessionModels(result, preset.id);
}

/**
 * Signs in with `methodId` (Antigravity: the agent opens the browser; this waits up to 10
 * minutes), then reads the account's models. Rejects with a sentence for the user.
 */
export async function signInAcp(preset: AcpPreset, opts: AcpRunOptions & { methodId: string; signInTimeoutMs?: number }): Promise<ModelInfo[]> {
  return withAgent(preset, opts, async (rpc, methods, env, folder) => {
    if (methods.length && !methods.some((m) => m.id === opts.methodId)) {
      throw new Error(`${preset.name} doesn't offer "${opts.methodId}" any more (it offers ${methods.map((m) => m.name).join(", ")}).`);
    }
    try {
      await rpc.request("authenticate", { methodId: opts.methodId }, { timeoutMs: opts.signInTimeoutMs ?? ACP_SIGN_IN_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof RpcClosedError) throw err;
      throw new Error(`${preset.name}: ${describeRpcError(err)}`);
    }
    // The sign-in counts even when the model list can't be read.
    return probeModels(preset, rpc, methods, env, folder, opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS).catch(() => []);
  });
}

/** The models the signed-in agent offers (an empty list when it can't say). Rejects when it can't start or sign in. */
export async function probeAcpModels(preset: AcpPreset, opts: AcpRunOptions): Promise<ModelInfo[]> {
  return withAgent(preset, opts, (rpc, methods, env, folder) => probeModels(preset, rpc, methods, env, folder, opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS));
}
