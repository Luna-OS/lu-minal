// ACP agents that ship as prebuilt binaries in the public ACP registry (Google Antigravity's ACP
// server first): looks the agent up, downloads its archive for this platform, checks the sha256
// before unpacking, and installs it under <root>/<agentId>/<version>/. The manifest
// (<root>/<agentId>/installed.json) is written last, so a half-installed version is never used.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "../../providers/types.js";
import { writeFileAtomicSync } from "../../platform/files.js";
import { stateDir } from "../../platform/paths.js";
import { runProgram } from "../../platform/process.js";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const MANIFEST = "installed.json";
/** Names that are safe as a folder name (agent ids, versions). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** Temp folders and downloads another process left behind are removed after this long. */
const STALE_MS = 60 * 60_000;

/** The registry's platform key ("windows-x86_64", "darwin-aarch64", ...), or null when it has none. */
export function registryPlatform(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

export interface AcpBinary {
  version: string;
  archive: string;
  cmd: string;
  args: string[];
  sha256: string;
}

export interface InstalledAcp {
  /** Absolute path of the agent's executable. */
  exe: string;
  args: string[];
  version: string;
}

/** Where downloaded ACP agents live. */
export function acpAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), "acp-agents");
}

interface RegistryOptions {
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  arch?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The registry entry's binary for this platform, and the agent's display name. */
async function lookUp(agentId: string, opts: RegistryOptions): Promise<{ name: string; binary: AcpBinary }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  let res: Response;
  try {
    res = await fetchImpl(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(`Couldn't reach the ACP registry (${(err as Error).message}).`);
  }
  if (!res.ok) throw new Error(`The ACP registry answered HTTP ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("The ACP registry's answer isn't valid JSON.");
  }
  const agents = isRecord(body) && Array.isArray(body.agents) ? body.agents : null;
  if (!agents) throw new Error("The ACP registry's answer has no agent list.");
  const entry = agents.find((a): a is Record<string, unknown> => isRecord(a) && a.id === agentId);
  if (!entry) throw new Error(`The ACP registry has no agent "${agentId}".`);
  const name = typeof entry.name === "string" && entry.name ? entry.name : agentId;
  const dist = isRecord(entry.distribution) ? entry.distribution : {};
  if (!isRecord(dist.binary)) {
    const kinds = Object.keys(dist);
    throw new Error(`${name} isn't distributed as a binary${kinds.length ? ` (it uses ${kinds.join(", ")})` : ""}, so lu-minal can't download it.`);
  }
  const key = registryPlatform(platform, arch);
  const build = key ? dist.binary[key] : undefined;
  if (!isRecord(build)) throw new Error(`${name} has no build for this platform (${key ?? `${platform}-${arch}`}).`);
  const version = typeof entry.version === "string" ? entry.version : "";
  const { archive, cmd, sha256 } = build;
  const args = build.args ?? [];
  if (
    !SAFE_NAME.test(version) ||
    typeof archive !== "string" ||
    !/^https:\/\//i.test(archive) ||
    typeof cmd !== "string" ||
    !cmd ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(sha256) ||
    !Array.isArray(args) ||
    !args.every((a) => typeof a === "string")
  ) {
    throw new Error(`The ACP registry's entry for ${name} is incomplete or invalid.`);
  }
  return { name, binary: { version, archive, cmd, args: args as string[], sha256: sha256.toLowerCase() } };
}

/** Looks `agentId` up in the ACP registry and returns its binary for this platform. */
export async function fetchRegistryBinary(agentId: string, opts: RegistryOptions = {}): Promise<AcpBinary> {
  return (await lookUp(agentId, opts)).binary;
}

/** `cmd` ("./agy_acp_server.exe") as a path inside `dir`; null when it would leave it. */
function resolveCmd(dir: string, cmd: string): string | null {
  if (path.posix.isAbsolute(cmd) || path.win32.isAbsolute(cmd)) return null;
  const parts = cmd.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  const full = path.resolve(dir, ...parts);
  const rel = path.relative(dir, full);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? full : null;
}

function checkAgentId(agentId: string): void {
  if (!SAFE_NAME.test(agentId)) throw new Error(`"${agentId}" isn't a valid ACP agent id.`);
}

/** The installed version of `agentId` under `root`, or null (no manifest, or its exe is gone). */
export function installedAcp(agentId: string, root: string): InstalledAcp | null {
  if (!SAFE_NAME.test(agentId)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, agentId, MANIFEST), "utf8")) as unknown;
    if (!isRecord(raw) || typeof raw.version !== "string" || typeof raw.exe !== "string") return null;
    const args = Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string") ? (raw.args as string[]) : [];
    const exe = resolveCmd(path.resolve(root), raw.exe);
    if (!exe || !fs.statSync(exe).isFile()) return null;
    return { exe, args, version: raw.version };
  } catch {
    return null;
  }
}

export interface InstallOptions extends RegistryOptions {
  onStatus?: (line: string) => void;
  /** Runs an unpacker and resolves its exit code; tests replace it. */
  run?: (exe: string, args: string[]) => Promise<number>;
}

const runQuiet = async (exe: string, args: string[]): Promise<number> => (await runProgram(exe, args, { timeoutMs: 10 * 60_000 })).code ?? -1;

