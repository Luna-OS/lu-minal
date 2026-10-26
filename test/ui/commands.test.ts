// The slash commands as the prompt finds and runs them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("/cloud", () => {
  function setup() {
    const hub = makeHub();
    // Never run: sendCloud is faked below.
    hub.config.claudePath = process.execPath;
    const send = vi.spyOn(hub, "sendCloud").mockResolvedValue({ ok: true, sessionId: null, url: null, error: null });
    const cloud = vi.fn();
    const project = { cwd: "/work/lu-minal" } as never;
    const ctx = { hub, project, agent: undefined, dialogs: { cloud } } as unknown as CommandContext;
    return { hub, send, cloud, project, ctx };
  }

  it("opens the dialog without arguments, and takes msg <text> from the prompt", async () => {
    const t = setup();
    expect(findCommand("cloud")?.args).toBe("[msg <text>]");
    await runCommandLine(t.ctx, "/cloud");
    expect(t.cloud).toHaveBeenCalledTimes(1);
    await runCommandLine(t.ctx, "/cloud msg ship it");
    expect(t.send).not.toHaveBeenCalled();
    expect(t.hub.toasts.at(-1)).toMatchObject({ level: "warning", text: "No cloud session yet - /cloud starts one or adds one by its link." });
    await runCommandLine(t.ctx, "/cloud msg");
    expect(t.hub.toasts.at(-1)?.text).toContain("Usage: /cloud msg <text>");
    expect(t.cloud).toHaveBeenCalledTimes(1);
  });

  it("writes to the session used last in /cloud, else the newest", async () => {
    const t = setup();
    const older = t.hub.addCloudSession(t.project, "Update the docs", "https://claude.ai/code/session_01Older")!;
    older.startedAt -= 60_000;
    const newer = t.hub.addCloudSession(t.project, "Fix the login test", "https://claude.ai/code/session_01Newer")!;
    t.hub.pickedCloudId = null;
    await runCommandLine(t.ctx, "/cloud msg also add a test\nfor the empty case");
    expect(t.send).toHaveBeenLastCalledWith(newer, "also add a test\nfor the empty case");
    expect(t.hub.toasts.at(-1)).toMatchObject({ level: "success", text: 'Sent to "Fix the login test" - queued as the cloud session\'s next message.' });
    // Teleporting, watching, opening or messaging one in /cloud makes it the one.
    t.hub.pickedCloudId = older.id;
    await runCommandLine(t.ctx, "/web message and push it");
    expect(t.send).toHaveBeenLastCalledWith(older, "and push it");
  });
});
