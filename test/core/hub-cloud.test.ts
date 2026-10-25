// Messages to a cloud session run `claude -p` in the project folder: a folder nobody trusted gets
// only the user's own settings there too (no .claude hooks, no .mcp.json servers).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToCloud } from "../../src/cloud/claude-cloud.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

vi.mock("../../src/cloud/claude-cloud.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cloud/claude-cloud.js")>()),
  sendToCloud: vi.fn(async () => ({ ok: true, sessionId: "session_q", url: null, error: null })),
}));

let dir = "";
let hub: Hub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-cloud-"));
  const config = defaultConfig();
  // Any program that exists: the mocked sendToCloud never runs it.
  config.claudePath = process.execPath;
  hub = new Hub({
    config,
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir: dir,
    stateDir: dir,
    offline: true,
    servers: false,
  });
  vi.spyOn(hub, "launch").mockResolvedValue(undefined);
  vi.mocked(sendToCloud).mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function folder(name: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(p);
  return p;
}

describe("sendCloud", () => {
  it("passes the trust of the open tab in that folder, and none for a folder that isn't open", async () => {
    const mine = await hub.openProject({ cwd: folder("mine") });
    const clone = await hub.openProject({ cwd: folder("clone"), origin: "github:mallory/evil", trusted: false });
    await hub.sendCloud({ id: "session_a", cwd: mine.cwd }, "hi");
    await hub.sendCloud({ id: "session_b", cwd: clone.cwd }, "hi");
    await hub.sendCloud({ id: "session_c", cwd: folder("elsewhere") }, "hi");
    const trusted = vi.mocked(sendToCloud).mock.calls.map(([, id, , opts]) => [id, opts?.trusted]);
    expect(trusted).toEqual([
      ["session_a", true],
      ["session_b", false],
      ["session_c", false],
    ]);
  });
});
