// Installing ACP agents that ship as binaries in the ACP registry: the registry lookup, the checked
// download, unpacking (a fake extractor), the manifest and cleanup. No network: a fake fetch.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACP_REGISTRY_URL,
  acpAgentsDir,
  fetchRegistryBinary,
  installAcp,
  installedAcp,
  registryPlatform,
} from "../../src/agents/acp/download.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-acp-dl-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const ARCHIVE = Buffer.from("pretend this is a zip");
const sha = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const ARCHIVE_URL = "https://dl.example.com/agy-acp-server-1.4.5-linux-x86_64.zip";

function entry(opts: { version?: string; cmd?: string; sha256?: string; binary?: unknown } = {}) {
  return {
    id: "antigravity-acp",
    name: "Google Antigravity",
    version: opts.version ?? "1.4.5",
    distribution: {
      binary: opts.binary ?? {
        "linux-x86_64": { archive: ARCHIVE_URL, cmd: opts.cmd ?? "./agy_acp_server", args: ["--uid="], sha256: opts.sha256 ?? sha(ARCHIVE) },
      },
    },
  };
}

/** A fake CDN: the registry JSON and the archive, with a log of the URLs asked for. */
function fakeFetch(agents: unknown[], opts: { status?: number; gate?: Promise<void> } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === ACP_REGISTRY_URL) return opts.status ? new Response("no", { status: opts.status }) : Response.json({ version: "1", agents });
    if (url === ARCHIVE_URL) {
      await opts.gate;
      return new Response(ARCHIVE, { headers: { "content-length": String(ARCHIVE.length) } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, downloads: () => calls.filter((c) => c === ARCHIVE_URL).length };
}

/** A fake unzip: writes the files into the folder after -d. */
function fakeUnzip(files: Record<string, string> = { agy_acp_server: "#!/bin/sh\n", localharness_external: "x" }, code = 0) {
  const runs: { exe: string; args: string[] }[] = [];
  const run = async (exe: string, args: string[]) => {
    runs.push({ exe, args });
    const dir = args[args.indexOf("-d") + 1];
    for (const [name, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), data);
    }
    return code;
  };
  return { run, runs };
}

const linux = { platform: "linux" as const, arch: "x64" };

