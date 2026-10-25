// OpenCode's model list in the Hub: it is asked again after a sign-in (`opencode auth login` adds
// providers), also by `lu-minal login opencode-cli`, and it is found when the program is a script
// whose interpreter sits next to it but not on the inherited PATH (an app started from the Dock).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type Config } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const posix = process.platform !== "win32";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-acp-"));
  dirs.push(d);
  return d;
}

/**
 * A fake `opencode` in `dir/bin`: `models` prints models.txt, `auth login` adds a provider's model
 * to it. `shebang` is its first line.
 */
function fakeOpenCode(dir: string, shebang = "#!/bin/sh"): { exe: string; list: string } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const list = path.join(dir, "models.txt");
  fs.writeFileSync(list, "opencode/big-pickle\n");
  const exe = path.join(bin, "opencode");
  fs.writeFileSync(
    exe,
    `${shebang}\nif [ "$1" = "models" ]; then cat "${list}"; exit 0; fi\nif [ "$1" = "auth" ]; then echo "anthropic/claude-sonnet-5-5" >> "${list}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  return { exe, list };
}

/** A config whose OpenCode is `exe` (config.json's acpAgents override). */
function configWith(exe: string): Config {
  return { ...defaultConfig(), acpAgents: { "opencode-cli": { command: exe } } };
}

/** The PATH with `exe`'s folder first (the sign-in runs `opencode` from the PATH). */
const pathWith = (exe: string) => `${path.dirname(exe)}${path.delimiter}${process.env.PATH ?? ""}`;

function makeHub(dir: string, config: Config): Hub {
  return new Hub({
    config,
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: false,
    servers: false,
    fetchImpl: async () => {
      throw new Error("no network in tests");
    },
  });
}

describe.runIf(posix)("OpenCode's models in the Hub", () => {
  it("asks OpenCode again after the sign-in dialog ran `opencode auth login`", async () => {
    const dir = tempDir();
    const { exe, list } = fakeOpenCode(dir);
    vi.stubEnv("PATH", pathWith(exe));
    const hub = makeHub(dir, defaultConfig());
    const ids = () => hub.registry.models("opencode-cli").map((m) => m.id);
    await hub.refreshLocalModels();
    expect(ids()).toEqual(["default", "opencode/big-pickle"]);

    const ok = await hub.loginAcp("opencode-cli", async (file, args, opts) => spawnSync(file, args, { env: opts?.env }).status);
    expect(ok).toBe(true);
    expect(fs.readFileSync(list, "utf8")).toContain("anthropic/claude-sonnet-5-5");
    // The provider just signed in to shows up, although the cached list is not a day old.
    await vi.waitFor(() => expect(ids()).toContain("anthropic/claude-sonnet-5-5"), { timeout: 5000, interval: 50 });
  });

  it("finds the interpreter next to the program when the PATH doesn't have it", async () => {
    const dir = tempDir();
    // Like npm's shim: `#!/usr/bin/env node`, with node only next to the program.
    const { exe } = fakeOpenCode(dir, "#!/usr/bin/env lm-fake-node");
    fs.writeFileSync(path.join(path.dirname(exe), "lm-fake-node"), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const hub = makeHub(dir, configWith(exe));
    await hub.refreshLocalModels();
    expect(hub.registry.models("opencode-cli").map((m) => m.id)).toEqual(["default", "opencode/big-pickle"]);
  });

  it("`lu-minal login opencode-cli` drops the cached list, so the next start asks again", () => {
    const dir = tempDir();
    const { exe, list } = fakeOpenCode(dir);
    const cache = path.join(dir, "cache", "acp-models-opencode-cli.json");
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), models: [{ id: "opencode/big-pickle", provider: "opencode-cli" }] }));

    const run = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "cli.tsx"), "login", "opencode-cli"], {
      cwd: ROOT,
      env: { ...process.env, LU_MINAL_HOME: dir, PATH: pathWith(exe) },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(list, "utf8")).toContain("anthropic/claude-sonnet-5-5");
    expect(fs.existsSync(cache)).toBe(false);
  }, 60_000);
});
