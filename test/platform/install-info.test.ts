// Release targets, asset names, checksums, install detection and terminal detection.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectInstall,
  detectTerminal,
  formatChecksums,
  hostReleaseTarget,
  isCompiledBinary,
  launchCommand,
  parseChecksums,
  RELEASE_TARGETS,
  releaseArch,
  releaseAssetName,
  releaseDownloadUrl,
  releaseOs,
  resolveTargets,
} from "../../src/platform/install-info.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("release targets", () => {
  it("cover Windows, macOS and Linux on x64 and arm64", () => {
    expect(RELEASE_TARGETS.map((t) => t.asset).sort()).toEqual([
      "lu-minal-linux-arm64",
      "lu-minal-linux-arm64-musl",
      "lu-minal-linux-x64",
      "lu-minal-linux-x64-musl",
      "lu-minal-macos-arm64",
      "lu-minal-macos-x64",
      "lu-minal-windows-arm64.exe",
      "lu-minal-windows-x64.exe",
    ]);
  });

  it("map to Bun targets that exist", () => {
    const bun = /^bun-(linux|darwin|windows)-(x64|arm64)(-musl)?(-baseline)?$/;
    for (const t of RELEASE_TARGETS) {
      expect(t.bunTarget, t.name).toMatch(bun);
      const os = t.os === "macos" ? "darwin" : t.os;
      expect(t.bunTarget.startsWith(`bun-${os}-${t.arch}`), t.name).toBe(true);
      expect(t.bunTarget.includes("-musl"), t.name).toBe(t.libc === "musl");
    }
  });

  it("use the baseline runtime for x64 Linux and Windows (CPUs without AVX2)", () => {
    for (const t of RELEASE_TARGETS.filter((x) => x.arch === "x64" && x.os !== "macos")) {
      expect(t.bunTarget, t.name).toMatch(/-baseline$/);
    }
  });

  it("name assets from OS, CPU and C library", () => {
    expect(releaseAssetName("linux", "x64")).toBe("lu-minal-linux-x64");
    expect(releaseAssetName("linux", "arm64", "musl")).toBe("lu-minal-linux-arm64-musl");
    expect(releaseAssetName("macos", "arm64", "musl")).toBe("lu-minal-macos-arm64");
    expect(releaseAssetName("windows", "arm64")).toBe("lu-minal-windows-arm64.exe");
    for (const t of RELEASE_TARGETS) expect(releaseAssetName(t.os, t.arch, t.libc)).toBe(t.asset);
  });

  it("translate Node's and uname's names", () => {
    expect(releaseOs("darwin")).toBe("macos");
    expect(releaseOs("win32")).toBe("windows");
    expect(releaseOs("linux")).toBe("linux");
    expect(releaseOs("freebsd")).toBeNull();
    expect(releaseArch("x86_64")).toBe("x64");
    expect(releaseArch("AMD64")).toBe("x64");
    expect(releaseArch("aarch64")).toBe("arm64");
    expect(releaseArch("arm64")).toBe("arm64");
    expect(releaseArch("ia32")).toBeNull();
    expect(releaseArch("riscv64")).toBeNull();
  });

  it("find the binary for a machine", () => {
    expect(hostReleaseTarget("darwin", "arm64")?.asset).toBe("lu-minal-macos-arm64");
    expect(hostReleaseTarget("win32", "x64")?.asset).toBe("lu-minal-windows-x64.exe");
    expect(hostReleaseTarget("linux", "arm64", { musl: false })?.asset).toBe("lu-minal-linux-arm64");
    expect(hostReleaseTarget("linux", "x64", { musl: true })?.asset).toBe("lu-minal-linux-x64-musl");
    expect(hostReleaseTarget("linux", "ia32")).toBeNull();
    expect(hostReleaseTarget("aix", "ppc64")).toBeNull();
  });

  it("build download URLs for the latest or a given release", () => {
    expect(releaseDownloadUrl("lu-minal-linux-x64")).toBe(
      "https://github.com/Luna-OS/lu-minal/releases/latest/download/lu-minal-linux-x64",
    );
    expect(releaseDownloadUrl("SHA256SUMS", "0.2.0")).toBe(
      "https://github.com/Luna-OS/lu-minal/releases/download/v0.2.0/SHA256SUMS",
    );
    expect(releaseDownloadUrl("x", "v1.0.0-beta.1")).toBe("https://github.com/Luna-OS/lu-minal/releases/download/v1.0.0-beta.1/x");
    expect(releaseDownloadUrl("x", "latest")).toContain("/latest/download/x");
  });
});