describe("registryPlatform", () => {
  it("names the registry's platform keys", () => {
    expect(registryPlatform("win32", "x64")).toBe("windows-x86_64");
    expect(registryPlatform("win32", "arm64")).toBe("windows-aarch64");
    expect(registryPlatform("darwin", "arm64")).toBe("darwin-aarch64");
    expect(registryPlatform("darwin", "x64")).toBe("darwin-x86_64");
    expect(registryPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(registryPlatform("linux", "arm64")).toBe("linux-aarch64");
    expect(registryPlatform("freebsd", "x64")).toBeNull();
    expect(registryPlatform("linux", "ia32")).toBeNull();
  });
});

describe("acpAgentsDir", () => {
  it("lives in the state folder", () => {
    expect(acpAgentsDir({ LU_MINAL_HOME: root })).toBe(path.join(root, "state", "acp-agents"));
  });
});

describe("fetchRegistryBinary", () => {
  it("returns the build for this platform", async () => {
    const { fetchImpl } = fakeFetch([entry()]);
    expect(await fetchRegistryBinary("antigravity-acp", { fetchImpl, ...linux })).toEqual({
      version: "1.4.5",
      archive: ARCHIVE_URL,
      cmd: "./agy_acp_server",
      args: ["--uid="],
      sha256: sha(ARCHIVE),
    });
  });

  it("explains a missing agent, an npx agent, a missing platform build and an HTTP error", async () => {
    const npx = { id: "other", name: "Other", version: "1.0.0", distribution: { npx: { package: "other" } } };
    const { fetchImpl } = fakeFetch([entry(), npx]);
    await expect(fetchRegistryBinary("nope", { fetchImpl, ...linux })).rejects.toThrow(/no agent "nope"/);
    await expect(fetchRegistryBinary("other", { fetchImpl, ...linux })).rejects.toThrow(/Other isn't distributed as a binary \(it uses npx\)/);
    await expect(fetchRegistryBinary("antigravity-acp", { fetchImpl, platform: "win32", arch: "x64" })).rejects.toThrow(
      /no build for this platform \(windows-x86_64\)/,
    );
    await expect(fetchRegistryBinary("antigravity-acp", { fetchImpl: fakeFetch([], { status: 404 }).fetchImpl, ...linux })).rejects.toThrow(/HTTP 404/);
  });
});

describe("installAcp", () => {
  it("downloads, unpacks and writes the manifest that installedAcp reads", async () => {
    const cdn = fakeFetch([entry()]);
    const unzip = fakeUnzip();
    const status: string[] = [];
    const got = await installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: unzip.run, onStatus: (l) => status.push(l), ...linux });
    const exe = path.join(root, "antigravity-acp", "1.4.5", "agy_acp_server");
    expect(got).toEqual({ exe, args: ["--uid="], version: "1.4.5" });
    expect(unzip.runs[0].exe).toBe("unzip");
    expect(fs.readFileSync(path.join(root, "antigravity-acp", "1.4.5", "localharness_external"), "utf8")).toBe("x");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "antigravity-acp", "installed.json"), "utf8"));
    expect(manifest).toEqual({ version: "1.4.5", exe: "antigravity-acp/1.4.5/agy_acp_server", args: ["--uid="] });
    expect(installedAcp("antigravity-acp", root)).toEqual(got);
    // Only the version folder and the manifest are left.
    expect(fs.readdirSync(path.join(root, "antigravity-acp")).sort()).toEqual(["1.4.5", "installed.json"]);
    expect(status).toContain("Downloading Google Antigravity 1.4.5: 100%");
    expect(status.at(-1)).toBe("Installed Google Antigravity 1.4.5.");
    if (process.platform !== "win32") expect(fs.statSync(exe).mode & 0o777).toBe(0o755);
  });

  it("finds nothing before an install, or when the exe is gone", async () => {
    expect(installedAcp("antigravity-acp", root)).toBeNull();
    const cdn = fakeFetch([entry()]);
    const got = await installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: fakeUnzip().run, ...linux });
    fs.rmSync(got.exe);
    expect(installedAcp("antigravity-acp", root)).toBeNull();
  });

  it("leaves nothing behind when the checksum doesn't match", async () => {
    const cdn = fakeFetch([entry({ sha256: "0".repeat(64) })]);
    const unzip = fakeUnzip();
    await expect(installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: unzip.run, ...linux })).rejects.toThrow(/doesn't match its checksum/);
    expect(unzip.runs).toHaveLength(0);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(installedAcp("antigravity-acp", root)).toBeNull();
  });

  it("reports a failed unpack and cleans up", async () => {
    const cdn = fakeFetch([entry()]);
    await expect(installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: fakeUnzip({}, 1).run, ...linux })).rejects.toThrow(
      /couldn't unpack .*\(unzip exit 1\)/i,
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("names unzip when it isn't installed", async () => {
    const cdn = fakeFetch([entry()]);
    const run = async () => {
      throw Object.assign(new Error("spawn unzip ENOENT"), { code: "ENOENT" });
    };
    await expect(installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run, ...linux })).rejects.toThrow(/`unzip` isn't installed/);
  });

  it("uses tar on Windows and ditto on macOS", async () => {
    const binary = {
      "windows-x86_64": { archive: ARCHIVE_URL, cmd: "./agy_acp_server.exe", sha256: sha(ARCHIVE) },
      "darwin-aarch64": { archive: ARCHIVE_URL, cmd: "./agy_acp_server", sha256: sha(ARCHIVE) },
    };
    const seen: string[] = [];
    const run = async (exe: string, args: string[]) => {
      seen.push(exe);
      const dir = args.at(-1) as string;
      fs.writeFileSync(path.join(dir, "agy_acp_server.exe"), "");
      fs.writeFileSync(path.join(dir, "agy_acp_server"), "");
      return 0;
    };
    const cdn = fakeFetch([entry({ binary })]);
    const win = await installAcp("antigravity-acp", path.join(root, "w"), { fetchImpl: cdn.fetchImpl, run, platform: "win32", arch: "x64" });
    expect(win.args).toEqual([]);
    await installAcp("antigravity-acp", path.join(root, "m"), { fetchImpl: cdn.fetchImpl, run, platform: "darwin", arch: "arm64" });
    expect(seen[0]).toMatch(/System32[\\/]tar\.exe$/);
    expect(seen[1]).toBe("/usr/bin/ditto");
  });

  it("refuses a command that leaves the version folder, before downloading", async () => {
    for (const cmd of ["../evil", "./bin/../../evil", "/usr/bin/evil", "C:\\Windows\\evil.exe"]) {
      const cdn = fakeFetch([entry({ cmd })]);
      await expect(installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: fakeUnzip().run, ...linux })).rejects.toThrow(/points outside its folder/);
      expect(cdn.downloads()).toBe(0);
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("doesn't download the version that is already installed", async () => {
    const cdn = fakeFetch([entry()]);
    const unzip = fakeUnzip();
    const first = await installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: unzip.run, ...linux });
    const again = await installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: unzip.run, ...linux });
    expect(again).toEqual(first);
    expect(cdn.downloads()).toBe(1);
    expect(unzip.runs).toHaveLength(1);
  });

  it("removes older version folders after installing a newer one", async () => {
    const unzip = fakeUnzip();
    await installAcp("antigravity-acp", root, { fetchImpl: fakeFetch([entry({ version: "1.4.5" })]).fetchImpl, run: unzip.run, ...linux });
    const got = await installAcp("antigravity-acp", root, { fetchImpl: fakeFetch([entry({ version: "1.5.0" })]).fetchImpl, run: unzip.run, ...linux });
    expect(got.version).toBe("1.5.0");
    expect(fs.readdirSync(path.join(root, "antigravity-acp")).sort()).toEqual(["1.5.0", "installed.json"]);
    expect(installedAcp("antigravity-acp", root)?.exe).toBe(path.join(root, "antigravity-acp", "1.5.0", "agy_acp_server"));
  });

  it("shares one download between concurrent calls", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const cdn = fakeFetch([entry()], { gate });
    const unzip = fakeUnzip();
    const a = installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: unzip.run, ...linux });
    const b = installAcp("antigravity-acp", root, { fetchImpl: cdn.fetchImpl, run: unzip.run, ...linux });
    expect(b).toBe(a);
    open();
    expect(await b).toEqual(await a);
    expect(cdn.downloads()).toBe(1);
    expect(unzip.runs).toHaveLength(1);
  });
});
