// The slash commands as the prompt finds and runs them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";
import { commandSuggestions, findCommand, runCommandLine, type CommandContext } from "../../src/ui/commands.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeHub(): Hub {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-commands-"));
  dirs.push(dir);
  return new Hub({
    config: defaultConfig(),
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
}

describe("/yolo", () => {
  it("is one command with its aliases, listed for /help and the palette", () => {
    const yolo = findCommand("yolo");
    expect(yolo).toMatchObject({ name: "yolo", args: "[on|off]" });
    expect(findCommand("allow-all")).toBe(yolo);
    expect(findCommand("AutoApprove")).toBe(yolo);
    expect(commandSuggestions("yo")).toContain(yolo);
    expect(commandSuggestions("allow")).toContain(yolo);
  });

  it("turns everything on without a tab open, toggles back off, and takes on/off", async () => {
    const hub = makeHub();
    const ctx = { hub, project: undefined, agent: undefined } as CommandContext;
    expect(await runCommandLine(ctx, "/yolo")).toBe(true);
    expect(hub.config.permissionMode).toBe("yolo");
    expect(hub.toasts.at(-1)?.level).toBe("warning");
    // Already on: "on" keeps it on, a bare /yolo turns it off.
    await runCommandLine(ctx, "/autoapprove on");
    expect(hub.config.permissionMode).toBe("yolo");
    await runCommandLine(ctx, "/yolo");
    expect(hub.config.permissionMode).toBe("auto-edit");
    await runCommandLine(ctx, "/allow-all off");
    expect(hub.config.permissionMode).toBe("auto-edit");
    await runCommandLine(ctx, "/allow-all");
    expect(hub.allowingEverything).toBe(true);
  });
});
