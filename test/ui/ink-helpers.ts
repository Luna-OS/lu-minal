// Test helpers: render an Ink tree into a fake terminal of a given size, type keys into it and read
// the last frame as plain text (ink-testing-library's terminal is always 100 columns and has no rows).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink";
import type React from "react";
import { Agent, type AgentDriver } from "../../src/core/agent.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { Project } from "../../src/core/project.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";
import type { DialogSpec, UiServices } from "../../src/ui/store.js";
import { stripAnsi } from "./ansi-helpers.js";

/** A Hub on a temp folder: no servers, no catalog download, a still sky. */
export function testHub(): { hub: Hub; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-ui-"));
  const config = defaultConfig();
  config.sky.enabled = false;
  const hub = new Hub({
    config,
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
  return { hub, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Opens a tab on `cwd` with an idle lead whose driver does nothing. */
export function addProject(hub: Hub, cwd: string): { project: Project; lead: Agent } {
  const project = new Project({ cwd, name: "proj" }, hub.notifier, hub);
  const lead = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, hub.notifier, "auto-edit");
  lead.driver = { kind: "native", start: async () => undefined, send: () => undefined, interrupt: () => undefined, dispose: async () => undefined } as AgentDriver;
  project.agents.push(lead);
  project.focusedId = lead.id;
  hub.projects.push(project);
  hub.activeIndex = hub.projects.length - 1;
  return { project, lead };
}

/** UI services that only remember the dialogs opened. */
export function fakeUi(): UiServices & { dialogs: DialogSpec[] } {
  const dialogs: DialogSpec[] = [];
  return {
    dialogs,
    runInTerminal: async () => null,
    openDialog: (d) => void dialogs.push(d),
    closeDialog: () => void dialogs.pop(),
    quit: () => undefined,
  };
}

class FakeStdout extends EventEmitter {
  frames: string[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  read = (): string | null => {
    const d = this.data;
    this.data = null;
    return d;
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Renders `tree` in a `columns` x `rows` terminal. */
export function renderAt(tree: React.ReactElement, size: { columns: number; rows: number }) {
  const stdout = new FakeStdout(size.columns, size.rows);
  const stdin = new FakeStdin();
  const instance = render(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new FakeStdout(size.columns, size.rows) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  /** The last frame as plain text. */
  const screen = () => stripAnsi(stdout.frames.at(-1) ?? "");
  return {
    stdout,
    screen,
    /** Types keys (one write) and gives Ink and React time to render. */
    press: async (keys: string, settleMs = 60) => {
      stdin.write(keys);
      await sleep(settleMs);
    },
    /** Waits until the screen matches (or fails with the last screen). */
    waitFor: async (check: (screen: string) => boolean, what: string, timeoutMs = 3000) => {
      const until = Date.now() + timeoutMs;
      while (!check(screen())) {
        if (Date.now() > until) throw new Error(`Timed out waiting for ${what}. The screen:\n${screen()}`);
        await sleep(20);
      }
    },
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}

export const KEYS = {
  up: "\u001b[A",
  down: "\u001b[B",
  pageDown: "\u001b[6~",
  enter: "\r",
  ctrlC: "\u0003",
  ctrlW: "\u0017",
};