/** Downloads `url` into `dest` while hashing it; nothing is left behind when the hash differs. */
async function download(url: string, dest: string, sha256: string, label: string, fetchImpl: FetchLike, onStatus?: (line: string) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(30 * 60_000) });
  } catch (err) {
    throw new Error(`Couldn't download ${label} (${(err as Error).message}).`);
  }
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${label} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = await fsp.open(dest, "w");
  let done = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      await out.write(chunk);
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : -1;
      if (pct >= 0 && pct >= shown + 10) {
        shown = pct - (pct % 10);
        onStatus?.(`Downloading ${label}: ${shown}%`);
      }
    }
  } catch (err) {
    await out.close().catch(() => undefined);
    await fsp.rm(dest, { force: true });
    throw new Error(`Couldn't download ${label} (${(err as Error).message}).`);
  }
  await out.close();
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    await fsp.rm(dest, { force: true });
    throw new Error(`The download of ${label} doesn't match its checksum (got ${actual.slice(0, 12)}..., expected ${sha256.slice(0, 12)}...): not installed.`);
  }
}

/** The program and arguments that unpack `archive` into `dir`. */
function unpackCommand(archive: string, dir: string, platform: NodeJS.Platform): { exe: string; args: string[] } {
  const zip = !/\.(tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(archive);
  if (platform === "win32") {
    // Windows 10/11's bsdtar reads zip files too.
    const tar = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    return { exe: tar, args: ["-xf", archive, "-C", dir] };
  }
  if (!zip) return { exe: "tar", args: ["-xf", archive, "-C", dir] };
  if (platform === "darwin") return { exe: "/usr/bin/ditto", args: ["-x", "-k", archive, dir] };
  return { exe: "unzip", args: ["-q", "-o", archive, "-d", dir] };
}

/** Removes what isn't `keep` from the agent's folder: older versions, stale temp files. Best effort. */
function cleanUp(agentDir: string, keep: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(agentDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep || name === MANIFEST) continue;
    const full = path.join(agentDir, name);
    try {
      // Another process may be installing right now: leave its fresh temp files alone.
      if (name.startsWith(".") && Date.now() - fs.statSync(full).mtimeMs < STALE_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // A running exe on Windows can't be deleted: next time.
    }
  }
}

const pending = new Map<string, Promise<InstalledAcp>>();

/**
 * Installs the registry's newest version of `agentId` under `root` (nothing is downloaded when it
 * is already installed) and resolves where its executable is. Throws with a sentence for the user.
 * Concurrent calls for the same agent share one install.
 */
export function installAcp(agentId: string, root: string, opts: InstallOptions = {}): Promise<InstalledAcp> {
  const key = `${path.resolve(root)}\0${agentId}`;
  const running = pending.get(key);
  if (running) return running;
  const job = install(agentId, path.resolve(root), opts).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function install(agentId: string, root: string, opts: InstallOptions): Promise<InstalledAcp> {
  checkAgentId(agentId);
  const platform = opts.platform ?? process.platform;
  const { name, binary } = await lookUp(agentId, opts);
  const current = installedAcp(agentId, root);
  if (current && current.version === binary.version) return current;

  const agentDir = path.join(root, agentId);
  // Checked before the download, so a bad entry costs no 100 MB.
  if (!resolveCmd(path.join(agentDir, binary.version), binary.cmd)) {
    throw new Error(`The ACP registry's command for ${name} (${binary.cmd}) points outside its folder: not installed.`);
  }
  await fsp.mkdir(agentDir, { recursive: true });
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const ext = /\.(tar\.gz|tar\.xz|tar\.bz2|tgz|tar|zip)$/i.exec(new URL(binary.archive).pathname)?.[0] ?? ".zip";
  const archive = path.join(agentDir, `.download-${tag}${ext}`);
  const temp = path.join(agentDir, `.unpack-${tag}`);
  const label = `${name} ${binary.version}`;
  try {
    opts.onStatus?.(`Downloading ${label}...`);
    await download(binary.archive, archive, binary.sha256, label, opts.fetchImpl ?? fetch, opts.onStatus);

    opts.onStatus?.(`Unpacking ${label}...`);
    await fsp.mkdir(temp, { recursive: true });
    const unpack = unpackCommand(archive, temp, platform);
    const tool = path.basename(unpack.exe).replace(/\.exe$/i, "");
    let code: number;
    try {
      code = await (opts.run ?? runQuiet)(unpack.exe, unpack.args);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Couldn't unpack ${label}: \`${tool}\` isn't installed${tool === "unzip" ? " (install the unzip package)" : ""}.`);
      }
      throw new Error(`Couldn't unpack ${label} (${(err as Error).message}).`);
    }
    if (code !== 0) throw new Error(`Couldn't unpack ${label} (${tool} exit ${code}).`);
    const unpackedExe = resolveCmd(temp, binary.cmd);
    if (!unpackedExe || !fs.existsSync(unpackedExe)) throw new Error(`The download of ${label} has no ${binary.cmd} in it.`);
    if (platform !== "win32") await fsp.chmod(unpackedExe, 0o755);

    // Into place with one rename. A leftover folder of the same version (no manifest points at it)
    // goes first; when it can't (an exe in it still runs), a fresh name is used instead.
    let versionName = binary.version;
    let target = path.join(agentDir, versionName);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        versionName = `${binary.version}-${tag}`;
        target = path.join(agentDir, versionName);
      }
    }
    await fsp.rename(temp, target);

    const exe = resolveCmd(target, binary.cmd) as string;
    const relExe = path.relative(root, exe).split(path.sep).join("/");
    writeFileAtomicSync(path.join(agentDir, MANIFEST), `${JSON.stringify({ version: binary.version, exe: relExe, args: binary.args }, null, 2)}\n`);
    cleanUp(agentDir, versionName);
    opts.onStatus?.(`Installed ${label}.`);
    return { exe, args: binary.args, version: binary.version };
  } catch (err) {
    await fsp.rm(archive, { force: true }).catch(() => undefined);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    // The agent's folder goes too when this was its first install (rmdir only takes empty ones).
    await fsp.rmdir(agentDir).catch(() => undefined);
    throw err;
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => undefined);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}
