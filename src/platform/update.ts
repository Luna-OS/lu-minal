// Updates: asks GitHub (at most once a day) whether a newer lu-minal is out, and installs it the
// way this copy was installed. A standalone binary is downloaded next to itself, checked against
// the release's SHA256SUMS and swapped in (on Windows the running exe is moved aside first, as
// install.ps1 and the setup do); a copy the Windows setup installed runs the newer setup silently,
// so Settings > Apps shows the new version; the macOS app gets its new bundle. npm and source
// installs only get the commands to run: lu-minal doesn't rewrite a checkout.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FetchLike } from "../providers/types.js";
import { CHECKSUMS_FILE, type InstallInfo, parseChecksums, RELEASE_BASE_URL, RELEASE_REPO, releaseDownloadUrl } from "./install-info.js";
import { runProgram } from "./process.js";

/** How often lu-minal asks GitHub on its own. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The newest release, as GitHub's API names it. */
export interface LatestRelease {
  version: string;
  url: string;
}

export interface UpdateCheck extends LatestRelease {
  /** Whether it is newer than the running copy. */
  newer: boolean;
}

/** "v1.2.3-rc.1" -> [1, 2, 3] and the pre-release part. */
function parseVersion(v: string): { core: number[]; pre: string } {
  const clean = v.trim().replace(/^v/i, "").split("+")[0];
  const dash = clean.indexOf("-");
  const core = (dash >= 0 ? clean.slice(0, dash) : clean).split(".").map((n) => Number.parseInt(n, 10) || 0);
  return { core, pre: dash >= 0 ? clean.slice(dash + 1) : "" };
}

/** Compares two versions like semver: negative when a is older, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return d;
  }
  // A release beats its own pre-releases.
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

/**
 * Asks GitHub for the newest release (not drafts or pre-releases): where github.com's
 * /releases/latest redirects to, which needs no API quota (60 requests an hour per IP address,
 * shared behind a company NAT or a VPN), else the API.
 */
