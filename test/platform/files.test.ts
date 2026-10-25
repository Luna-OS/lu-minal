// Atomic whole-file writes: temp file + rename, retried while Windows holds the target open.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicSync, type AtomicFs } from "../../src/platform/files.js";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-files-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function busy(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

/** The real fs, with a rename that fails `failures` times with `code` (a virus scanner's grip). */
function flakyFs(failures: number, code = "EPERM"): AtomicFs & { renames: number; chmods: number } {
  const io = {
    renames: 0,
    chmods: 0,
    writeFileSync: (file: string, data: string | Uint8Array, options?: { mode?: number }) => fs.writeFileSync(file, data, options),
    renameSync(from: string, to: string) {
      io.renames++;
      if (io.renames <= failures) throw busy(code);
      fs.renameSync(from, to);
    },
    rmSync: (file: string, options: { force: boolean }) => fs.rmSync(file, options),
    chmodSync(file: string, mode: number) {
      io.chmods++;
      fs.chmodSync(file, mode);
    },
  };
  return io;
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeFileAtomicSync", () => {
  it("replaces an existing file and leaves no temp file", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "plain-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "old");
    writeFileAtomicSync(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(leftovers(dir)).toEqual([]);
  });

  it("retries a rename Windows refuses for a moment", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "retry-"));
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, "old");
    const io = flakyFs(3, "EBUSY");
    writeFileAtomicSync(file, "new", { platform: "win32", fs: io, retryDelaysMs: [0, 0, 0, 0] });
    expect(io.renames).toBe(4);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(leftovers(dir)).toEqual([]);
  });

  it("writes in place on Windows when the file stays held", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "inplace-"));
    const file = path.join(dir, "session.json");
    fs.writeFileSync(file, "old");
    const io = flakyFs(100);
    writeFileAtomicSync(file, "new", { platform: "win32", fs: io, retryDelaysMs: [0, 0] });
    expect(io.renames).toBe(3);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(leftovers(dir)).toEqual([]);
  });

  it("does not retry or fall back on macOS / Linux, and cleans up", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "posix-"));
    const file = path.join(dir, "x.json");
    fs.writeFileSync(file, "old");
    const io = flakyFs(1);
    expect(() => writeFileAtomicSync(file, "new", { platform: "linux", fs: io })).toThrow(/EPERM/);
    expect(io.renames).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(leftovers(dir)).toEqual([]);
  });

  it("does not paper over other errors on Windows", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "enoent-"));
    const io = flakyFs(1, "EXDEV");
    expect(() => writeFileAtomicSync(path.join(dir, "y.json"), "new", { platform: "win32", fs: io, retryDelaysMs: [0] })).toThrow(/EXDEV/);
    expect(io.renames).toBe(1);
    expect(leftovers(dir)).toEqual([]);
  });

  it("sets the mode on POSIX only", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "mode-"));
    const posix = flakyFs(0);
    writeFileAtomicSync(path.join(dir, "a.json"), "{}", { mode: 0o600, platform: "linux", fs: posix });
    expect(posix.chmods).toBe(1);
    const windows = flakyFs(0);
    writeFileAtomicSync(path.join(dir, "b.json"), "{}", { mode: 0o600, platform: "win32", fs: windows });
    expect(windows.chmods).toBe(0);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "a.json")).mode & 0o777).toBe(0o600);
  });

  it("throws, without a temp file, when the folder is missing", () => {
    expect(() => writeFileAtomicSync(path.join(tmp, "no-such-dir", "z.json"), "x")).toThrow();
  });
});

describe("writeFileAtomic", () => {
  it("replaces a file with the real fs", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "async-"));
    const file = path.join(dir, "theme.json");
    fs.writeFileSync(file, "old");
    await writeFileAtomic(file, "new", { mode: 0o644 });
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(leftovers(dir)).toEqual([]);
  });

  it("retries, then writes in place on Windows", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "async-win-"));
    const file = path.join(dir, "lu-minal.json");
    fs.writeFileSync(file, "old");
    const flaky = flakyFs(2, "EACCES");
    await writeFileAtomic(file, "retried", { platform: "win32", fs: flaky, retryDelaysMs: [0, 0, 0] });
    expect(flaky.renames).toBe(3);
    expect(fs.readFileSync(file, "utf8")).toBe("retried");
    const held = flakyFs(100);
    await writeFileAtomic(file, "in place", { platform: "win32", fs: held, retryDelaysMs: [0] });
    expect(fs.readFileSync(file, "utf8")).toBe("in place");
    expect(leftovers(dir)).toEqual([]);
  });

  it("rejects on macOS / Linux when the rename fails", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "async-posix-"));
    await expect(writeFileAtomic(path.join(dir, "a"), "x", { platform: "darwin", fs: flakyFs(1) })).rejects.toThrow(/EPERM/);
    expect(leftovers(dir)).toEqual([]);
  });
});
