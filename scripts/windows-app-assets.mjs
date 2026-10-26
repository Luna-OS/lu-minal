// Copies what the Windows window app (windows-app/) embeds from npm into windows-app/assets/
// (gitignored): xterm.js and its fit, unicode11 and WebGL addons (ES modules and the stylesheet,
// with their licence), plus the moon icon for the exe (scripts/windows-icon.ts, the installer's
// icon). Run it after `npm ci` and before `cargo build` in windows-app; build.rs stops with a
// pointer here when a file is missing.
//
//   node scripts/windows-app-assets.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "windows-app", "assets");

/** [package, file in the package, name in assets/]. */
const ASSET_FILES = [
  ["@xterm/xterm", "lib/xterm.mjs", "xterm.mjs"],
  ["@xterm/xterm", "css/xterm.css", "xterm.css"],
  ["@xterm/xterm", "LICENSE", "xterm-LICENSE.txt"],
  ["@xterm/addon-fit", "lib/addon-fit.mjs", "addon-fit.mjs"],
  ["@xterm/addon-unicode11", "lib/addon-unicode11.mjs", "addon-unicode11.mjs"],
  ["@xterm/addon-webgl", "lib/addon-webgl.mjs", "addon-webgl.mjs"],
];

function fail(message) {
  process.stderr.write(`windows-app-assets: ${message}\n`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });

for (const [name, file, dest] of ASSET_FILES) {
  const wanted = pkg.devDependencies?.[name];
  if (!wanted) fail(`${name} is not a devDependency in package.json.`);
  const dir = path.join(ROOT, "node_modules", ...name.split("/"));
  const src = path.join(dir, file);
  if (!fs.existsSync(src)) fail(`${path.relative(ROOT, src)} is missing - run npm ci first.`);
  const installed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
  if (installed !== wanted) fail(`${name} ${installed} is installed, package.json wants ${wanted} - run npm ci.`);
  let body = fs.readFileSync(src);
  // The source maps are not shipped: drop the comment that points to them.
  if (dest.endsWith(".mjs")) body = Buffer.from(body.toString("utf8").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n"));
  fs.writeFileSync(path.join(OUT, dest), body);
  process.stdout.write(`  ${dest.padEnd(22)} ${name}@${installed}\n`);
}

// The icon: the one build-binaries.ts drew on Windows, else drawn now (the same design).
const ico = path.join(OUT, "lu-minal.ico");
const built = path.join(ROOT, "dist-bin", "lu-minal.ico");
if (fs.existsSync(built)) {
  fs.copyFileSync(built, ico);
} else {
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join("scripts", "windows-icon.ts"), ico], { cwd: ROOT, encoding: "utf8" });
  if (run.status !== 0) fail(`could not draw the icon: ${run.error?.message ?? run.stderr}`);
}
process.stdout.write(`  ${"lu-minal.ico".padEnd(22)} scripts/windows-icon.ts\n`);
process.stdout.write(`windows-app-assets: ${path.relative(ROOT, OUT)} is ready.\n`);