export async function fetchLatestRelease(fetchImpl: FetchLike = fetch, userAgent = "lu-minal"): Promise<LatestRelease> {
  const headers = { "user-agent": userAgent };
  try {
    const page = await fetchImpl(`${RELEASE_BASE_URL}/latest`, { method: "HEAD", redirect: "manual", headers, signal: AbortSignal.timeout(15_000) });
    // A proxy may follow the redirect itself: then the response's own URL has the tag.
    const where = page.headers.get("location") || page.url || "";
    const tag = /\/releases\/tag\/(v?\d+\.\d+[^/?#]*)/.exec(where)?.[1];
    if (tag) return { version: decodeURIComponent(tag).replace(/^v/i, ""), url: `${RELEASE_BASE_URL}/tag/${tag}` };
  } catch {
    // try the API
  }
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { ...headers, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the newest release.`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== "string" || !/^v?\d+\.\d+/.test(body.tag_name)) throw new Error("GitHub's answer has no release version.");
  return {
    version: body.tag_name.replace(/^v/i, ""),
    url: typeof body.html_url === "string" ? body.html_url : `${RELEASE_BASE_URL}/latest`,
  };
}

export interface CheckOptions {
  /** The running version. */
  current: string;
  /** Where the last answer is kept (so lu-minal asks at most once a day). */
  cacheFile: string;
  fetchImpl?: FetchLike;
  /** Ask now, whatever the cache says; failures throw instead of returning null. */
  force?: boolean;
  now?: number;
}

/**
 * Whether a newer lu-minal is out. Uses the cached answer when it is less than a day old; a failed
 * request returns the cached answer, or null (and throws with `force`).
 */
export async function checkForUpdate(opts: CheckOptions): Promise<UpdateCheck | null> {
  const now = opts.now ?? Date.now();
  let cached: (LatestRelease & { checkedAt: number }) | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(opts.cacheFile, "utf8")) as Record<string, unknown>;
    if (typeof raw.version === "string" && typeof raw.url === "string" && typeof raw.checkedAt === "number") {
      cached = { version: raw.version, url: raw.url, checkedAt: raw.checkedAt };
    }
  } catch {
    // no answer yet
  }
  const result = (r: LatestRelease): UpdateCheck => ({ ...r, newer: compareVersions(r.version, opts.current) > 0 });
  if (!opts.force && cached && now - cached.checkedAt >= 0 && now - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) return result(cached);
  try {
    const latest = await fetchLatestRelease(opts.fetchImpl, `lu-minal/${opts.current}`);
    try {
      fs.mkdirSync(path.dirname(opts.cacheFile), { recursive: true });
      fs.writeFileSync(opts.cacheFile, `${JSON.stringify({ ...latest, checkedAt: now })}\n`);
    } catch {
      // asked again next time
    }
    return result(latest);
  } catch (err) {
    if (opts.force) throw err;
    return cached ? result(cached) : null;
  }
}

/** How this copy updates itself. */
export type UpdatePlan =
  | { kind: "binary"; asset: string; exe: string }
  | { kind: "windows-setup"; asset: string; exe: string }
  | { kind: "macos-app"; asset: string; app: string }
  | { kind: "manual"; commands: string[] };

/** Works out how to update this copy (see the file comment). */
export function updatePlan(info: InstallInfo, platform: string = process.platform, exists: (file: string) => boolean = fs.existsSync): UpdatePlan {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (info.kind === "macos-app") {
    const app = /^(.*?\.app)[\\/]Contents[\\/]/.exec(info.exe)?.[1];
    if (app) return { kind: "macos-app", asset: "lu-minal-macos-app.zip", app };
  }
  if ((info.kind === "binary" || info.kind === "macos-app") && info.asset) {
    // The setup leaves its uninstaller next to the exe.
    if (platform === "win32" && exists(pathApi.join(pathApi.dirname(info.exe), "unins000.exe"))) {
      return { kind: "windows-setup", asset: info.asset.replace(/\.exe$/i, "-setup.exe"), exe: info.exe };
    }
    return { kind: "binary", asset: info.asset, exe: info.exe };
  }
  // npm link / a checkout: the folder that holds package.json, two up from dist/cli.js.
  const script = info.args.at(-1) ?? "";
  let root = script ? pathApi.dirname(pathApi.dirname(script)) : "";
  try {
    if (root) root = pathApi.dirname(pathApi.dirname(fs.realpathSync(script)));
  } catch {
    // keep the path as given
  }
  const cd = root ? `cd ${/\s/.test(root) ? `"${root}"` : root}` : "cd <your lu-minal checkout>";
  return { kind: "manual", commands: [cd, "git pull", "npm ci", "npm run build"] };
}

export type UpdateStatus = (line: string) => void;

/**
 * Downloads a release file into `dest`, checking it against the release's SHA256SUMS (nothing is
 * left behind when it doesn't match).
 */
export async function downloadVerified(
  version: string,
  asset: string,
  dest: string,
  opts: { fetchImpl?: FetchLike; onStatus?: UpdateStatus; baseUrl?: string } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = (file: string) => (opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, "")}/${file}` : releaseDownloadUrl(file, version));
  const sums = await fetchImpl(url(CHECKSUMS_FILE), { signal: AbortSignal.timeout(30_000) });
  if (!sums.ok) throw new Error(`Could not download ${CHECKSUMS_FILE} for ${version} (HTTP ${sums.status}).`);
  const expected = parseChecksums(await sums.text()).get(asset);
  if (!expected) throw new Error(`${asset} is not in the ${version} release's ${CHECKSUMS_FILE}.`);

  const res = await fetchImpl(url(asset), { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Could not download ${asset} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = await fsp.open(dest, "w", 0o755);
  let done = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      await out.write(chunk);
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : -1;
      if (pct >= 0 && pct >= shown + 10) {
        shown = pct - (pct % 10);
        opts.onStatus?.(`Downloading ${asset}: ${shown}%`);
      }
    }
  } catch (err) {
    await out.close().catch(() => undefined);
    await fsp.rm(dest, { force: true });
    throw err;
  }
  await out.close();
  const actual = hash.digest("hex");
  if (actual !== expected) {
    await fsp.rm(dest, { force: true });
    throw new Error(`${asset} does not match ${CHECKSUMS_FILE} (got ${actual.slice(0, 12)}..., expected ${expected.slice(0, 12)}...): not installed.`);
  }
}

/**
 * Puts `fresh` (a file in the same folder) in place of `exe`. On Windows the running exe can't be
 * replaced but can be renamed: it moves aside to lu-minal.old-<id>.exe (removed on a later start).
 */
export function swapExecutable(fresh: string, exe: string, platform: string = process.platform): void {
  if (platform !== "win32") {
    fs.chmodSync(fresh, 0o755);
    fs.renameSync(fresh, exe);
    return;
  }
  const aside = path.join(path.dirname(exe), `lu-minal.old-${crypto.randomBytes(4).toString("hex")}.exe`);
  fs.renameSync(exe, aside);
  try {
    fs.renameSync(fresh, exe);
  } catch (err) {
    fs.renameSync(aside, exe);
    throw err;
  }
}

/** Removes the copies earlier updates moved aside on Windows (the ones still running stay). */
export function removeOldCopies(exe: string): void {
  const dir = path.dirname(exe);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^lu-minal\.old.*\.exe$/i.test(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // still running
    }
  }
}

export interface ApplyOptions {
  fetchImpl?: FetchLike;
  onStatus?: UpdateStatus;
  platform?: string;
  /** Runs a program and resolves its exit code (the setup, ditto); tests replace it. */
  run?: (exe: string, args: string[]) => Promise<number | null>;
  /** Download from here instead of GitHub (tests). */
  baseUrl?: string;
}

const runQuiet = async (exe: string, args: string[]): Promise<number | null> =>
  (await runProgram(exe, args, { timeoutMs: 10 * 60_000 })).code;

/**
 * Installs `version` as `plan` says. Resolves a line for the user ("restart lu-minal ..."), or
 * throws with what went wrong (the running copy is left as it was).
 */
export async function applyUpdate(plan: UpdatePlan, version: string, opts: ApplyOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runQuiet;
  const download = (asset: string, dest: string) =>
    downloadVerified(version, asset, dest, { fetchImpl: opts.fetchImpl, onStatus: opts.onStatus, baseUrl: opts.baseUrl });
  switch (plan.kind) {
    case "manual":
      throw new Error(`This copy runs from a checkout - update it with: ${plan.commands.join(" && ")}`);
    case "binary": {
      const fresh = path.join(path.dirname(plan.exe), `.lu-minal-update-${process.pid}${platform === "win32" ? ".exe" : ""}`);
      try {
        await download(plan.asset, fresh);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EPERM") {
          throw new Error(`Can't write to ${path.dirname(plan.exe)} - run the install script again to update (it may need sudo).`);
        }
        throw err;
      }
      try {
        swapExecutable(fresh, plan.exe, platform);
      } catch (err) {
        await fsp.rm(fresh, { force: true });
        throw err;
      }
      return `Updated to lu-minal ${version} - quit and start lu-minal again to use it (your tabs come back).`;
    }
    case "windows-setup": {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lu-minal-update-"));
      const setup = path.join(dir, plan.asset);
      try {
        await download(plan.asset, setup);
        opts.onStatus?.(`Installing lu-minal ${version}...`);
        // Silent: the folder and the tasks of the last install are kept.
        const code = await run(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
        if (code !== 0) throw new Error(`The lu-minal ${version} setup stopped with exit code ${code ?? "?"}.`);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      return `Updated to lu-minal ${version} - quit and start lu-minal again to use it (your tabs come back).`;
    }
    case "macos-app": {
      const parent = path.dirname(plan.app);
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lu-minal-update-"));
      try {
        const zip = path.join(dir, plan.asset);
        await download(plan.asset, zip);
        opts.onStatus?.(`Installing lu-minal ${version}...`);
        const unpacked = path.join(dir, "app");
        if ((await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked])) !== 0) throw new Error("Could not unpack the new app.");
        const bundle = fs.readdirSync(unpacked).find((n) => n.endsWith(".app"));
        if (!bundle) throw new Error("The download has no app in it.");
        // Next to the old one first (same volume, so the swap is two renames), then into place.
        const staged = path.join(parent, `.${path.basename(plan.app)}.update-${process.pid}`);
        const aside = path.join(parent, `.${path.basename(plan.app)}.old-${process.pid}`);
        try {
          await fsp.rm(staged, { recursive: true, force: true });
          await run("/usr/bin/ditto", [path.join(unpacked, bundle), staged]).then((code) => {
            if (code !== 0) throw new Error(`Could not copy the new app to ${parent}.`);
          });
          fs.renameSync(plan.app, aside);
          try {
            fs.renameSync(staged, plan.app);
          } catch (err) {
            fs.renameSync(aside, plan.app);
            throw err;
          }
        } catch (err) {
          await fsp.rm(staged, { recursive: true, force: true }).catch(() => undefined);
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EACCES" || code === "EPERM") throw new Error(`Can't write to ${parent} - download the new app from the releases page.`);
          throw err;
        }
        await fsp.rm(aside, { recursive: true, force: true }).catch(() => undefined);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      return `Updated LuMinal.app to ${version} - quit the app and open it again to use it (your tabs come back).`;
    }
  }
}
