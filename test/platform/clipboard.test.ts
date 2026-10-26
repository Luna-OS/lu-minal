// Copying text to the clipboard: which programs each platform uses, the text reaching them intact
// (fake programs on the PATH stand in for them), and OSC 52 when none of them can.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clipboardWriteTools, copyToClipboard, osc52 } from "../../src/platform/clipboard.js";

const TEXT = "First line ☾ moon · 月\n\nlast line with 'quotes' and \"more\" $HOME %PATH%";

describe("clipboardWriteTools", () => {
  it("uses pbcopy on macOS, in UTF-8 even without a UTF-8 locale", () => {
    expect(clipboardWriteTools("darwin", { LANG: "en_US.UTF-8" })).toEqual([{ exe: "pbcopy", args: [], encoding: "utf8", env: undefined }]);
    const [tool] = clipboardWriteTools("darwin", { PATH: "/usr/bin" });
    expect(tool.env).toMatchObject({ PATH: "/usr/bin", LC_CTYPE: "UTF-8" });
  });

  it("uses PowerShell with the text in a file on Windows (never on the command line), then clip.exe", () => {
    const tools = clipboardWriteTools("win32", {});
    expect(tools.map((t) => t.exe)).toEqual(["powershell.exe", "pwsh.exe", "clip.exe"]);
    expect(tools[0].args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
    expect(tools[0].args[4]).toContain("Set-Clipboard");
    expect(tools[0].args[4]).toContain("'{file}'");
    expect(tools[0].args[4]).toContain("UTF8");
    // clip.exe reads UTF-8 as the console's code page; UTF-16 with a BOM it gets right.
    expect(tools[2].encoding).toBe("utf16le");
  });

  it("uses wl-copy on Wayland, xclip and xsel on X11, clip.exe in WSL, nothing without a display", () => {
    expect(clipboardWriteTools("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }).map((t) => t.exe)).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(clipboardWriteTools("linux", { DISPLAY: ":0" }).map((t) => t.exe)).toEqual(["xclip", "xsel"]);
    expect(clipboardWriteTools("linux", { WSL_DISTRO_NAME: "Ubuntu" }).map((t) => t.exe)).toEqual(["clip.exe"]);
    expect(clipboardWriteTools("linux", {})).toEqual([]);
  });

  it("leaves the remote machine's clipboard alone over SSH (X11 forwarding still counts)", () => {
    const ssh = { SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22" };
    expect(clipboardWriteTools("darwin", ssh)).toEqual([]);
    expect(clipboardWriteTools("win32", ssh)).toEqual([]);
    expect(clipboardWriteTools("linux", ssh)).toEqual([]);
    expect(clipboardWriteTools("linux", { ...ssh, DISPLAY: "localhost:10.0" }).map((t) => t.exe)).toEqual(["xclip", "xsel"]);
  });
});

describe("osc52", () => {
  it("asks the terminal to set the clipboard to the text, as UTF-8 in base64", () => {
    const seq = osc52(TEXT);
    expect(seq.startsWith("\u001b]52;c;")).toBe(true);
    expect(seq.endsWith("\u0007")).toBe(true);
    expect(Buffer.from(seq.slice(7, -1), "base64").toString("utf8")).toBe(TEXT);
  });
});

describe("copyToClipboard", () => {
  let dir = "";
  let bin = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-copy-"));
    bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = (name: string) => path.join(dir, `${name}.out`);
  /** A fake clipboard program: keeps what it was given on stdin, and the arguments. */
  const fake = (name: string, code = 0) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nPATH=/usr/bin:/bin\nprintf '%s\\n' "$@" > '${out(name)}.args'\ncat > '${out(name)}'\nexit ${code}\n`, { mode: 0o755 });
  const env = (extra: NodeJS.ProcessEnv = {}) => ({ PATH: bin, ...extra });

  it("falls back to OSC 52 when no program is there, and says when nothing could copy", async () => {
    const written: string[] = [];
    expect(await copyToClipboard(TEXT, { platform: "linux", env: env({ DISPLAY: ":0" }), terminal: (s) => void written.push(s) })).toEqual({ via: "osc52" });
    expect(written).toEqual([osc52(TEXT)]);
    expect(await copyToClipboard(TEXT, { platform: "linux", env: env() })).toEqual({ via: null });
  });

  // The fakes are shell scripts.
  describe.skipIf(process.platform === "win32")("with the programs", () => {
    it("pipes the text to xclip unchanged", async () => {
      fake("xclip");
      const written: string[] = [];
      expect(await copyToClipboard(TEXT, { platform: "linux", env: env({ DISPLAY: ":0" }), terminal: (s) => void written.push(s) })).toEqual({ via: "xclip" });
      expect(fs.readFileSync(out("xclip"), "utf8")).toBe(TEXT);
      expect(fs.readFileSync(`${out("xclip")}.args`, "utf8")).toBe("-selection\nclipboard\n-in\n");
      expect(written).toEqual([]);
    });

    it("tries the next program when one fails", async () => {
      fake("wl-copy", 1);
      fake("xsel");
      expect(await copyToClipboard(TEXT, { platform: "linux", env: env({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }) })).toEqual({ via: "xsel" });
      expect(fs.readFileSync(out("xsel"), "utf8")).toBe(TEXT);
    });

    it("pipes to pbcopy on macOS", async () => {
      fake("pbcopy");
      expect(await copyToClipboard(TEXT, { platform: "darwin", env: env({ LANG: "en_US.UTF-8" }) })).toEqual({ via: "pbcopy" });
      expect(fs.readFileSync(out("pbcopy"), "utf8")).toBe(TEXT);
    });

    it("gives PowerShell the text in a UTF-8 file it reads, and removes the file after", async () => {
      // Stands in for powershell.exe: finds the file in its -Command script and keeps a copy.
      fs.writeFileSync(
        path.join(bin, "powershell.exe"),
        `#!/bin/sh\nPATH=/usr/bin:/bin\nfile=$(printf '%s' "$5" | sed -n "s/.*ReadAllText('\\([^']*\\)'.*/\\1/p")\nprintf '%s' "$file" > '${out("ps")}.path'\ncp "$file" '${out("ps")}'\n`,
        { mode: 0o755 },
      );
      expect(await copyToClipboard(TEXT, { platform: "win32", env: env() })).toEqual({ via: "powershell.exe" });
      expect(fs.readFileSync(out("ps"), "utf8")).toBe(TEXT);
      const file = fs.readFileSync(`${out("ps")}.path`, "utf8");
      expect(file).toContain("lu-minal-copy-");
      expect(fs.existsSync(file)).toBe(false);
    });

    it("gives clip.exe UTF-16 with a BOM", async () => {
      fake("clip.exe");
      expect(await copyToClipboard(TEXT, { platform: "linux", env: env({ WSL_DISTRO_NAME: "Ubuntu" }) })).toEqual({ via: "clip.exe" });
      const got = fs.readFileSync(out("clip.exe"));
      expect([...got.subarray(0, 2)]).toEqual([0xff, 0xfe]);
      expect(got.subarray(2).toString("utf16le")).toBe(TEXT);
    });

    it("doesn't wait for a program that stays behind to serve the clipboard", async () => {
      // xclip and wl-copy fork and keep running; only the first process's exit counts.
      fs.writeFileSync(path.join(bin, "xclip"), `#!/bin/sh\nPATH=/usr/bin:/bin\ncat > '${out("xclip")}'\n(sleep 5) &\nexit 0\n`, { mode: 0o755 });
      const started = Date.now();
      expect(await copyToClipboard(TEXT, { platform: "linux", env: env({ DISPLAY: ":0" }) })).toEqual({ via: "xclip" });
      expect(Date.now() - started).toBeLessThan(4000);
    });
  });
});