describe("resolveTargets", () => {
  it("defaults to every target", () => {
    expect(resolveTargets()).toEqual([...RELEASE_TARGETS]);
    expect(resolveTargets("all")).toHaveLength(RELEASE_TARGETS.length);
  });

  it("accepts Node's, Bun's and uname's spellings", () => {
    const names = (spec: string) => resolveTargets(spec).map((t) => t.name);
    expect(names("darwin-arm64")).toEqual(["macos-arm64"]);
    expect(names("bun-windows-x64-baseline")).toEqual(["windows-x64"]);
    expect(names("linux-aarch64-musl")).toEqual(["linux-arm64-musl"]);
    expect(names("win32-arm64, linux-x64")).toEqual(["windows-arm64", "linux-x64"]);
    expect(names("lu-minal-windows-x64.exe")).toEqual(["windows-x64"]);
  });

  it("picks every target of an OS, without duplicates", () => {
    expect(resolveTargets("macos").map((t) => t.name)).toEqual(["macos-x64", "macos-arm64"]);
    expect(resolveTargets("windows,windows-x64").map((t) => t.name)).toEqual(["windows-x64", "windows-arm64"]);
    expect(resolveTargets("linux")).toHaveLength(4);
  });

  it("knows the host", () => {
    expect(resolveTargets("host", { platform: "darwin", arch: "x64" }).map((t) => t.name)).toEqual(["macos-x64"]);
    expect(() => resolveTargets("host", { platform: "sunos", arch: "x64" })).toThrow(/No lu-minal binary/);
  });

  it("rejects unknown names and lists the valid ones", () => {
    expect(() => resolveTargets("linux-mips")).toThrow(/Unknown target "linux-mips".*linux-x64.*windows-arm64/);
  });
});

describe("checksums", () => {
  const entries = [
    { file: "lu-minal-windows-x64.exe", sha256: sha("w") },
    { file: path.join("dist-bin", "lu-minal-linux-x64"), sha256: sha("l").toUpperCase() },
  ];

  it("writes GNU sha256sum format, sorted, lower case, base names only", () => {
    expect(formatChecksums(entries)).toBe(`${sha("l")}  lu-minal-linux-x64\n${sha("w")}  lu-minal-windows-x64.exe\n`);
    expect(formatChecksums([])).toBe("");
  });

  it("rejects something that is not a hash", () => {
    expect(() => formatChecksums([{ file: "x", sha256: "abc" }])).toThrow(/Not a SHA-256/);
  });

  it("reads back what it wrote, plus binary mode, CRLF and comments", () => {
    const text = `# lu-minal 0.2.0\r\n${sha("a")} *lu-minal-macos-arm64\r\n\r\n${sha("b").toUpperCase()}  lu-minal-linux-x64\nnot a line\n`;
    const parsed = parseChecksums(text);
    expect(parsed.get("lu-minal-macos-arm64")).toBe(sha("a"));
    expect(parsed.get("lu-minal-linux-x64")).toBe(sha("b"));
    expect(parsed.size).toBe(2);
    const round = parseChecksums(formatChecksums(entries));
    expect([...round.keys()]).toEqual(["lu-minal-linux-x64", "lu-minal-windows-x64.exe"]);
  });
});

