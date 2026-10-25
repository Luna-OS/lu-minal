// install.sh against a fake release: OS / CPU detection (a fake `uname` on the PATH), checksum
// verification, installing, the PATH hint and the Linux desktop entry. Never touches the network:
// LU_MINAL_BASE_URL points at a local folder (or a file:// URL).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTALL_SH = path.join(ROOT, "install.sh");

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

const posix = process.platform !== "win32" && has("sh");
const canHash = posix && (has("sha256sum") || has("shasum") || has("openssl"));

let work: string;
let release: string;
let fakeBin: string;

/** A fake lu-minal "binary": a shell script that prints a version. */
function addAsset(name: string, version = "9.9.9"): string {
  const file = path.join(release, name);
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
  return file;
}

function writeSums(names: string[], corrupt?: string): void {
  const lines = names.map((n) => {
    let hash = createHash("sha256").update(fs.readFileSync(path.join(release, n))).digest("hex");
    if (n === corrupt) hash = hash.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    return `${hash}  ${n}\n`;
  });
  fs.writeFileSync(path.join(release, "SHA256SUMS"), lines.join(""));
}

function fakeUname(system: string, machine: string): void {
  fs.writeFileSync(
    path.join(fakeBin, "uname"),
    `#!/bin/sh\ncase "$1" in\n  -s) echo ${system} ;;\n  -m) echo ${machine} ;;\n  *) echo ${system} ;;\nesac\n`,
  );
  fs.chmodSync(path.join(fakeBin, "uname"), 0o755);
}

