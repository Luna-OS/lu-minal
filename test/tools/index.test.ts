import { describe, expect, it } from "vitest";
import { detectShell } from "../../src/tools/exec.js";
import { allTools, toolSpecs, toolsForAgent } from "../../src/tools/index.js";
import { makeCtx } from "./helpers.js";

// Roblox Studio's tools come from src/tools/roblox.ts and are counted separately.
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name).filter((n) => !n.startsWith("roblox_"));

describe("tool sets", () => {
  it("has every built-in tool exactly once, each with an object schema", () => {
    const all = allTools();
    expect(names(all)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "grep",
      "bash",
      "web_fetch",
      "send_message",
      "list_agents",
      "spawn_agent",
      "stop_agent",
      "tasks_list",
      "task_add",
      "task_update",
      "list_themes",
      "set_theme",
      "create_theme",
      "cloud_sessions",
      "cloud_send",
    ]);
    expect(new Set(all.map((t) => t.name)).size).toBe(all.length);
    for (const t of all.filter((x) => !x.name.startsWith("roblox_"))) {
      expect(t.parameters.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(40);
      for (const r of t.parameters.required ?? []) expect(Object.keys(t.parameters.properties)).toContain(r);
    }
  });

  it("gives native leads everything and native workers all but the lead-only tools", () => {
    const lead = names(toolsForAgent("lead", "native"));
    const worker = names(toolsForAgent("worker", "native"));
    expect(lead).toContain("spawn_agent");
    expect(lead).toContain("bash");
    expect(worker).not.toContain("spawn_agent");
    expect(worker).not.toContain("stop_agent");
    expect(worker).toContain("send_message");
    expect(worker).toContain("edit_file");
    expect(lead.length - worker.length).toBe(2);
  });

  it("gives Claude Code agents only the MCP tools", () => {
    const lead = names(toolsForAgent("lead", "claude-code"));
    expect(lead).toEqual([
      "send_message",
      "list_agents",
      "spawn_agent",
      "stop_agent",
      "tasks_list",
      "task_add",
      "task_update",
      "list_themes",
      "set_theme",
      "create_theme",
      "cloud_sessions",
      "cloud_send",
    ]);
    const worker = names(toolsForAgent("worker", "claude-code"));
    expect(worker).not.toContain("spawn_agent");
    expect(worker).not.toContain("read_file");
    expect(worker).not.toContain("bash");
  });

  it("takes a shell and a fetch to use", async () => {
    const shell = { ...detectShell("win32", {}, () => false), name: "Test Shell" };
    const bash = allTools({ shell }).find((t) => t.name === "bash")!;
    expect(bash.description).toContain("cmd.exe");
    let fetched = "";
    const web = allTools({
      fetchImpl: async (url) => {
        fetched = String(url);
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    }).find((t) => t.name === "web_fetch")!;
    await web.run({ url: "https://example.org/x" }, makeCtx());
    expect(fetched).toBe("https://example.org/x");
  });

  it("turns tools into specs for the model", () => {
    const specs = toolSpecs(toolsForAgent("worker", "claude-code"));
    expect(specs[0]).toEqual({
      name: "send_message",
      description: expect.any(String),
      parameters: expect.objectContaining({ type: "object", required: ["to", "text"] }),
    });
    expect(Object.keys(specs[0]).sort()).toEqual(["description", "name", "parameters"]);
  });
});
