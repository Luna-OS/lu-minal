// Finding and running programs: findProgram, cmdQuote, spawnProgram / runProgram, killTree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cmdQuote, findProgram, killTree, runProgram, spawnProgram } from "../../src/platform/process.js";

const isWindows = process.platform === "win32";
const node = process.execPath;
let tmp: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-proc-")));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Creates a program called `name` in `dir`: a .cmd shim on Windows, an executable script elsewhere. */
function makeProgram(dir: string, name: string, mode = 0o755): string {
  fs.mkdirSync(dir, { recursive: true });
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, "@echo off\r\necho hi\r\n");
    return file;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\necho hi\n");
  fs.chmodSync(file, mode);
  return file;
}

describe("findProgram", () => {
  it("finds a program in a PATH directory", () => {
    const bin = path.join(tmp, "bin1");
    const file = makeProgram(bin, "moon-tool");
    const env = { PATH: [path.join(tmp, "missing"), bin].join(path.delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(findProgram("moon-tool", { env })).toBe(file);
  });

  it("takes the first PATH entry that has it", () => {
    const a = path.join(tmp, "first");
    const b = path.join(tmp, "second");
    const inA = makeProgram(a, "twice");
    makeProgram(b, "twice");
    expect(findProgram("twice", { env: { PATH: [a, b].join(path.delimiter), PATHEXT: ".CMD" } })).toBe(inA);
  });

  it("reads Path as well as PATH (Windows spells it Path)", () => {
    const bin = path.join(tmp, "bin-path-case");
    const file = makeProgram(bin, "spelled");
    expect(findProgram("spelled", { env: { Path: bin, PATHEXT: ".CMD" } })).toBe(file);
  });

  it("returns null when it is nowhere", () => {
    expect(findProgram("lu-minal-surely-not-installed", { env: { PATH: tmp, PATHEXT: ".EXE" } })).toBeNull();
    expect(findProgram("anything", { env: {} })).toBeNull();
  });

  it("ignores directories with the program's name", () => {
    const bin = path.join(tmp, "bin-dir");
    fs.mkdirSync(path.join(bin, isWindows ? "folder.cmd" : "folder"), { recursive: true });
    expect(findProgram("folder", { env: { PATH: bin, PATHEXT: ".CMD" } })).toBeNull();
  });

  it.skipIf(isWindows)("ignores files that are not executable", () => {
    const bin = path.join(tmp, "bin-noexec");
    makeProgram(bin, "plain", 0o644);
    expect(findProgram("plain", { env: { PATH: bin } })).toBeNull();
  });

  it.runIf(isWindows)("tries every PATHEXT extension, in order", () => {
    const bin = path.join(tmp, "bin-ext");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "both.bat"), "@echo bat\r\n");
    fs.writeFileSync(path.join(bin, "both.cmd"), "@echo cmd\r\n");
    expect(findProgram("both", { env: { PATH: bin, PATHEXT: ".CMD;.BAT" } })).toBe(path.join(bin, "both.cmd"));
    expect(findProgram("both", { env: { PATH: bin, PATHEXT: ".BAT;.CMD" } })).toBe(path.join(bin, "both.bat"));
    // A name with an extension is taken as it is.
    expect(findProgram("both.bat", { env: { PATH: bin, PATHEXT: ".CMD" } })).toBe(path.join(bin, "both.bat"));
  });

  it("prefers a configured path, then PATH, then the extra places", () => {
    const configured = makeProgram(path.join(tmp, "configured"), "claude-x");
    const onPath = makeProgram(path.join(tmp, "onpath"), "claude-x");
    const extra = makeProgram(path.join(tmp, "extra"), "claude-x");
    const env = { PATH: path.dirname(onPath), PATHEXT: ".CMD" };
    expect(findProgram("claude-x", { configured, env, extra: [extra] })).toBe(configured);
    expect(findProgram("claude-x", { configured: path.join(tmp, "nope"), env, extra: [extra] })).toBe(onPath);
    expect(findProgram("claude-x", { configured: null, env: { PATH: "" }, extra: [path.join(tmp, "nope"), extra] })).toBe(extra);
  });
});

