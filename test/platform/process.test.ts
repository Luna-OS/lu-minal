// Finding and running programs: findProgram, cmdQuote, spawnProgram / runProgram, killTree.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cmdQuote,
  findProgram,
  killTree,
  openCommand,
  resolveCmdShim,
  runProgram,
  spawnProgram,
  windowsSpawnPlan,
  withProgramPath,
} from "../../src/platform/process.js";

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

// ---- Windows rules, checked on every OS ---------------------------------------------------------

/**
 * How the C runtime (and so node.exe behind an npm shim) splits a command line: backslashes escape
 * only before a quote, `""` inside quotes is one quote.
 */
function parseCrtCommandLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length) break;
    let arg = "";
    let quoted = false;
    while (i < line.length) {
      const c = line[i];
      if (!quoted && (c === " " || c === "\t")) break;
      if (c === "\\") {
        let n = 0;
        while (line[i] === "\\") {
          n++;
          i++;
        }
        if (line[i] === '"') {
          arg += "\\".repeat(Math.floor(n / 2));
          if (n % 2 === 1) {
            arg += '"';
            i++;
          }
        } else {
          arg += "\\".repeat(n);
        }
        continue;
      }
      if (c === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"';
          i += 2;
          continue;
        }
        quoted = !quoted;
        i++;
        continue;
      }
      arg += c;
      i++;
    }
    out.push(arg);
  }
  return out;
}

/** The characters of `line` that cmd.exe sees outside quotes (where & | < > ^ ( ) are operators). */
function outsideCmdQuotes(line: string): string {
  let quoted = false;
  let out = "";
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted) out += c;
  }
  return out;
}

describe("cmdQuote round trip", () => {
  const tricky = [
    "plain",
    "two words",
    'say "hi"',
    'a\\"b',
    "C:\\My Projects\\",
    "C:\\path\\with\\",
    "ends with two\\\\",
    "\\\\server\\share dir\\",
    "x&y|z<a>b^c(d)",
    "",
    '"',
    'quote at the end"',
    "café ☾ ✦",
  ];

  it("keeps every argument intact for the program behind cmd.exe", () => {
    const line = tricky.map(cmdQuote).join(" ");
    expect(parseCrtCommandLine(line)).toEqual(tricky);
  });

  it("never leaves cmd.exe's operators outside quotes", () => {
    for (const arg of tricky) {
      expect(outsideCmdQuotes(cmdQuote(arg)), arg).not.toMatch(/[&|<>^()]/);
    }
  });

  it("doubles backslashes only where the C runtime would read them as escapes", () => {
    expect(cmdQuote("C:\\My Projects\\")).toBe('"C:\\My Projects\\\\"');
    expect(cmdQuote('a\\"b c')).toBe('"a\\\\""b c"');
    expect(cmdQuote("a\\b c")).toBe('"a\\b c"');
  });
});

describe("findProgram with Windows rules", () => {
  const win = { platform: "win32" as const };

  it("skips npm's extensionless Git Bash script and takes the .cmd next to it", () => {
    const bin = path.join(tmp, "win-npm");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\n");
    expect(findProgram("claude", { ...win, env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" } })).toBe(path.join(bin, "claude.cmd"));
    // A configured path without the extension finds the shim too.
    expect(findProgram("claude", { ...win, configured: path.join(bin, "claude"), env: { PATH: "" } })).toBe(path.join(bin, "claude.cmd"));
  });

  it("reads the PATH under any spelling, with quoted entries and unexpanded variables", () => {
    const bin = path.join(tmp, "win-quoted");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "moon.exe"), "MZ");
    expect(findProgram("moon", { ...win, env: { pAtH: `"${bin}"`, PATHEXT: ".EXE" } })).toBe(path.join(bin, "moon.exe"));
    expect(findProgram("moon", { ...win, env: { Path: "%MOON_BIN%", MOON_BIN: bin, pathext: ".exe" } })).toBe(path.join(bin, "moon.exe"));
  });

  it("only offers what spawnProgram can start (PATHEXT may list .JS or .PS1)", () => {
    const bin = path.join(tmp, "win-ps1");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "tool.ps1"), "Write-Output hi");
    fs.writeFileSync(path.join(bin, "tool.js"), "console.log(1)");
    expect(findProgram("tool", { ...win, env: { PATH: bin, PATHEXT: ".JS;.PS1;.EXE" } })).toBeNull();
    // A dot in a name is not an extension ("python3.12").
    fs.writeFileSync(path.join(bin, "python3.12.exe"), "MZ");
    expect(findProgram("python3.12", { ...win, env: { PATH: bin, PATHEXT: ".EXE" } })).toBe(path.join(bin, "python3.12.exe"));
  });
});

