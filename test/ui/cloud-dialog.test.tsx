// The /cloud dialog in a terminal of a real size: everything happens in the terminal (Claude Code's
// own picker, teleport, watch, messages typed right in the dialog); the browser is only "o". The
// terminal is a fake runInTerminal and the browser a fake opener: no real claude, git or browser.
import { Box } from "ink";
import React, { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_HOME, type CloudSession } from "../../src/cloud/claude-cloud.js";
import type { Hub } from "../../src/core/hub.js";
import { LIVE_NOTE, linkPromptLines, openCloudDialog, sessionDetails, WATCH_NOTE } from "../../src/ui/dialogs/cloud.js";
import { addProject, fakeUi, KEYS, renderAt, testHub } from "./ink-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** Re-renders on every hub change, like the app does. */
function Live({ hub, render }: { hub: Hub; render: () => React.ReactNode }) {
  useSyncExternalStore(
    (cb) => hub.notifier.subscribe(cb),
    () => hub.notifier.snapshot,
  );
  return <>{render()}</>;
}

const SIZE = { columns: 120, rows: 36 };

function setup() {
  const t = testHub();
  cleanups.push(t.cleanup);
  // Never started: the terminal below is fake.
  t.hub.config.claudePath = process.execPath;
  const { project } = addProject(t.hub, t.dir);
  const calls: Array<{ exe: string; args: string[]; cwd?: string }> = [];
  const ui = {
    ...fakeUi(),
    runInTerminal: async (exe: string, args: string[], opts?: { cwd?: string }) => {
      calls.push({ exe, args, cwd: opts?.cwd });
      return 0;
    },
  };
  const opened: string[] = [];
  /** What claude itself was given (the shell that waits after a failure stands in front of it). */
  const claudeArgs = (i: number) => {
    const c = calls[i];
    return c.exe === process.execPath ? c.args : c.args.slice(c.args.indexOf(process.execPath) + 1);
  };
  const remember = (task: string, id: string, extra: Partial<CloudSession> = {}) => {
    const s = t.hub.addCloudSession(project, task, `https://claude.ai/code/${id}`)!;
    Object.assign(s, extra);
    return s;
  };
  const open = () => {
    openCloudDialog(t.hub, ui, { open: (url) => void opened.push(url), readiness: async () => null });
    return showTop();
  };
  /** Renders the top dialog (dialogs are drawn over a full screen). */
  const showTop = () => {
    const spec = ui.dialogs.at(-1)!;
    const r = renderAt(
      <Box width={SIZE.columns} height={SIZE.rows}>
        <Live hub={t.hub} render={() => spec.render(() => ui.closeDialog())} />
      </Box>,
      SIZE,
    );
    cleanups.push(r.unmount);
    return r;
  };
  return { ...t, project, ui, calls, opened, claudeArgs, remember, open, showTop };
}

