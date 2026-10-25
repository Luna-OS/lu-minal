// Builds lu-minal's standalone binaries with Bun (`bun build --compile`), one per release target:
// lu-minal-<os>-<arch>[-musl][.exe] in dist-bin/, plus SHA256SUMS. Cross-compiles every target from
// any host; Windows version info (publisher, version, description) is only embedded when the
// Windows binaries are built on Windows, so the release workflow builds those on windows-latest.
//
//   bun scripts/build-binaries.ts                       all targets
//   bun scripts/build-binaries.ts --target=host         this machine only
//   bun scripts/build-binaries.ts --target=linux-x64,windows-x64 --outdir=dist-bin
//   bun scripts/build-binaries.ts --entry=src/cli.tsx --version=0.2.0 --smoke
//
// Options: --target=<list> (all, host, an OS, or names like linux-arm64-musl), --outdir=<dir>
// (default dist-bin), --entry=<file> (default src/cli.tsx), --version=<v> (default package.json),
// --smoke (run this machine's binary with --version afterwards), --no-minify, --list, --help.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseTarget } from "../src/platform/install-info.js";

/** The part of Bun's API this script uses (no @types/bun in this repo). */
interface BunBuildOutput {
  success: boolean;
  outputs: { path: string; kind: string }[];
  logs: unknown[];
}
interface BunLike {
  version: string;
  build(config: Record<string, unknown>): Promise<BunBuildOutput>;
}

if (!(globalThis as { Bun?: unknown }).Bun) {
  process.stderr.write("build-binaries: this script needs Bun (https://bun.sh): run `bun scripts/build-binaries.ts`.\n");
  process.exit(1);
}

// Loaded after the Bun check: Node cannot resolve the ".js" import of a ".ts" file.
const { CHECKSUMS_FILE, formatChecksums, hostReleaseTarget, RELEASE_TARGETS, resolveTargets } = await import(
  "../src/platform/install-info.js"
);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEVTOOLS_STUB = path.join(ROOT, "scripts", "stubs", "react-devtools-core.js");

interface Options {
  targets: ReleaseTarget[];
  outdir: string;
  entry: string;
  version: string;
  minify: boolean;
  smoke: boolean;
}

function fail(message: string): never {
  process.stderr.write(`build-binaries: ${message}\n`);
  process.exit(1);
}

function readPackageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) fail("package.json has no version.");
  return pkg.version;
}

function parseOptions(argv: string[]): Options | null {
  const flags = new Map<string, string | true>();
  for (const a of argv) {
    if (!a.startsWith("--")) fail(`Unexpected argument "${a}" (options look like --target=linux-x64).`);
    const eq = a.indexOf("=");
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else flags.set(a.slice(2), true);
  }
  const known = new Set(["target", "targets", "outdir", "entry", "version", "smoke", "no-minify", "list", "help"]);
  for (const k of flags.keys()) if (!known.has(k)) fail(`Unknown option --${k}. Try --help.`);
  if (flags.has("help")) {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\nimport ")[0];
    process.stdout.write(`${head.replace(/^\/\/ ?/gm, "")}\n`);
    return null;
  }
  if (flags.has("list")) {
    for (const t of RELEASE_TARGETS) process.stdout.write(`${t.name.padEnd(18)} ${t.bunTarget.padEnd(30)} ${t.asset}\n`);
    return null;
  }
  const str = (k: string): string | undefined => {
    const v = flags.get(k);
    if (v === true) fail(`--${k} needs a value, e.g. --${k}=...`);
    return v;
  };
  let targets: ReleaseTarget[];
  try {
    targets = resolveTargets(str("target") ?? str("targets"));
  } catch (err) {
    fail((err as Error).message);
  }
  const version = (str("version") ?? readPackageVersion()).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version)) fail(`"${version}" is not a semantic version.`);
  return {
    targets,
    outdir: path.resolve(str("outdir") ?? path.join(ROOT, "dist-bin")),
    entry: path.resolve(str("entry") ?? path.join(ROOT, "src", "cli.tsx")),
    version,
    minify: !flags.has("no-minify"),
    smoke: flags.has("smoke"),
  };
}