/** A fake program on the PATH that prints `out` (to stderr too, as musl's ldd does) and exits with `code`. */
function fakeProgram(name: string, out: string, code = 0): void {
  fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\necho '${out}'\necho '${out}' >&2\nexit ${code}\n`);
  fs.chmodSync(path.join(fakeBin, name), 0o755);
}

function run(env: Record<string, string>) {
  const r = spawnSync("sh", [INSTALL_SH], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: path.join(work, "home"),
      SHELL: "/bin/zsh",
      NO_COLOR: "1",
      LU_MINAL_BASE_URL: release,
      LU_MINAL_INSTALL_DIR: path.join(work, "bin"),
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.runIf(posix)("install.sh", () => {
  beforeEach(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-install-")));
    release = path.join(work, "release");
    fakeBin = path.join(work, "fake-bin");
    fs.mkdirSync(release);
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(path.join(work, "home"));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("passes sh -n", () => {
    expect(spawnSync("sh", ["-n", INSTALL_SH]).status).toBe(0);
  });

  it.runIf(canHash)("installs the Linux x64 binary after checking it", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64");
    addAsset("lu-minal-linux-arm64", "0.0.0");
    writeSums(["lu-minal-linux-x64", "lu-minal-linux-arm64"]);
    const r = run({ LU_MINAL_LIBC: "glibc", LU_MINAL_NO_DESKTOP: "1" });
    expect(r.out).toContain("Checksum OK");
    expect(r.out).toContain("Installed lu-minal 9.9.9");
    expect(r.status).toBe(0);
    const installed = path.join(work, "bin", "lu-minal");
    expect(fs.statSync(installed).mode & 0o111).not.toBe(0);
    expect(spawnSync(installed, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("9.9.9");
    // No temporary files are left next to it.
    expect(fs.readdirSync(path.join(work, "bin"))).toEqual(["lu-minal"]);
  });

  it.runIf(canHash)("picks arm64, and musl when asked", () => {
    fakeUname("Linux", "aarch64");
    addAsset("lu-minal-linux-arm64-musl", "1.2.3");
    writeSums(["lu-minal-linux-arm64-musl"]);
    const r = run({ LU_MINAL_LIBC: "musl", LU_MINAL_NO_DESKTOP: "1" });
    expect(r.out).toContain("lu-minal-linux-arm64-musl");
    expect(r.out).toContain("Installed lu-minal 1.2.3");
    expect(r.status).toBe(0);
  });

  it.runIf(canHash)("detects the C library: glibc's getconf wins, musl's ldd picks the musl build", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64", "1.0.0");
    addAsset("lu-minal-linux-x64-musl", "1.0.1");
    writeSums(["lu-minal-linux-x64", "lu-minal-linux-x64-musl"]);
    // glibc (even with Debian's musl package installed, which only adds /lib/ld-musl-*.so.1).
    fakeProgram("getconf", "glibc 2.39");
    fakeProgram("ldd", "ldd (GNU libc) 2.39");
    let r = run({ LU_MINAL_NO_DESKTOP: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Installed lu-minal 1.0.0");
    // musl: getconf does not know GNU_LIBC_VERSION, ldd says musl.
    fakeProgram("getconf", "getconf: GNU_LIBC_VERSION: unknown variable", 1);
    fakeProgram("ldd", "musl libc (x86_64)", 1);
    r = run({ LU_MINAL_NO_DESKTOP: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("lu-minal-linux-x64-musl");
    expect(r.out).toContain("Installed lu-minal 1.0.1");
  });

  it.runIf(canHash)("names macOS binaries macos-*", () => {
    fakeUname("Darwin", "arm64");
    addAsset("lu-minal-macos-arm64", "2.0.0");
    writeSums(["lu-minal-macos-arm64"]);
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.out).toContain("Installed lu-minal 2.0.0");
    expect(r.out).toMatch(/256 colours/); // the Terminal.app note
  });

  it.runIf(canHash)("refuses a binary whose checksum does not match", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64");
    writeSums(["lu-minal-linux-x64"], "lu-minal-linux-x64");
    const r = run({ LU_MINAL_LIBC: "glibc" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Checksum mismatch");
    expect(fs.existsSync(path.join(work, "bin", "lu-minal"))).toBe(false);
  });

  it("refuses when SHA256SUMS is missing or has no entry", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64");
    let r = run({ LU_MINAL_LIBC: "glibc" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("Could not download SHA256SUMS");
    fs.writeFileSync(path.join(release, "SHA256SUMS"), `${"0".repeat(64)}  lu-minal-linux-arm64\n`);
    r = run({ LU_MINAL_LIBC: "glibc" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("no entry for lu-minal-linux-x64");
  });

  it("installs without checking when LU_MINAL_NO_VERIFY=1", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64");
    const r = run({ LU_MINAL_LIBC: "glibc", LU_MINAL_NO_VERIFY: "1", LU_MINAL_NO_DESKTOP: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Skipping the checksum check");
  });

  it.runIf(canHash && has("curl"))("downloads from a file:// URL with curl", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64", "3.1.4");
    writeSums(["lu-minal-linux-x64"]);
    const r = run({ LU_MINAL_LIBC: "glibc", LU_MINAL_BASE_URL: `file://${release}`, LU_MINAL_NO_DESKTOP: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Installed lu-minal 3.1.4");
  });

  it.runIf(canHash)("replaces an older install and hints about PATH", () => {
    fakeUname("Linux", "x86_64");
    fs.mkdirSync(path.join(work, "bin"));
    fs.writeFileSync(path.join(work, "bin", "lu-minal"), "#!/bin/sh\necho 0.0.1\n");
    addAsset("lu-minal-linux-x64", "0.2.0");
    writeSums(["lu-minal-linux-x64"]);
    const r = run({ LU_MINAL_LIBC: "glibc", LU_MINAL_NO_DESKTOP: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Installed lu-minal 0.2.0");
    expect(r.out).toContain("is not on your PATH yet");
    expect(r.out).toContain("~/.zshrc");
  });

  it.runIf(canHash)("adds the applications menu entry on a Linux desktop", () => {
    fakeUname("Linux", "x86_64");
    addAsset("lu-minal-linux-x64");
    writeSums(["lu-minal-linux-x64"]);
    const data = path.join(work, "data");
    const dir = path.join(work, "my bin");
    const r = run({ LU_MINAL_LIBC: "glibc", DISPLAY: ":0", XDG_DATA_HOME: data, LU_MINAL_INSTALL_DIR: dir });
    expect(r.status).toBe(0);
    const entry = fs.readFileSync(path.join(data, "applications", "lu-minal.desktop"), "utf8");
    expect(entry).toContain(`Exec="${path.join(dir, "lu-minal")}"`);
    expect(entry).toContain(`TryExec=${path.join(dir, "lu-minal")}\n`);
    expect(entry).toContain("Terminal=true");
    expect(fs.readFileSync(path.join(data, "icons", "hicolor", "scalable", "apps", "lu-minal.svg"), "utf8")).toMatch(/^<svg /);
  });

  it("sends Windows users to install.ps1 and rejects unknown systems", () => {
    fakeUname("MINGW64_NT-10.0-22631", "x86_64");
    let r = run({});
    expect(r.status).toBe(1);
    expect(r.out).toContain("install.ps1");
    fakeUname("FreeBSD", "amd64");
    r = run({});
    expect(r.status).toBe(1);
    expect(r.out).toContain("npm i -g lu-minal");
    fakeUname("Linux", "riscv64");
    r = run({});
    expect(r.status).toBe(1);
    expect(r.out).toContain("riscv64");
  });
});
