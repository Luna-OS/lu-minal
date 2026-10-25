// lu-minal's version: package.json's, or the one the standalone binaries bake in at build time.
// LU_MINAL_VERSION is what the installers read ("which release to install") and must not change it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PKG_VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("lu-minal's version", () => {
  it("--version prints package.json's version, whatever LU_MINAL_VERSION says", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "cli.tsx"), "--version"], {
      cwd: ROOT,
      env: { ...process.env, LU_MINAL_VERSION: "9.9.9" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(PKG_VERSION);
  }, 60_000);

  it("is what the MCP server tells Claude Code (not 'dev')", () => {
    vi.stubEnv("LU_MINAL_VERSION", undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-version-"));
    dirs.push(dir);
    const hub = new Hub({
      config: defaultConfig(),
      configPath: null,
      auth: new AuthStore(path.join(dir, "auth.json")),
      themes: new ThemeManager({ dir: path.join(dir, "themes") }),
      cacheDir: dir,
      stateDir: dir,
      offline: true,
      servers: false,
    });
    expect((hub.mcp as unknown as { opts: { version?: string } }).opts.version).toBe(PKG_VERSION);
  });

  it("is baked into the binaries under a name no installer reads", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts", "build-binaries.ts"), "utf8");
    expect(script).toContain('"process.env.LU_MINAL_BUILD_VERSION": JSON.stringify(opts.version)');
    for (const file of ["src/cli.tsx", "src/version.ts", "src/core/hub.ts", "src/agents/acp/driver.ts", "scripts/build-binaries.ts"]) {
      const text = fs.existsSync(path.join(ROOT, file)) ? fs.readFileSync(path.join(ROOT, file), "utf8") : "";
      expect(text, file).not.toContain("process.env.LU_MINAL_VERSION");
    }
  });
});
