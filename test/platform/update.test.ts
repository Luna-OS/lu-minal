// The updater: the daily check against GitHub's newest release, how each kind of install updates,
// the checked download and the swap of a running binary. Every request goes to a fake fetch.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectInstall, type InstallInfo } from "../../src/platform/install-info.js";
import {
  applyUpdate,
  checkForUpdate,
  compareVersions,
  downloadVerified,
  removeOldCopies,
  swapExecutable,
  UPDATE_CHECK_INTERVAL_MS,
  updatePlan,
} from "../../src/platform/update.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-update-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const sha = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** A fake GitHub: the API's newest release and a release's files, with a log of the URLs asked for. */
function fakeGitHub(opts: { version?: string; files?: Record<string, string | Buffer>; sums?: string; status?: number; noRedirect?: boolean } = {}) {
  const version = opts.version ?? "0.2.0";
  const files = opts.files ?? {};
  const sums = opts.sums ?? Object.entries(files).map(([name, data]) => `${sha(data)}  ${name}\n`).join("");
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://github.com/Luna-OS/lu-minal/releases/latest") {
      if (opts.status || opts.noRedirect) return new Response("", { status: opts.status ?? 200 });
      return new Response(null, { status: 302, headers: { location: `https://github.com/Luna-OS/lu-minal/releases/tag/v${version}` } });
    }
    if (url === "https://api.github.com/repos/Luna-OS/lu-minal/releases/latest") {
      if (opts.status) return new Response("rate limited", { status: opts.status });
      return Response.json({ tag_name: `v${version}`, html_url: `https://github.com/Luna-OS/lu-minal/releases/tag/v${version}` });
    }
    const prefix = `https://github.com/Luna-OS/lu-minal/releases/download/v${version}/`;
    if (url === `${prefix}SHA256SUMS`) return new Response(sums);
    const name = url.startsWith(prefix) ? url.slice(prefix.length) : "";
    if (name in files) {
      const body = Buffer.from(files[name]);
      return new Response(body, { headers: { "content-length": String(body.length) } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

const info = (extra: Partial<InstallInfo>): InstallInfo => ({ kind: "binary", exe: "/usr/local/bin/lu-minal", args: [], asset: "lu-minal-linux-x64", ...extra });

describe("compareVersions", () => {
  it("orders versions like semver", () => {
    expect(compareVersions("0.1.1", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("v0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0-rc.10", "0.2.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0+5", "0.2.0")).toBe(0);
  });
});

describe("checkForUpdate", () => {
  it("asks GitHub at most once a day, and again when forced", async () => {
    const gh = fakeGitHub({ version: "0.2.0" });
    const cacheFile = path.join(dir, "cache", "update-check.json");
    const now = 1_800_000_000_000;
    const first = await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: gh.fetchImpl, now });
    expect(first).toEqual({ version: "0.2.0", url: "https://github.com/Luna-OS/lu-minal/releases/tag/v0.2.0", newer: true });
    await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: gh.fetchImpl, now: now + 60_000 });
    // Only the release page's redirect: no API quota used.
    expect(gh.calls).toEqual(["https://github.com/Luna-OS/lu-minal/releases/latest"]);
    await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: gh.fetchImpl, now: now + 60_000, force: true });
    await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: gh.fetchImpl, now: now + 60_000 + UPDATE_CHECK_INTERVAL_MS });
    expect(gh.calls).toHaveLength(3);
    // Without the redirect (a proxy in the way), the API answers.
    const api = fakeGitHub({ version: "0.2.1", noRedirect: true });
    expect((await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: api.fetchImpl, force: true }))?.version).toBe("0.2.1");
    expect(api.calls).toEqual(["https://github.com/Luna-OS/lu-minal/releases/latest", "https://api.github.com/repos/Luna-OS/lu-minal/releases/latest"]);
    // The same version is not an update.
    expect((await checkForUpdate({ current: "0.2.0", cacheFile, fetchImpl: gh.fetchImpl, now: now + 120_000 }))?.newer).toBe(false);
  });

  it("falls back to the last answer when GitHub fails, and only throws when forced", async () => {
    const cacheFile = path.join(dir, "update-check.json");
    const down = fakeGitHub({ status: 403 });
    expect(await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: down.fetchImpl })).toBeNull();
    await expect(checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: down.fetchImpl, force: true })).rejects.toThrow("403");
    await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: fakeGitHub({ version: "0.3.0" }).fetchImpl, now: 1000 });
    const later = await checkForUpdate({ current: "0.1.1", cacheFile, fetchImpl: down.fetchImpl, now: 1000 + UPDATE_CHECK_INTERVAL_MS + 1 });
    expect(later?.version).toBe("0.3.0");
  });
});