describe("detectInstall", () => {
  it("recognises a Bun-compiled binary on POSIX and Windows", () => {
    expect(isCompiledBinary(["bun", "/$bunfs/root/lu-minal-linux-x64"])).toBe(true);
    expect(isCompiledBinary(["bun", "B:\\~BUN\\root\\lu-minal-windows-x64.exe"])).toBe(true);
    expect(isCompiledBinary(["/usr/bin/node", "/usr/lib/node_modules/lu-minal/dist/cli.js"])).toBe(false);
    const info = detectInstall({
      argv: ["bun", "/$bunfs/root/lu-minal", "--fresh"],
      execPath: "/home/ada/.local/bin/lu-minal",
      env: {},
      platform: "linux",
      arch: "x64",
    });
    expect(info).toMatchObject({ kind: "binary", exe: "/home/ada/.local/bin/lu-minal", args: [] });
    expect(info.asset).toMatch(/^lu-minal-linux-x64(-musl)?$/);
  });

  it("recognises the binary inside the macOS app", () => {
    const info = detectInstall({
      argv: ["bun", "/$bunfs/root/lu-minal"],
      execPath: "/Applications/LuMinal.app/Contents/Resources/bin/lu-minal",
      env: {},
      platform: "darwin",
      arch: "arm64",
    });
    expect(info.kind).toBe("macos-app");
    expect(info.asset).toBe("lu-minal-macos-arm64");
  });

  it("recognises an npm install and starts it through node with the script", () => {
    const script = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\lu-minal\\dist\\cli.js";
    const info = detectInstall({
      argv: ["C:\\Program Files\\nodejs\\node.exe", script],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      execArgv: ["--inspect=9229", "--no-warnings"],
      env: {},
      platform: "win32",
      arch: "arm64",
    });
    expect(info).toEqual({
      kind: "npm",
      exe: "C:\\Program Files\\nodejs\\node.exe",
      args: ["--no-warnings", script],
      asset: "lu-minal-windows-arm64.exe",
    });
  });

  it("calls anything else a source checkout", () => {
    const cmd = launchCommand({
      argv: ["/usr/bin/node", "/home/ada/code/lu-minal/dist/cli.js"],
      execPath: "/usr/bin/node",
      execArgv: [],
      env: {},
      platform: "linux",
      arch: "x64",
    });
    expect(cmd).toEqual({ exe: "/usr/bin/node", args: ["/home/ada/code/lu-minal/dist/cli.js"] });
    expect(
      detectInstall({ argv: ["/usr/bin/node", "/home/ada/code/lu-minal/dist/cli.js"], execPath: "/usr/bin/node", execArgv: [], platform: "linux" }).kind,
    ).toBe("source");
  });
});

describe("detectTerminal", () => {
  it("knows the terminals with true colour", () => {
    expect(detectTerminal({ WT_SESSION: "abc" }, "win32", "10.0.22631")).toEqual({ name: "windows-terminal", truecolor: true, hint: null });
    expect(detectTerminal({ TERM_PROGRAM: "iTerm.app" }, "darwin", "24.0.0").name).toBe("iterm2");
    expect(detectTerminal({ TERM_PROGRAM: "ghostty" }, "darwin", "24.0.0").name).toBe("ghostty");
    expect(detectTerminal({ TERM_PROGRAM: "WezTerm" }, "linux", "6.8.0").name).toBe("wezterm");
    expect(detectTerminal({ TERM: "xterm-kitty" }, "linux", "6.8.0").name).toBe("kitty");
    expect(detectTerminal({ TERM_PROGRAM: "vscode" }, "win32", "10.0.19045").name).toBe("vscode");
    expect(detectTerminal({ TERM_PROGRAM: "lu-minal", LU_MINAL_APP: "1" }, "darwin", "22.0.0")).toEqual({ name: "lu-minal-app", truecolor: true, hint: null });
  });

  it("knows the Windows window app, and doesn't send its users to Windows Terminal", () => {
    const env = { TERM_PROGRAM: "lu-minal-window", LU_MINAL_WEB_PANE: "1", TERM: "xterm-256color", COLORTERM: "truecolor" };
    expect(detectTerminal(env, "win32", "10.0.19045")).toEqual({ name: "lu-minal-window", truecolor: true, hint: null });
  });

  it("says Terminal.app before macOS 26 has 256 colours only", () => {
    const old = detectTerminal({ TERM_PROGRAM: "Apple_Terminal" }, "darwin", "24.6.0");
    expect(old.truecolor).toBe(false);
    expect(old.hint).toMatch(/256 colours/);
    expect(detectTerminal({ TERM_PROGRAM: "Apple_Terminal" }, "darwin", "25.0.0").truecolor).toBe(true);
    expect(detectTerminal({ TERM_PROGRAM: "Apple_Terminal", COLORTERM: "truecolor" }, "darwin", "24.6.0").truecolor).toBe(true);
  });

  it("recommends Windows Terminal over the classic console", () => {
    const conhost = detectTerminal({}, "win32", "10.0.19045");
    expect(conhost.name).toBe("conhost");
    expect(conhost.truecolor).toBe(true);
    expect(conhost.hint).toMatch(/lu-minal setup windows-terminal/);
    expect(detectTerminal({}, "win32", "6.1.7601").truecolor).toBe(false);
  });

  it("trusts COLORTERM for unknown terminals", () => {
    expect(detectTerminal({ COLORTERM: "truecolor" }, "linux", "6.8.0")).toEqual({ name: "unknown", truecolor: true, hint: null });
    expect(detectTerminal({ TERM: "xterm-256color" }, "linux", "6.8.0").truecolor).toBe(false);
  });
});
