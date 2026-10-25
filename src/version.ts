// lu-minal's version: baked into the standalone binaries at build time (scripts/build-binaries.ts
// defines LU_MINAL_BUILD_VERSION), read from package.json for source and npm installs. Not
// LU_MINAL_VERSION: that is what the installers read ("which release to install").
import fs from "node:fs";

function readVersion(): string {
  if (process.env.LU_MINAL_BUILD_VERSION) return process.env.LU_MINAL_BUILD_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