describe("updatePlan", () => {
  it("swaps a standalone binary, runs the setup for a setup install and replaces the macOS app", () => {
    expect(updatePlan(info({}), "linux")).toEqual({ kind: "binary", asset: "lu-minal-linux-x64", exe: "/usr/local/bin/lu-minal" });
    const winExe = "C:\\Users\\ada\\AppData\\Local\\Programs\\lu-minal\\lu-minal.exe";
    const win = info({ exe: winExe, asset: "lu-minal-windows-arm64.exe" });
    expect(updatePlan(win, "win32", () => false)).toEqual({ kind: "binary", asset: "lu-minal-windows-arm64.exe", exe: winExe });
    const seen: string[] = [];
    const withUninstaller = (f: string) => (seen.push(f), f.endsWith("unins000.exe"));
    expect(updatePlan(win, "win32", withUninstaller)).toEqual({ kind: "windows-setup", asset: "lu-minal-windows-arm64-setup.exe", exe: winExe });
    expect(seen).toEqual(["C:\\Users\\ada\\AppData\\Local\\Programs\\lu-minal\\unins000.exe"]);
    const app = info({ kind: "macos-app", exe: "/Applications/LuMinal.app/Contents/Resources/lu-minal", asset: "lu-minal-macos-arm64" });
    expect(updatePlan(app, "darwin")).toEqual({ kind: "macos-app", asset: "lu-minal-macos-app.zip", app: "/Applications/LuMinal.app" });
  });

  it("updates through the setup when lu-minal runs in the window app (which is not the macOS app)", () => {
    const winExe = "C:\\Users\\ada\\AppData\\Local\\Programs\\lu-minal\\lu-minal.exe";
    const inWindow = detectInstall({
      argv: [winExe, "B:\\~BUN\\root\\lu-minal.exe"],
      execPath: winExe,
      env: { LU_MINAL_WEB_PANE: "1", TERM_PROGRAM: "lu-minal-window", TERM: "xterm-256color", COLORTERM: "truecolor" },
      platform: "win32",
      arch: "x64",
    });
    expect(inWindow.kind).toBe("binary");
    expect(updatePlan(inWindow, "win32", (f) => f.endsWith("unins000.exe"))).toEqual({
      kind: "windows-setup",
      asset: "lu-minal-windows-x64-setup.exe",
      exe: winExe,
    });
  });

  it("only names the commands for a checkout", () => {
    const plan = updatePlan(info({ kind: "source", exe: "/usr/bin/node", args: [path.join(dir, "lu minal", "dist", "cli.js")], asset: "lu-minal-linux-x64" }), process.platform);
    expect(plan).toEqual({ kind: "manual", commands: [`cd "${path.join(dir, "lu minal")}"`, "git pull", "npm ci", "npm run build"] });
  });
});

describe("downloadVerified", () => {
  it("keeps a file that matches SHA256SUMS and drops one that doesn't", async () => {
    const good = fakeGitHub({ files: { "lu-minal-linux-x64": "new binary" } });
    const dest = path.join(dir, "download");
    const status: string[] = [];
    await downloadVerified("0.2.0", "lu-minal-linux-x64", dest, { fetchImpl: good.fetchImpl, onStatus: (l) => status.push(l) });
    expect(fs.readFileSync(dest, "utf8")).toBe("new binary");
    expect(status.at(-1)).toBe("Downloading lu-minal-linux-x64: 100%");

    const bad = fakeGitHub({ files: { "lu-minal-linux-x64": "tampered" }, sums: `${sha("new binary")}  lu-minal-linux-x64\n` });
    const other = path.join(dir, "other");
    await expect(downloadVerified("0.2.0", "lu-minal-linux-x64", other, { fetchImpl: bad.fetchImpl })).rejects.toThrow("does not match SHA256SUMS");
    expect(fs.existsSync(other)).toBe(false);
    await expect(downloadVerified("0.2.0", "lu-minal-macos-x64", other, { fetchImpl: good.fetchImpl })).rejects.toThrow("is not in the 0.2.0 release's SHA256SUMS");
  });
});

describe("swapping the binary", () => {
  it("renames the new file over the old one on macOS and Linux", () => {
    const exe = path.join(dir, "lu-minal");
    fs.writeFileSync(exe, "old");
    fs.writeFileSync(path.join(dir, ".new"), "new");
    swapExecutable(path.join(dir, ".new"), exe, "linux");
    expect(fs.readFileSync(exe, "utf8")).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["lu-minal"]);
  });

  it("moves the running exe aside on Windows, and a later start removes it", () => {
    const exe = path.join(dir, "lu-minal.exe");
    fs.writeFileSync(exe, "old");
    fs.writeFileSync(path.join(dir, ".new.exe"), "new");
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    swapExecutable(path.join(dir, ".new.exe"), exe, "win32");
    expect(fs.readFileSync(exe, "utf8")).toBe("new");
    const aside = fs.readdirSync(dir).filter((n) => /^lu-minal\.old-[0-9a-f]{8}\.exe$/.test(n));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), "utf8")).toBe("old");
    removeOldCopies(exe);
    expect(fs.readdirSync(dir).sort()).toEqual(["lu-minal.exe", "notes.txt"]);
  });

  it("also removes the window app's copies the setup moved aside, and nothing else", () => {
    const exe = path.join(dir, "lu-minal.exe");
    for (const name of [
      "lu-minal.exe",
      "lu-minal-window.exe",
      "lu-minal-window.old-20260101120000123.exe",
      "LU-MINAL-WINDOW.OLD-x.EXE",
      "lu-minal.old-20260101120000123.exe",
      "lu-minal-windows.old-1.exe",
      "lu-minal-window.old.txt",
      "other.old-1.exe",
    ]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }
    removeOldCopies(exe);
    expect(fs.readdirSync(dir).sort()).toEqual(["lu-minal-window.exe", "lu-minal-window.old.txt", "lu-minal-windows.old-1.exe", "lu-minal.exe", "other.old-1.exe"]);
  });
});

