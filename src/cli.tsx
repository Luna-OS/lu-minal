#!/usr/bin/env node
// lu-minal's entry point: the terminal UI, plus a few sub-commands that work without it
// (models, providers, login, roblox, themes, setup).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink";
import React from "react";
import { forgetAcpModels } from "./agents/acp/models.js";
import { acpEnv, findAcpAgent, findAcpProgram } from "./agents/acp/presets.js";
import { readClaudeAccount } from "./agents/claude-code/account.js";
import { findClaude } from "./agents/claude-code/cli.js";
import { claudeLoginArgs } from "./agents/claude-code/login.js";
import { configFile, loadConfig } from "./core/config.js";
import { errText, Hub } from "./core/hub.js";
import { cacheDir, configDir, expandHome, samePath, stateDir } from "./platform/paths.js";
import { findProgram, openExternal, spawnProgram } from "./platform/process.js";
import { launchCommand } from "./platform/install-info.js";
import { installWindowsTerminalProfile, removeWindowsTerminalProfile } from "./platform/windows-terminal.js";
import { AuthStore } from "./providers/auth.js";
import { loadCatalog } from "./providers/catalog.js";
import { formatModelRef, parseModelRef } from "./providers/models.js";
import { startOpenRouterLogin } from "./providers/openrouter.js";
import { ProviderRegistry } from "./providers/registry.js";
import { installPlugin, robloxPluginsDir } from "./roblox/install.js";
import { bridgeToken } from "./roblox/token.js";
import { ThemeManager } from "./themes/manager.js";
import { App } from "./ui/App.js";
import { VERSION } from "./version.js";

// `lu-minal models | head` closes the pipe early: end quietly instead of crashing with EPIPE
// (Node throws an unhandled 'error' event; the Bun binaries print a stack trace and exit 1).
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

const HELP = `lu-minal ${VERSION} - a team of coding agents under the night sky

Usage
  lu-minal [folder]              open lu-minal: your last session comes back, plus the folder
  lu-minal --fresh [folder]      start without the last session's tabs
  lu-minal models [query] [--free]   list models (all providers from models.dev)
  lu-minal providers             list providers and whether you are signed in
  lu-minal login <provider> [key]    sign in (claude, openrouter, opencode-cli, gemini-cli, or save an API key)
  lu-minal logout <provider>     forget a provider's key
  lu-minal roblox install        install the Roblox Studio plugin
  lu-minal roblox path           print the Roblox plugins folder
  lu-minal themes                list themes
  lu-minal setup windows-terminal [--remove]   add (or remove) a Windows Terminal profile

Options
  --model <provider/model>       the lead's model (e.g. claude-code/opus, opencode/big-pickle)
  --theme <name>                 start with this theme (default: moon)
  --no-sky                       no animated sky
  --offline                      don't download the model catalog
  -v, --version                  print the version
  -h, --help                     this help
`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (["model", "theme"].includes(a.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith("-")) flags.set(a.slice(2), argv[++i]);
      else flags.set(a.slice(2), true);
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) flags.set({ c: "continue", v: "version", h: "help" }[ch] ?? ch, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function registryFor(offline: boolean): Promise<ProviderRegistry> {
  const config = loadConfig();
  const auth = AuthStore.default();
  const catalog = await loadCatalog({ cacheDir: cacheDir(), offline });
  const exe = findClaude(config.claudePath);
  const account = await readClaudeAccount(exe).catch(() => null);
  return new ProviderRegistry({ catalog, auth, config, claudeAccount: () => account });
}

function print(line = ""): void {
  process.stdout.write(`${line}\n`);
}

async function runInherit(exe: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProgram>;
    try {
      child = spawnProgram(exe, args, { stdio: "inherit", env });
    } catch {
      // spawnProgram refuses a batch file whose arguments cmd.exe would cut (a line break).
      resolve(null);
      return;
    }
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code));
  });
}

