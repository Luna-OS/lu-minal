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
    await runCommandLine(t.ctx, "/remote message and push it");
    expect(t.send).toHaveBeenLastCalledWith(older, "and push it");
  });
});

describe("/web", () => {
  const ESC = "\u001b";
  const BEL = "\u0007";
  /** A hub in a window with a web pane (pane: true) or in any other terminal, with a fake terminal and browser. */
  function setup(pane: boolean) {
    const hub = makeHub();
    const written: string[] = [];
    const opened: string[] = [];
    hub.web = {
      env: pane ? { LU_MINAL_WEB_PANE: "1" } : {},
      out: { write: (data: string) => void written.push(data) },
      open: (url: string) => void opened.push(url),
    };
    const ctx = { hub, project: undefined, agent: undefined } as CommandContext;
    return { hub, written, opened, ctx };
  }

  it("is its own command now, not /cloud's alias", () => {
    expect(findCommand("web")).toMatchObject({ name: "web", args: "[show|hide|<claude.ai link>]" });
    expect(findCommand("website")).toBe(findCommand("web"));
    expect(findCommand("cloud")?.aliases).not.toContain("web");
    expect(commandSuggestions("we").map((c) => c.name)).toContain("web");
  });

  it("toggles, shows and hides the pane beside the terminal and opens claude.ai links there", async () => {
    const t = setup(true);
    await runCommandLine(t.ctx, "/web");
    await runCommandLine(t.ctx, "/web show");
    await runCommandLine(t.ctx, "/web hide");
    await runCommandLine(t.ctx, "/web toggle");
    await runCommandLine(t.ctx, "/web https://claude.ai/code/session_01Abc");
    await runCommandLine(t.ctx, "/web claude.ai/code/session_01Def");
    await runCommandLine(t.ctx, "/web session_01Ghijk");
    expect(t.written).toEqual([
      `${ESC}]7701;toggle${BEL}`,
      `${ESC}]7701;show${BEL}`,
      `${ESC}]7701;hide${BEL}`,
      `${ESC}]7701;toggle${BEL}`,
      `${ESC}]7701;open;https://claude.ai/code/session_01Abc${BEL}`,
      `${ESC}]7701;open;https://claude.ai/code/session_01Def${BEL}`,
      `${ESC}]7701;open;https://claude.ai/code/session_01Ghijk${BEL}`,
    ]);
    expect(t.opened).toEqual([]);
    expect(t.hub.toasts).toEqual([]);
  });

  it("opens no other site, there or in the browser", async () => {
    for (const pane of [true, false]) {
      const t = setup(pane);
      for (const bad of ["https://evil.com/", "https://claude.ai.evil.com/", "https://claude.ai@evil.com/", "evil.com/claude.ai", "http://claude.ai/"]) {
        await runCommandLine(t.ctx, `/web ${bad}`);
        expect(t.hub.toasts.at(-1)).toMatchObject({ level: "warning" });
        expect(t.hub.toasts.at(-1)?.text).toContain("only claude.ai pages");
      }
      expect(t.written).toEqual([]);
      expect(t.opened).toEqual([]);
    }
  });

  it("opens claude.ai/code in the browser without a pane, saying where it opens beside the terminal", async () => {
    const t = setup(false);
    await runCommandLine(t.ctx, "/web");
    expect(t.opened).toEqual(["https://claude.ai/code"]);
    expect(t.hub.toasts.at(-1)).toMatchObject({
      level: "info",
      text: "Opened claude.ai/code in the browser - in the lu-minal app on macOS and Windows it opens beside the terminal.",
    });
    await runCommandLine(t.ctx, "/web show");
    await runCommandLine(t.ctx, "/web https://claude.ai/code/session_01Abc");
    expect(t.opened).toEqual(["https://claude.ai/code", "https://claude.ai/code", "https://claude.ai/code/session_01Abc"]);
    expect(t.hub.toasts.at(-1)?.text).toContain("Opened claude.ai/code/session_01Abc in the browser");
    // Nothing to hide here; and never a sequence for a terminal that has no pane.
    await runCommandLine(t.ctx, "/web hide");
    expect(t.opened).toHaveLength(3);
    expect(t.hub.toasts.at(-1)?.text).toBe("No web pane in this terminal - in the lu-minal app on macOS and Windows it opens beside the terminal.");
    expect(t.written).toEqual([]);
  });
});