describe("cmdQuote", () => {
  it("leaves plain words, paths and flags alone", () => {
    for (const word of ["claude", "C:\\Users\\Ada\\bin\\claude.cmd", "--model=opus", "a/b@c+d,e:f", "x.y-z_1"]) {
      expect(cmdQuote(word), word).toBe(word);
    }
  });

  it("quotes spaces and cmd's special characters", () => {
    expect(cmdQuote("hello world")).toBe('"hello world"');
    expect(cmdQuote("a&b")).toBe('"a&b"');
    expect(cmdQuote("a|b")).toBe('"a|b"');
    expect(cmdQuote("<in>")).toBe('"<in>"');
    expect(cmdQuote("a^b")).toBe('"a^b"');
    expect(cmdQuote("(x)")).toBe('"(x)"');
  });

  it("doubles quotes and percent signs inside the quotes", () => {
    expect(cmdQuote('say "hi"')).toBe('"say ""hi"""');
    // "%%" is not collapsed outside batch files, so percent signs are passed as they are.
    expect(cmdQuote("100%")).toBe('"100%"');
  });

  it("quotes the empty string so it stays an argument", () => {
    expect(cmdQuote("")).toBe('""');
  });
});

describe("runProgram", () => {
  it("collects stdout, stderr and the exit code", async () => {
    const r = await runProgram(node, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "err", timedOut: false });
  });

  it("passes arguments through untouched", async () => {
    const args = ["two words", 'a "quoted" one', "", "café ☾ ✦", "C:\\path\\with\\"];
    const r = await runProgram(node, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]);
    expect(JSON.parse(r.stdout)).toEqual(args);
  });

  it("writes `input` to stdin and closes it", async () => {
    const script = "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.toUpperCase()))";
    expect((await runProgram(node, ["-e", script], { input: "night sky\nline two\n" })).stdout).toBe("NIGHT SKY\nLINE TWO\n");
    // Without input stdin is closed right away, so a reader does not hang.
    expect((await runProgram(node, ["-e", script], { timeoutMs: 10_000 })).stdout).toBe("");
  });

  it("runs in the given folder with the given environment", async () => {
    const r = await runProgram(node, ["-e", "process.stdout.write(JSON.stringify([process.cwd(), process.env.LU_MINAL_TEST_VAR]))"], {
      cwd: tmp,
      env: { ...process.env, LU_MINAL_TEST_VAR: "moon" },
    });
    const [cwd, value] = JSON.parse(r.stdout) as [string, string];
    expect(fs.realpathSync(cwd)).toBe(tmp);
    expect(value).toBe("moon");
  });

  it("runs in the home folder by default", async () => {
    const r = await runProgram(node, ["-e", "process.stdout.write(process.cwd())"]);
    expect(fs.realpathSync(r.stdout)).toBe(fs.realpathSync(os.homedir()));
  });

  it("stops a program that runs past the timeout", async () => {
    const started = Date.now();
    const r = await runProgram(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("stops a program when the signal aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const r = await runProgram(node, ["-e", "setInterval(() => {}, 1000)"], { signal: ac.signal });
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("stops collecting output after maxOutput", async () => {
    const script = "const s='x'.repeat(1000); for (let i = 0; i < 200; i++) process.stdout.write(s);";
    const r = await runProgram(node, ["-e", script], { maxOutput: 5000 });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThanOrEqual(5000);
    expect(r.stdout.length).toBeLessThan(200_000);
  });

  it("rejects when the program does not exist", async () => {
    await expect(runProgram(path.join(tmp, "no-such-program"), [])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(isWindows)("runs a .cmd shim through cmd.exe with arguments intact", async () => {
    const shim = path.join(tmp, "print args.cmd");
    fs.writeFileSync(shim, `@"${node}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    const args = ["plain", "two words", "x&y", "a^b", "(paren)"];
    const r = await runProgram(shim, args);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
  });

  // runProgram starts its child in its own process group, so the timeout's killTree reaches the
  // grandchild that would otherwise keep stdout open.
  it.runIf(!isWindows)("stops the program's children on timeout too", async () => {
    const started = Date.now();
    const r = await runProgram("sh", ["-c", "sleep 3; echo late"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("spawnProgram and killTree", () => {
  it("starts a program the caller can talk to", async () => {
    const child = spawnProgram(node, ["-e", "process.stdin.on('data', d => { process.stdout.write('echo:' + d); process.exit(0); })"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stdin?.write("ping");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(out).toBe("echo:ping");
  });

  it("killTree ends a running program and ignores one that already exited", async () => {
    const child = spawnProgram(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise((resolve) => child.on("spawn", resolve));
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    killTree(child);
    await closed;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => killTree(child)).not.toThrow();
  });
});
