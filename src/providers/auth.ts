// Sign-ins for API providers: auth.json in the config dir ({ [providerId]: entry }), written
// atomically and readable only by the user on macOS / Linux. Keys can also come from the
// environment variables the catalog names (OPENROUTER_API_KEY, MINIMAX_API_KEY, ...).
import fs from "node:fs";
import path from "node:path";
import { configDir, isWindows } from "../platform/paths.js";

/** One stored sign-in. */
export type AuthEntry =
  /** A key pasted from the provider's console. */
  | { type: "api"; key: string }
  /** A key a browser sign-in created (OpenRouter's PKCE flow). */
  | { type: "oauth"; key: string; createdAt: number; meta?: Record<string, string> }
  /** A personal access token (GitHub, Forgejo, ...). */
  | { type: "token"; token: string; user?: string | null };

/** The auth file in a config dir. */
export function authFile(dir = configDir()): string {
  return path.join(dir, "auth.json");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** The entry if `raw` is a well-formed one, else null. */
function validEntry(raw: unknown): AuthEntry | null {
  if (!isObject(raw)) return null;
  if (raw.type === "api" && typeof raw.key === "string" && raw.key) return { type: "api", key: raw.key };
  if (raw.type === "oauth" && typeof raw.key === "string" && raw.key) {
    const entry: AuthEntry = {
      type: "oauth",
      key: raw.key,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    };
    if (isObject(raw.meta)) {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.meta)) if (typeof v === "string") meta[k] = v;
      entry.meta = meta;
    }
    return entry;
  }
  if (raw.type === "token" && typeof raw.token === "string" && raw.token) {
    const entry: AuthEntry = { type: "token", token: raw.token };
    if (typeof raw.user === "string" || raw.user === null) entry.user = raw.user;
    return entry;
  }
  return null;
}

interface FileState {
  /** Everything in the file, including entries this version doesn't understand (kept on write). */
  data: Record<string, unknown>;
  /** The file exists but couldn't be read or parsed. */
  broken: boolean;
}

/**
 * The auth file. Every call reads the file again, so a sign-in from another lu-minal process (or
 * `lu-minal login` in another terminal) is seen at once. A file that can't be parsed reads as
 * empty, and is copied to `auth.json.bak` (or a timestamped .bak) before anything overwrites it.
 */
export class AuthStore {
  constructor(readonly file: string) {}

  /** The store in lu-minal's config dir. */
  static default(): AuthStore {
    return new AuthStore(authFile());
  }

  private read(): FileState {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { data: {}, broken: code !== "ENOENT" && code !== "ENOTDIR" };
    }
    if (!text.trim()) return { data: {}, broken: false };
    try {
      const parsed = JSON.parse(text) as unknown;
      return isObject(parsed) ? { data: parsed, broken: false } : { data: {}, broken: true };
    } catch {
      return { data: {}, broken: true };
    }
  }

  private backup(): void {
    try {
      let target = `${this.file}.bak`;
      if (fs.existsSync(target)) target = `${this.file}.${Date.now()}.bak`;
      fs.copyFileSync(this.file, target);
      if (!isWindows) fs.chmodSync(target, 0o600);
    } catch {
      // If even a copy fails the file is unreadable; writing a new one is all we can do.
    }
  }

  private write(data: Record<string, unknown>): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Windows refuses to replace a file that another process (an editor, a virus scanner) holds.
      fs.rmSync(tmp, { force: true });
      if (!isWindows) throw err;
      fs.writeFileSync(this.file, text);
    }
    if (!isWindows) fs.chmodSync(this.file, 0o600);
  }

  private update(change: (data: Record<string, unknown>) => void): void {
    const state = this.read();
    if (state.broken) this.backup();
    change(state.data);
    this.write(state.data);
  }

  /** The sign-in for a provider, or null. */
  get(id: string): AuthEntry | null {
    const data = this.read().data;
    return Object.hasOwn(data, id) ? validEntry(data[id]) : null;
  }

  set(id: string, entry: AuthEntry): void {
    const valid = validEntry(entry);
    if (!valid) throw new Error(`Not a valid sign-in for ${id}.`);
    this.update((data) => {
      data[id] = valid;
    });
  }

  remove(id: string): void {
    const state = this.read();
    if (!state.broken && !Object.hasOwn(state.data, id)) return;
    this.update((data) => {
      delete data[id];
    });
  }

  /** Ids with a usable entry, sorted. */
  ids(): string[] {
    const data = this.read().data;
    return Object.keys(data)
      .filter((id) => validEntry(data[id]) !== null)
      .sort();
  }

  /** The key or token stored for a provider, or null. */
  secretFor(id: string): string | null {
    const entry = this.get(id);
    if (!entry) return null;
    return entry.type === "token" ? entry.token : entry.key;
  }
}

/**
 * An environment variable's trimmed value, or null when unset or blank. On Windows names are
 * case-insensitive, also for a plain copy of `process.env`.
 */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  let value = env[name];
  if (value === undefined && isWindows) {
    const upper = name.toUpperCase();
    const match = Object.keys(env).find((k) => k.toUpperCase() === upper);
    if (match) value = env[match];
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The key for a provider: a stored sign-in wins, then the first of `env` that is set (values are
 * trimmed; blank ones don't count). Null when there is none.
 */
export function keyFor(
  providerId: string,
  env: string[],
  auth: AuthStore,
  processEnv: NodeJS.ProcessEnv = process.env,
): { key: string; source: "auth" | "env" } | null {
  const stored = auth.secretFor(providerId)?.trim();
  if (stored) return { key: stored, source: "auth" };
  for (const name of env) {
    const value = readEnv(processEnv, name);
    if (value) return { key: value, source: "env" };
  }
  return null;
}