async function subcommand(args: Args): Promise<number | null> {
  const [cmd, ...rest] = args.positional;
  const offline = args.flags.has("offline");
  switch (cmd) {
    case "models": {
      const registry = await registryFor(offline);
      const query = rest.join(" ");
      let models = query ? registry.search(query, 500) : registry.providers().flatMap((p) => registry.models(p.id));
      if (args.flags.has("free")) models = models.filter((m) => m.free);
      for (const m of models) {
        const ok = registry.isConnected(m.provider) ? "✓" : " ";
        const price = m.free ? "free" : m.cost ? `$${m.cost.input}/$${m.cost.output}` : "";
        print(`${ok} ${formatModelRef({ provider: m.provider, model: m.id }).padEnd(56)} ${price}`);
      }
      print(`\n${models.length} models · ✓ = ready to use`);
      return 0;
    }
    case "providers": {
      const registry = await registryFor(offline);
      for (const p of registry.providers()) {
        const ok = registry.isConnected(p.id) ? "✓" : p.supported || p.kind === "claude-code" ? "○" : "-";
        print(`${ok} ${p.id.padEnd(28)} ${p.name}${p.supported || p.kind === "claude-code" ? "" : " (unsupported)"}`);
      }
      return 0;
    }
    case "login": {
      const id = rest[0];
      if (!id) {
        print("Usage: lu-minal login <provider> [key]   (claude, openrouter, opencode, anthropic, minimax, ...)");
        return 1;
      }
      if (id === "claude" || id === "claude-code") {
        const exe = findClaude(loadConfig().claudePath);
        if (!exe) {
          print("Claude Code is not installed. Install it (https://claude.com/claude-code) or run lu-minal and press ctrl+l.");
          return 1;
        }
        return runInherit(exe, claudeLoginArgs());
      }
      const acp = findAcpAgent(id, loadConfig());
      if (acp) {
        const exe = findAcpProgram(acp);
        if (!exe) {
          print(`${acp.name} is not installed.${acp.install ? ` Install it: ${acp.install}` : ""}`);
          return 1;
        }
        if (!acp.login) {
          print(acp.signIn);
          return 0;
        }
        const loginExe = acp.login.command === acp.command ? exe : (findProgram(acp.login.command) ?? acp.login.command);
        const code = await runInherit(loginExe, acp.login.args, acpEnv(acp));
        // The sign-in may have added providers: the next start asks for the models again.
        if (code === 0) forgetAcpModels(acp, cacheDir());
        return code;
      }
      const auth = AuthStore.default();
      if (rest[1]) {
        auth.set(id, { type: "api", key: rest[1] });
        print(`Saved the key for ${id}.`);
        return 0;
      }
      if (id === "openrouter") {
        const login = await startOpenRouterLogin();
        print("Open this link to sign in to OpenRouter:");
        print(login.url);
        void openExternal(login.url);
        try {
          const key = await login.result;
          auth.set("openrouter", { type: "oauth", key, createdAt: Date.now() });
          print("Signed in to OpenRouter.");
          return 0;
        } catch (err) {
          print(`Sign-in failed: ${errText(err)}`);
          return 1;
        }
      }
      print(`Usage: lu-minal login ${id} <api-key>`);
      return 1;
    }
    case "logout": {
      if (!rest[0]) return 1;
      AuthStore.default().remove(rest[0]);
      print(`Removed ${rest[0]}.`);
      return 0;
    }
    case "roblox": {
      const sub = rest[0] ?? "install";
      if (sub === "path") {
        print(robloxPluginsDir() ?? "No Roblox plugins folder found (set LU_MINAL_ROBLOX_PLUGINS).");
        return 0;
      }
      if (sub === "install") {
        try {
          const file = await installPlugin({ port: loadConfig().roblox.port, token: bridgeToken() });
          print(`Installed the lu-minal plugin: ${file}`);
          print("Open Roblox Studio, allow HTTP requests to localhost when asked, and click Connect on the lu-minal toolbar.");
          return 0;
        } catch (err) {
          print(errText(err));
          return 1;
        }
      }
      print("Usage: lu-minal roblox install|path");
      return 1;
    }
    case "themes": {
      const themes = new ThemeManager({ dir: path.join(configDir(), "themes") });
      for (const t of themes.list()) print(`${t.name.padEnd(20)} ${t.label}${t.builtin ? "" : " (custom)"}`);
      return 0;
    }
    case "setup": {
      if (rest[0] === "windows-terminal") {
        if (args.flags.has("remove")) {
          await removeWindowsTerminalProfile();
          print("Removed the lu-minal profile from Windows Terminal.");
          return 0;
        }
        const launch = launchCommand();
        const file = await installWindowsTerminalProfile(launch.exe, { args: launch.args });
        print(`Added the lu-minal profile to Windows Terminal: ${file}`);
        return 0;
      }
      print("Usage: lu-minal setup windows-terminal");
      return 1;
    }
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("version")) return void print(VERSION);
  if (args.flags.has("help")) return void process.stdout.write(HELP);
  const sub = await subcommand(args);
  if (sub !== null) {
    process.exitCode = sub;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const mintty =
      process.platform === "win32" && process.env.MSYSTEM
        ? " In Git Bash's own window (mintty) Windows programs get no console: run `winpty lu-minal`, or start lu-minal in Windows Terminal."
        : "";
    process.stderr.write(`lu-minal needs an interactive terminal.${mintty} Run lu-minal --help for the sub-commands.\n`);
    process.exitCode = 1;
    return;
  }

  const folder = args.positional[0] ? path.resolve(expandHome(args.positional[0])) : process.cwd();
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    process.stderr.write(`Not a folder: ${folder}\n`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  if (args.flags.has("no-sky")) config.sky.enabled = false;
  const themeFlag = args.flags.get("theme");
  const themes = new ThemeManager({
    dir: path.join(configDir(), "themes"),
    initial: typeof themeFlag === "string" ? themeFlag : config.theme,
  });
  const hub = new Hub({
    config,
    configPath: configFile(),
    auth: AuthStore.default(),
    themes,
    cacheDir: cacheDir(),
    stateDir: stateDir(),
    offline: args.flags.has("offline"),
  });

  const setTitle = (title: string) => process.stdout.write(`\u001b]0;${title}\u0007`);
  setTitle("lu-minal");

  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    setTitle("");
    // Let Ink restore the screen first.
    setTimeout(() => process.exit(0), 50);
  };
  const instance = render(<App hub={hub} onExit={done} />, {
    alternateScreen: true,
    incrementalRendering: true,
    exitOnCtrlC: false,
    maxFps: 30,
    kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] },
  });
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      void hub.dispose().finally(() => {
        instance.unmount();
        done();
      });
    });
  }

  // Read the last session before anything can overwrite it.
  const saved = args.flags.has("fresh") ? null : hub.readSavedSession();
  await hub.init();
  const modelFlag = args.flags.get("model");
  const lead = typeof modelFlag === "string" ? parseModelRef(modelFlag) ?? undefined : undefined;
  const restored = saved ? await hub.restoreSession(saved) : 0;
  const existing = hub.projects.findIndex((p) => samePath(p.cwd, folder));
  if (existing >= 0) {
    hub.switchTo(existing);
  } else if (!restored || args.positional[0] || !samePath(folder, os.homedir())) {
    // A folder of its own (or nothing restored): open it next to the restored tabs.
    try {
      await hub.openProject({ cwd: folder, lead });
    } catch (err) {
      hub.toast(errText(err), "error");
    }
  }
  if (restored) hub.toast(`Welcome back - ${restored} tab${restored === 1 ? "" : "s"} restored.`, "success");
  let lastTitle = "";
  hub.notifier.subscribe(() => {
    const p = hub.activeProject;
    const title = p ? `lu-minal · ${p.name}` : "lu-minal";
    if (title !== lastTitle) setTitle((lastTitle = title));
  });
  await instance.waitUntilExit();
  done();
}

main().catch((err) => {
  process.stderr.write(`lu-minal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