describe("npm shims on Windows", () => {
  /** An npm-style global folder: <dir>\claude.cmd and the package's cli.js. */
  function npmFolder(name: string, shim: string, opts: { nodeExe?: boolean } = {}): { dir: string; shim: string; script: string } {
    const dir = path.join(tmp, name);
    const script = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "// cli");
    if (opts.nodeExe) fs.writeFileSync(path.join(dir, "node.exe"), "MZ");
    const file = path.join(dir, "claude.cmd");
    fs.writeFileSync(file, shim);
    return { dir, shim: file, script };
  }

  const NPM7 = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    "",
  ].join("\r\n");

  it("finds the script and the node of npm 7+'s shim", () => {
    const withNode = npmFolder("npm7-node", NPM7, { nodeExe: true });
    expect(resolveCmdShim(withNode.shim)).toEqual({ exe: path.join(withNode.dir, "node.exe"), args: [withNode.script] });
    const plain = npmFolder("npm7-path", NPM7);
    expect(resolveCmdShim(plain.shim, { findNode: () => "C:\\nodejs\\node.exe" })).toEqual({ exe: "C:\\nodejs\\node.exe", args: [plain.script] });
    // No node anywhere: leave it to cmd.exe.
    expect(resolveCmdShim(plain.shim, { findNode: () => null })).toBeNull();
  });

  it("reads npm 6's shim and one that points at a program", () => {
    const npm6 = npmFolder(
      "npm6",
      [
        '@IF EXIST "%~dp0\\node.exe" (',
        '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
        ") ELSE (",
        "  @SETLOCAL",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        '  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
        ")",
      ].join("\r\n"),
    );
    expect(resolveCmdShim(npm6.shim, { findNode: () => "node.exe" })).toEqual({ exe: "node.exe", args: [npm6.script] });

    const dir = path.join(tmp, "native-shim");
    const exe = path.join(dir, "node_modules", "tool", "bin", "tool.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "MZ");
    const shim = path.join(dir, "tool.cmd");
    fs.writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n');
    expect(resolveCmdShim(shim)).toEqual({ exe, args: [] });
  });

  it("leaves other batch files alone", () => {
    const file = path.join(tmp, "other.cmd");
    fs.writeFileSync(file, "@echo off\r\necho %*\r\n");
    expect(resolveCmdShim(file)).toBeNull();
    expect(resolveCmdShim(path.join(tmp, "missing.cmd"))).toBeNull();
  });

  it("starts programs directly and batch files through cmd.exe, quoted", () => {
    expect(windowsSpawnPlan("C:\\bin\\git.exe", ["status", "a b"])).toEqual({ file: "C:\\bin\\git.exe", args: ["status", "a b"], verbatim: false });
    const plan = windowsSpawnPlan("C:\\Users\\Ada Lovelace\\npm\\claude.cmd", ["-p", "x&y"], { COMSPEC: "C:\\Windows\\system32\\cmd.exe" });
    expect(plan).toEqual({
      file: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Users\\Ada Lovelace\\npm\\claude.cmd" -p "x&y""'],
      verbatim: true,
    });
  });

  it("starts an npm shim's target when cmd.exe would cut or expand an argument", () => {
    const npm = npmFolder("npm7-multiline", NPM7, { nodeExe: true });
    const message = "line one\nline two with %PATH%";
    expect(windowsSpawnPlan(npm.shim, ["-p", message, "--cloud", "session_1"])).toEqual({
      file: path.join(npm.dir, "node.exe"),
      args: [npm.script, "-p", message, "--cloud", "session_1"],
      verbatim: false,
    });
    // A batch file that is no npm shim can't take a line break: say so instead of losing text.
    const other = path.join(tmp, "plain.bat");
    fs.writeFileSync(other, "@echo off\r\n");
    expect(() => windowsSpawnPlan(other, ["a\nb"])).toThrow(/line break/);
    // "%" alone still goes through cmd.exe (best effort).
    expect(windowsSpawnPlan(other, ["100%"]).verbatim).toBe(true);
  });
});