/** Windows file version: four numbers, the pre-release part dropped. */
function windowsVersion(version: string): string {
  const [major, minor, patch] = version.split(/[-+]/)[0].split(".");
  return `${major}.${minor}.${patch}.0`;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** SHA256SUMS over every lu-minal-* asset in the output folder (so several runs add up). */
function writeChecksums(outdir: string): string {
  const assets = new Set(RELEASE_TARGETS.map((t) => t.asset));
  const entries = fs
    .readdirSync(outdir)
    .filter((f) => assets.has(f))
    .map((f) => ({ file: f, sha256: sha256File(path.join(outdir, f)) }));
  const file = path.join(outdir, CHECKSUMS_FILE);
  fs.writeFileSync(file, formatChecksums(entries));
  return file;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function buildTarget(bun: BunLike, t: ReleaseTarget, opts: Options): Promise<string> {
  const outfile = path.join(opts.outdir, t.asset);
  fs.rmSync(outfile, { force: true });
  const compile: Record<string, unknown> = { target: t.bunTarget, outfile };
  if (t.os === "windows" && process.platform === "win32") {
    compile.windows = {
      title: "lu-minal",
      publisher: "Luna-OS",
      version: windowsVersion(opts.version),
      description: "lu-minal - a team of coding agents under the night sky",
      copyright: "MIT License, Luna-OS",
    };
  }
  const result = await bun.build({
    entrypoints: [opts.entry],
    compile,
    minify: opts.minify,
    sourcemap: "none",
    define: {
      "process.env.LU_MINAL_VERSION": JSON.stringify(opts.version),
      "process.env.LU_MINAL_TARGET": JSON.stringify(t.name),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [
      {
        name: "lu-minal-stubs",
        setup(b: { onResolve(o: { filter: RegExp }, cb: () => { path: string }): void }) {
          // Ink's optional devtools: not a dependency, never used in a release build.
          b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: DEVTOOLS_STUB }));
        },
      },
    ],
  });
  if (!result.success) {
    const logs = result.logs.map((l) => String(l)).join("\n");
    throw new Error(`bun build failed for ${t.name}:\n${logs}`);
  }
  // Bun appends ".exe" itself for Windows targets when the name lacks it; find what it wrote.
  const written = result.outputs.find((o) => o.kind === "entry-point")?.path ?? outfile;
  if (path.resolve(written) !== outfile && fs.existsSync(written)) fs.renameSync(written, outfile);
  if (!fs.existsSync(outfile)) throw new Error(`bun build reported success but ${outfile} is missing.`);
  if (t.os !== "windows" && process.platform !== "win32") fs.chmodSync(outfile, 0o755);
  return outfile;
}

function smokeTest(file: string, version: string): void {
  const run = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 60_000 });
  if (run.error) fail(`smoke test: could not run ${file}: ${run.error.message}`);
  const out = `${run.stdout ?? ""}`.trim();
  if (run.status !== 0 || !out.includes(version)) {
    fail(`smoke test: ${path.basename(file)} --version exited ${run.status} with "${out}" (expected ${version}).\n${run.stderr ?? ""}`);
  }
  process.stdout.write(`smoke test: ${path.basename(file)} --version -> ${out}\n`);
}

async function main(): Promise<void> {
  const bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  const opts = parseOptions(process.argv.slice(2));
  if (!opts) return;
  if (!fs.existsSync(opts.entry) || !fs.statSync(opts.entry).isFile()) {
    fail(`entry not found: ${opts.entry} (pass --entry=<file> to build another entry).`);
  }
  if (!fs.existsSync(DEVTOOLS_STUB)) fail(`missing ${DEVTOOLS_STUB}.`);
  fs.mkdirSync(opts.outdir, { recursive: true });
  process.stdout.write(
    `lu-minal ${opts.version}: building ${opts.targets.length} binar${opts.targets.length === 1 ? "y" : "ies"} with Bun ${bun.version} into ${opts.outdir}\n`,
  );
  if (opts.targets.some((t) => t.os === "windows") && process.platform !== "win32") {
    process.stdout.write("note: Windows version info is only embedded when building on Windows.\n");
  }
  const built: string[] = [];
  for (const t of opts.targets) {
    const started = Date.now();
    try {
      const file = await buildTarget(bun, t, opts);
      built.push(file);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`  ${t.asset.padEnd(32)} ${formatSize(fs.statSync(file).size).padStart(9)}  ${secs}s\n`);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  const sums = writeChecksums(opts.outdir);
  process.stdout.write(`  ${path.basename(sums)}\n`);
  if (opts.smoke) {
    const host = hostReleaseTarget();
    const file = host ? built.find((f) => path.basename(f) === host.asset) : undefined;
    if (!file) fail(`--smoke: this machine's binary (${host?.asset ?? "none"}) was not built.`);
    smokeTest(file, opts.version);
  }
}

await main();
