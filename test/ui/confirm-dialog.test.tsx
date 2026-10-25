// The confirm dialog's keys, and the trust question after a clone, where enter must not mean yes.
import chalk from "chalk";
import { Box } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hub } from "../../src/core/hub.js";
import type { RepoHost, RepoInfo } from "../../src/git/types.js";
import { builtinTheme } from "../../src/themes/builtin.js";
import { ConfirmDialog } from "../../src/ui/dialogs/InputDialog.js";
import { askTrust } from "../../src/ui/dialogs/newtab.js";
import type { DialogSpec, UiServices } from "../../src/ui/store.js";
import { stripAnsi } from "./ansi-helpers.js";

const moon = builtinTheme("moon")!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let level: typeof chalk.level;

beforeAll(() => {
  level = chalk.level;
  chalk.level = 3;
});

afterAll(() => {
  chalk.level = level;
});

/** The dialog is positioned absolutely: it needs a screen to sit on. */
function screen(node: React.ReactNode) {
  return render(
    <Box width={100} height={24}>
      {node}
    </Box>,
  );
}

/** Renders a ConfirmDialog, presses `keys` and reports which answer came (and the frame before). */
async function press(keys: string, extra: { defaultNo?: boolean } = {}) {
  const onYes = vi.fn();
  const onNo = vi.fn();
  const r = screen(<ConfirmDialog theme={moon} title="Sure?" lines={["Really?"]} yes="do it" no="leave it" onYes={onYes} onNo={onNo} {...extra} />);
  await sleep(20);
  const frame = r.lastFrame() ?? "";
  if (keys) r.stdin.write(keys);
  await sleep(20);
  r.unmount();
  return { onYes, onNo, frame };
}

/** What follows the accent background (the button enter answers with). */
function highlighted(frame: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(moon.colors.accent.slice(i, i + 2), 16));
  const at = frame.indexOf(`\u001b[48;2;${r};${g};${b}m`);
  return at < 0 ? "" : stripAnsi(frame.slice(at)).trimStart();
}

describe("ConfirmDialog", () => {
  it("takes enter as yes by default", async () => {
    const r = await press("\r");
    expect(r.onYes).toHaveBeenCalledOnce();
    expect(r.onNo).not.toHaveBeenCalled();
    expect(highlighted(r.frame)).toMatch(/^y do it/);
  });

  it("with defaultNo, takes enter as no and highlights the no button; y is still yes", async () => {
    const enter = await press("\r", { defaultNo: true });
    expect(enter.onNo).toHaveBeenCalledOnce();
    expect(enter.onYes).not.toHaveBeenCalled();
    expect(highlighted(enter.frame)).toMatch(/^n leave it/);
    const y = await press("y", { defaultNo: true });
    expect(y.onYes).toHaveBeenCalledOnce();
    expect(y.onNo).not.toHaveBeenCalled();
  });
});

describe("the trust question after a clone", () => {
  it("doesn't trust the repository on enter", async () => {
    let dialog: DialogSpec | null = null;
    const ui = { openDialog: (d: DialogSpec) => (dialog = d) } as unknown as UiServices;
    const hub = { theme: moon } as unknown as Hub;
    const answer = askTrust(hub, ui, { fullName: "mallory/evil" } as RepoInfo, { label: "GitHub" } as RepoHost);
    const r = screen(dialog!.render(() => undefined));
    await sleep(20);
    r.stdin.write("\r");
    await expect(Promise.race([answer, sleep(500).then(() => "no answer")])).resolves.toBe(false);
    r.unmount();
  });
});