describe("the /cloud dialog", () => {
  it("offers terminal actions only, says where live progress is, and shows each session's task, age, last message and error", async () => {
    const t = setup();
    const now = Date.now();
    t.remember("Update the API documentation", "session_01Docs", { startedAt: now - 3 * 3600_000 });
    t.remember("Fix the flaky login test", "session_01Login", {
      startedAt: now - 2 * 3600_000,
      lastMessageAt: now - 5 * 60_000,
      lastError: "Error: failed to send message to cloud session session_01Login: cloud session session_01Login is archived and cannot accept new messages",
    });
    const r = t.open();
    await r.waitFor((s) => s.includes("Claude cloud"), "the dialog");
    const screen = r.screen();
    for (const text of ["✦ New cloud session…", "All my cloud sessions…", "claude --teleport: browse them all, pull one in", "Add a session by its link…", LIVE_NOTE]) {
      expect(screen).toContain(text);
    }
    // No browser in the list; "o" is only a key.
    expect(screen).not.toMatch(/Open claude\.ai\/code|Open in the browser/);
    expect(screen).toContain("o claude.ai/code in the browser");
    const rows = screen.split("\n");
    const login = rows.find((l) => l.includes("Fix the flaky login test"))!;
    expect(login).toContain("started 2h ago · messaged 5m ago · ✗ Cloud session is archived");
    expect(login).toContain("✗");
    const docs = rows.find((l) => l.includes("Update the API documentation"))!;
    expect(docs).toContain("started 3h ago · no follow-up yet");
    expect(docs).toContain("☁");
  });

  it("runs Claude Code's picker of every cloud session (claude --teleport) in the real terminal, in the project's folder", async () => {
    const t = setup();
    const r = t.open();
    await r.waitFor((s) => s.includes("All my cloud sessions…"), "the dialog");
    await r.press(KEYS.down);
    expect(r.screen()).toContain("Claude Code's picker of every cloud session you have");
    await r.press(KEYS.enter);
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.claudeArgs(0)).toEqual(["--teleport"]);
    expect(t.calls[0].cwd).toBe(t.project.cwd);
    // Back from the terminal, the dialog is still there.
    expect(t.ui.dialogs).toHaveLength(1);
  });

  it("teleports with t, watches with w (saying not every account can, t works for everyone), opens only on o and forgets with x", async () => {
    const t = setup();
    const s = t.remember("Fix the flaky login test", "session_01Login");
    const r = t.open();
    await r.waitFor((x) => x.includes("Fix the flaky login test"), "the session");
    for (let i = 0; i < 3; i++) await r.press(KEYS.down);
    const screen = r.screen();
    expect(screen).toContain(WATCH_NOTE);
    expect(screen).toContain("enter message · t teleport · w watch · o browser · x forget · esc close");
    await r.press("t");
    await r.press("w");
    await vi.waitFor(() => expect(t.calls).toHaveLength(2));
    expect([t.claudeArgs(0), t.claudeArgs(1)]).toEqual([
      ["--teleport", s.id],
      ["--cloud", s.id],
    ]);
    expect(t.opened).toEqual([]);
    await r.press("o");
    expect(t.opened).toEqual([s.url]);
    await r.press("x");
    expect(t.hub.cloudSessions).toEqual([]);
    await r.waitFor((x) => !x.includes("Fix the flaky login test"), "the session to go");
  });

  it("opens claude.ai/code on o only while no session is highlighted", async () => {
    const t = setup();
    const r = t.open();
    await r.waitFor((s) => s.includes("Claude cloud"), "the dialog");
    await r.press("o");
    expect(t.opened).toEqual([CLOUD_HOME]);
  });

  it("types a message right in the dialog on enter (or m), sends it with -p --cloud and toasts the result", async () => {
    const t = setup();
    const s = t.remember("Fix the flaky login test", "session_01Login");
    const send = vi.spyOn(t.hub, "sendCloud").mockResolvedValue({ ok: true, sessionId: s.id, url: s.url, error: null });
    const r = t.open();
    await r.waitFor((x) => x.includes("Fix the flaky login test"), "the session");
    for (let i = 0; i < 3; i++) await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await r.waitFor((x) => x.includes("Message: Fix the flaky login test"), "the message input");
    expect(r.screen()).toContain(`queues it as the next message of ${s.id}`);
    // Esc goes back to the list, not out of /cloud.
    await r.press("\u001b");
    await r.waitFor((x) => x.includes("enter message · t teleport"), "the list again");
    expect(t.ui.dialogs).toHaveLength(1);
    await r.press("m");
    await r.waitFor((x) => x.includes("Message: Fix the flaky login test"), "the message input");
    await r.press("also add a test for the empty case");
    await r.press(KEYS.enter);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(s, "also add a test for the empty case"));
    await vi.waitFor(() => expect(t.hub.toasts.at(-1)?.text).toBe('Sent to "Fix the flaky login test" - queued as the cloud session\'s next message.'));
    // Back on the list with the same session highlighted.
    await r.waitFor((x) => x.includes("enter message · t teleport"), "the list with the session");
    expect(t.hub.pickedCloudId).toBe(s.id);
  });

  it("asks for the new session's link when Claude Code's output had none, saying why", async () => {
    const t = setup();
    const r = t.open();
    await r.waitFor((s) => s.includes("New cloud session…"), "the dialog");
    await r.press(KEYS.enter);
    expect(t.ui.dialogs.at(-1)?.id).toBe("cloud-task");
    const task = t.showTop();
    await task.waitFor((s) => s.includes("New cloud session"), "the task input");
    await task.press("Fix the flaky login test");
    await task.press(KEYS.enter);
    await vi.waitFor(() => expect(t.ui.dialogs.at(-1)?.id).toBe("cloud-link"));
    // claude --cloud "<task>", recorded through `script` where there is one.
    expect(t.calls[0].args.join(" ")).toMatch(/--cloud '?Fix the flaky login test/);
    expect(t.calls[0].cwd).toBe(t.project.cwd);
    const link = t.showTop();
    await link.waitFor((s) => s.includes("Paste the new session's link"), "the link dialog");
    expect(link.screen()).toContain("All my cloud sessions…");
    await link.press("https://claude.ai/code/session_01Pasted?from=cli");
    await link.press(KEYS.enter);
    expect(t.hub.cloudSessions[0]).toMatchObject({ id: "session_01Pasted", task: "Fix the flaky login test" });
  });

  it("explains the link step on Windows, where the CLI's output can't be read", () => {
    const win = linkPromptLines("Fix it", "win32").join("\n");
    expect(win).toContain("On Windows lu-minal can't read what Claude Code printed");
    expect(win).toContain("https://claude.ai/code/session_…");
    expect(win).toContain("message, teleport and watch");
    expect(win).toContain("Esc skips this");
    expect(linkPromptLines("Fix it", "linux").join("\n")).toContain("couldn't find the new session's link");
    expect(linkPromptLines("").join("\n")).toContain("started on the web, in the Claude app or on another computer");
  });

  it("formats a session row", () => {
    const now = Date.UTC(2026, 9, 26, 12);
    const s: CloudSession = {
      id: "session_x",
      url: "https://claude.ai/code/session_x",
      task: "t",
      cwd: "/w",
      startedAt: now - 86_400_000 * 3,
      lastMessageAt: now - 10_000,
      lastError: "Error: Session not found: session_x",
    };
    expect(sessionDetails(s, now)).toBe("started 3d ago · messaged just now · ✗ Session not found: session_x");
  });
});
