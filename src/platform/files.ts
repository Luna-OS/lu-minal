// Replacing a file's whole content so that readers never see half of it, on Windows too.
//
// The usual way is a temp file next to the target and a rename over it. POSIX renames atomically
// even while others read the old file. Windows refuses (EPERM / EACCES / EBUSY) while another
// process holds the file open without delete sharing, which virus scanners, the search indexer,
// backup tools and editors do for a moment after every write. So on Windows the rename is retried
// for a short while and, if it still fails, the content is written in place. File modes only exist
// on POSIX; Windows keeps the folder's ACL (the user's own profile).
import { randomBytes } from "node:crypto";
import fs from "node:fs";

/** The fs functions the writers use (tests pass a wrapper that fails on purpose). */
export interface AtomicFs {
  writeFileSync(file: string, data: string | Uint8Array, options?: { mode?: number }): void;
  renameSync(from: string, to: string): void;
  rmSync(file: string, options: { force: boolean }): void;
  chmodSync(file: string, mode: number): void;
}

export interface AtomicWriteOptions {
  /** POSIX permission bits (e.g. 0o600 for secrets); ignored on Windows. */
  mode?: number;
  /** The platform whose rules apply (tests). */
  platform?: NodeJS.Platform;
  /** For tests. */
  fs?: AtomicFs;
  /** Waits between rename attempts on Windows, in ms (tests pass zeros). */
  retryDelaysMs?: number[];
}

/** The errors Windows gives while another process briefly holds the target open. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** About 0.6 s in all for the synchronous writer (it blocks the event loop meanwhile). */
const SYNC_DELAYS = [5, 10, 20, 40, 80, 160, 300];
/** About 2.5 s in all for the asynchronous one. */
const ASYNC_DELAYS = [10, 20, 40, 80, 160, 320, 640, 1200];

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function tempName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const nodeFs: AtomicFs = {
  writeFileSync: (file, data, options) => fs.writeFileSync(file, data, options),
  renameSync: (from, to) => fs.renameSync(from, to),
  rmSync: (file, options) => fs.rmSync(file, options),
  chmodSync: (file, mode) => fs.chmodSync(file, mode),
};

/**
 * Writes `data` to `file` through a temp file and a rename (the folder must exist). Throws when the
 * file can't be written at all.
 */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  const io = opts.fs ?? nodeFs;
  const windows = platform === "win32";
  const tmp = tempName(file);
  try {
    io.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
  } catch (err) {
    removeQuietly(io, tmp);
    throw err;
  }
  const delays = opts.retryDelaysMs ?? SYNC_DELAYS;
  let lastError: unknown = null;
  for (let attempt = 0; ; attempt++) {
    try {
      io.renameSync(tmp, file);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (!windows || !BUSY_CODES.has(errCode(err) ?? "") || attempt >= delays.length) break;
      sleepSync(delays[attempt]);
    }
  }
  if (lastError) {
    removeQuietly(io, tmp);
    if (!windows || !BUSY_CODES.has(errCode(lastError) ?? "")) throw lastError;
    // Still held: replace the content in place (the open handle allows writing, not deleting).
    io.writeFileSync(file, data);
  }
  if (opts.mode !== undefined && !windows) {
    try {
      io.chmodSync(file, opts.mode);
    } catch {
      // A file system without POSIX modes (a FAT stick, some network shares).
    }
  }
}

/** The asynchronous `writeFileAtomicSync` (waits without blocking between Windows retries). */
export async function writeFileAtomic(file: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  const io = opts.fs;
  const write = (f: string, d: string | Uint8Array, o?: { mode?: number }) =>
    io ? Promise.resolve().then(() => io.writeFileSync(f, d, o)) : fs.promises.writeFile(f, d, o);
  const rename = (a: string, b: string) => (io ? Promise.resolve().then(() => io.renameSync(a, b)) : fs.promises.rename(a, b));
  const remove = (f: string) =>
    (io ? Promise.resolve().then(() => io.rmSync(f, { force: true })) : fs.promises.rm(f, { force: true })).catch(() => undefined);
  const chmod = (f: string, mode: number) => (io ? Promise.resolve().then(() => io.chmodSync(f, mode)) : fs.promises.chmod(f, mode));

  const tmp = tempName(file);
  try {
    await write(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
  } catch (err) {
    await remove(tmp);
    throw err;
  }
  const delays = opts.retryDelaysMs ?? ASYNC_DELAYS;
  let lastError: unknown = null;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (!windows || !BUSY_CODES.has(errCode(err) ?? "") || attempt >= delays.length) break;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  if (lastError) {
    await remove(tmp);
    if (!windows || !BUSY_CODES.has(errCode(lastError) ?? "")) throw lastError;
    await write(file, data);
  }
  if (opts.mode !== undefined && !windows) await chmod(file, opts.mode).catch(() => undefined);
}

function removeQuietly(io: AtomicFs, file: string): void {
  try {
    io.rmSync(file, { force: true });
  } catch {
    // never there, or already gone
  }
}