describe("applyUpdate", () => {
  it("downloads, checks and swaps a standalone binary", async () => {
    const exe = path.join(dir, "lu-minal");
    fs.writeFileSync(exe, "0.1.1");
    const gh = fakeGitHub({ files: { "lu-minal-linux-x64": "0.2.0" } });
    const message = await applyUpdate({ kind: "binary", asset: "lu-minal-linux-x64", exe }, "0.2.0", { fetchImpl: gh.fetchImpl, platform: "linux" });
    expect(message).toContain("Updated to lu-minal 0.2.0");
    expect(fs.readFileSync(exe, "utf8")).toBe("0.2.0");
    if (process.platform !== "win32") expect(fs.statSync(exe).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(dir)).toEqual(["lu-minal"]);
  });

  it("leaves the running copy alone when the download is wrong", async () => {
    const exe = path.join(dir, "lu-minal");
    fs.writeFileSync(exe, "0.1.1");
    const gh = fakeGitHub({ files: { "lu-minal-linux-x64": "evil" }, sums: `${sha("0.2.0")}  lu-minal-linux-x64\n` });
    await expect(applyUpdate({ kind: "binary", asset: "lu-minal-linux-x64", exe }, "0.2.0", { fetchImpl: gh.fetchImpl, platform: "linux" })).rejects.toThrow(
      "does not match",
    );
    expect(fs.readFileSync(exe, "utf8")).toBe("0.1.1");
    expect(fs.readdirSync(dir)).toEqual(["lu-minal"]);
  });

  it("runs the newer setup silently for a copy the setup installed", async () => {
    const gh = fakeGitHub({ files: { "lu-minal-windows-x64-setup.exe": "setup" } });
    const runs: Array<{ exe: string; args: string[]; content: string }> = [];
    const message = await applyUpdate({ kind: "windows-setup", asset: "lu-minal-windows-x64-setup.exe", exe: "C:\\lu-minal\\lu-minal.exe" }, "0.2.0", {
      fetchImpl: gh.fetchImpl,
      platform: "win32",
      run: async (exe, args) => {
        runs.push({ exe, args, content: fs.readFileSync(exe, "utf8") });
        return 0;
      },
    });
    expect(message).toContain("Updated to lu-minal 0.2.0");
    expect(runs).toHaveLength(1);
    expect(path.basename(runs[0].exe)).toBe("lu-minal-windows-x64-setup.exe");
    expect(runs[0].content).toBe("setup");
    expect(runs[0].args).toEqual(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
    expect(fs.existsSync(runs[0].exe)).toBe(false);
  });

  it("puts the new macOS app in place of the old one", async () => {
    const app = path.join(dir, "Applications", "LuMinal.app");
    fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "version"), "0.1.1");
    const gh = fakeGitHub({ files: { "lu-minal-macos-app.zip": "zip" } });
    // ditto: -x -k unpacks the zip (here: makes the bundle), otherwise it copies a folder.
    const run = async (exe: string, args: string[]) => {
      expect(exe).toBe("/usr/bin/ditto");
      if (args[0] === "-x") {
        fs.mkdirSync(path.join(args[3], "LuMinal.app", "Contents"), { recursive: true });
        fs.writeFileSync(path.join(args[3], "LuMinal.app", "Contents", "version"), "0.2.0");
      } else {
        fs.cpSync(args[0], args[1], { recursive: true });
      }
      return 0;
    };
    const message = await applyUpdate({ kind: "macos-app", asset: "lu-minal-macos-app.zip", app }, "0.2.0", { fetchImpl: gh.fetchImpl, platform: "darwin", run });
    expect(message).toContain("Updated LuMinal.app to 0.2.0");
    expect(fs.readFileSync(path.join(app, "Contents", "version"), "utf8")).toBe("0.2.0");
    expect(fs.readdirSync(path.dirname(app))).toEqual(["LuMinal.app"]);
  });

  it("names the commands instead of touching a checkout", async () => {
    await expect(applyUpdate({ kind: "manual", commands: ["cd ~/lu-minal", "git pull"] }, "0.2.0")).rejects.toThrow("cd ~/lu-minal && git pull");
  });
});
