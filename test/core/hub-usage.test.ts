// The plan limits in the hub: the last known numbers come back with a new start (instead of "–"
// until the first report), and a report without a window doesn't blank it out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSavedUsage } from "../../src/agents/claude-code/usage.js";
import { defaultConfig } from "../../src/core/config.js";
import { Hub } from "../../src/core/hub.js";
import type { PlanUsage } from "../../src/core/types.js";
import { AuthStore } from "../../src/providers/auth.js";
import { ThemeManager } from "../../src/themes/manager.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-hub-usage-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const hubIn = (cacheDir: string) =>
  new Hub({
    config: defaultConfig(),
    configPath: null,
    auth: new AuthStore(path.join(dir, "auth.json")),
    themes: new ThemeManager({ dir: path.join(dir, "themes") }),
    cacheDir,
    stateDir: dir,
    offline: true,
    servers: false,
  });

const usage: PlanUsage = {
  available: true,
  plan: "max",
  session: { utilization: 0.37, resetsAt: Date.now() + 3_600_000 },
  week: { utilization: 0.08, resetsAt: Date.now() + 86_400_000 },
  models: [],
  extra: null,
  at: Date.now() - 60_000,
};

describe("the hub's plan limits", () => {
  it("shows the last known numbers right from the start", async () => {
    const cache = path.join(dir, "cache");
    expect(hubIn(cache).planUsage).toBeNull();
    writeSavedUsage(path.join(cache, "plan-usage.json"), { email: "ada@example.com", usage });
    const hub = hubIn(cache);
    expect(hub.planUsage).toEqual(usage);
    await hub.dispose();
    // Saved again on the way out (with what running agents reported meanwhile).
    expect(JSON.parse(fs.readFileSync(path.join(cache, "plan-usage.json"), "utf8")).usage).toEqual(usage);
  });
});