describe("killTree on Windows", () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  }

  it("runs taskkill by its full path for the whole tree", () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => new EventEmitter() as unknown as ChildProcess);
    killTree(child as unknown as ChildProcess, { platform: "win32", spawnImpl, env: { SystemRoot: "D:\\Win" } });
    expect(spawnImpl).toHaveBeenCalledWith("D:\\Win\\System32\\taskkill.exe", ["/pid", "4242", "/T", "/F"], expect.objectContaining({ windowsHide: true }));
  });

  it("survives a taskkill that can't start (no unhandled error) and kills the process itself", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      const killer = new EventEmitter();
      setImmediate(() => killer.emit("error", Object.assign(new Error("spawn taskkill.exe ENOENT"), { code: "ENOENT" })));
      return killer as unknown as ChildProcess;
    });
    killTree(child as unknown as ChildProcess, { platform: "win32", spawnImpl, env: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalled();
  });

  it("leaves a process alone that already ended by a signal", () => {
    const child = Object.assign(fakeChild(), { signalCode: "SIGTERM" });
    const spawnImpl = vi.fn();
    killTree(child as unknown as ChildProcess, { platform: "win32", spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("openCommand", () => {
  it("uses rundll32 by its full path on Windows and /usr/bin/open on macOS", () => {
    const url = "https://openrouter.ai/auth?callback_url=http://localhost:3000/callback&code_challenge=x";
    expect(openCommand(url, { platform: "win32", env: { SYSTEMROOT: "C:\\Windows" } })).toEqual({
      exe: "C:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(openCommand(url, { platform: "darwin", env: {} })).toEqual({ exe: "/usr/bin/open", args: [url] });
  });

  it("prefers wslview under WSL and xdg-open elsewhere", () => {
    const find = (name: string) => `/usr/bin/${name}`;
    expect(openCommand("x", { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, find }).exe).toBe("/usr/bin/wslview");
    expect(openCommand("x", { platform: "linux", env: {}, find }).exe).toBe("/usr/bin/xdg-open");
    expect(openCommand("x", { platform: "linux", env: {}, find: () => null }).exe).toBe("xdg-open");
  });
});

describe("withProgramPath", () => {
  it("appends the program's folder under Windows' own spelling of PATH", () => {
    const env = withProgramPath({ Path: "C:\\Windows\\System32;C:\\Users\\ada\\AppData\\Roaming\\npm\\" }, "C:\\Users\\ada\\AppData\\Roaming\\npm\\claude.cmd", "win32");
    expect(env.Path).toBe("C:\\Windows\\System32;C:\\Users\\ada\\AppData\\Roaming\\npm\\");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
    const nvm = withProgramPath({ Path: "C:\\Windows" }, "C:\\nvm4w\\nodejs\\gemini.cmd", "win32");
    expect(nvm.Path).toBe("C:\\Windows;C:\\nvm4w\\nodejs");
  });

  it("adds Homebrew's folders on macOS for an app started from the Dock", () => {
    const env = withProgramPath({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, "/Users/ada/.nvm/versions/node/v22.11.0/bin/claude", "darwin");
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/Users/ada/.nvm/versions/node/v22.11.0/bin:/opt/homebrew/bin:/usr/local/bin");
    expect(withProgramPath({ PATH: "/usr/bin" }, "claude", "linux").PATH).toBe("/usr/bin");
  });
});
