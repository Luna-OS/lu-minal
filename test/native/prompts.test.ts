import { describe, expect, it } from "vitest";
import { systemPrompt, type PromptOptions } from "../../src/agents/prompts.js";

const base: PromptOptions = {
  agentName: "luna",
  role: "lead",
  label: null,
  projectName: "moon-app",
  cwd: "/home/me/moon-app",
  teammates: [
    { name: "vega", role: "worker", label: "room", model: "minimax/MiniMax-M3" },
    { name: "lyra", role: "worker", label: null, model: "opencode/big-pickle" },
  ],
  driverKind: "native",
  platform: "linux",
  shellName: "bash",
  robloxConnected: false,
  date: "2026-10-25",
};

describe("systemPrompt", () => {
  it("gives a native lead the coding prompt, the environment and the lead's job", () => {
    const p = systemPrompt(base);
    // Coding agent essentials.
    expect(p).toContain("Read a file before you edit it");
    expect(p).toContain("Prefer edit_file");
    expect(p).toMatch(/Never guess or invent the contents of a file/);
    expect(p).toMatch(/Verify your work with the project's own commands/);
    expect(p).toContain("Be concise");
    // Environment.
    expect(p).toContain("Project: moon-app");
    expect(p).toContain("Folder: /home/me/moon-app");
    expect(p).toContain("Platform: Linux");
    expect(p).toContain("The bash tool runs bash.");
    expect(p).toContain("Today: 2026-10-25");
    // Identity and roster.
    expect(p).toContain("You are **luna**, the lead");
    expect(p).toContain("- vega (worker, area: room) on minimax/MiniMax-M3");
    expect(p).toContain("- lyra (worker) on opencode/big-pickle");
    expect(p).toContain('"[message from <name>]"');
    expect(p).toContain("[message from vega]");
    // The lead's job.
    expect(p).toContain("# Your job as the lead");
    expect(p).toContain("task_add");
    expect(p).toContain("spawn_agent(task, label, model?, name?, instructions?)");
    for (const model of ["opencode/big-pickle", "claude-code/sonnet", "openrouter/<id>", "minimax/MiniMax-M3"]) expect(p).toContain(model);
    expect(p).toMatch(/Never let two workers edit the same file/);
    expect(p).toMatch(/Report to the user/);
    expect(p).not.toContain("# Your job as a worker");
    expect(p).not.toContain("mcp__luminal__");
    // Themes and Roblox.
    expect(p).toContain("set_theme");
    expect(p).toContain("create_theme");
    expect(p).toContain('"lu-minal roblox install"');
    expect(p).toContain("click Connect");
  });

  it("gives a worker its job, its area and the way to report", () => {
    const p = systemPrompt({
      ...base,
      agentName: "vega",
      role: "worker",
      label: "room",
      teammates: [{ name: "luna", role: "lead", label: null, model: "claude-code/opus" }],
      extraInstructions: "Only touch src/room/.",
    });
    expect(p).toContain("You are **vega**, a worker");
    expect(p).toContain("(your area: room)");
    expect(p).toContain("# Your job as a worker");
    expect(p).toContain("The lead (luna) coordinates");
    expect(p).toContain('send_message("lead", ...)');
    expect(p).toMatch(/task_update with status "doing"/);
    expect(p).not.toContain("# Your job as the lead");
    expect(p).toContain("# Instructions for you\nOnly touch src/room/.");
  });

  it("gives Claude Code only the team protocol, with MCP tool names", () => {
    const p = systemPrompt({ ...base, driverKind: "claude-code", robloxConnected: true });
    expect(p.startsWith("# Your team")).toBe(true);
    expect(p).not.toContain("# How to work");
    expect(p).not.toContain("# Environment");
    for (const tool of ["send_message", "spawn_agent", "task_add", "task_update", "tasks_list", "list_agents", "set_theme", "create_theme", "list_themes", "stop_agent", "roblox_get_tree"]) {
      expect(p).toContain(`mcp__luminal__${tool}`);
    }
    expect(p).not.toMatch(/(?<!mcp__luminal__)\bspawn_agent\(/);
    expect(p).toContain("Roblox Studio is connected");
    expect(p).toContain("before editing");
  });

  it("tells native agents about Windows shells", () => {
    const ps = systemPrompt({ ...base, platform: "win32", shellName: "Windows PowerShell", cwd: "C:\\Users\\me\\moon-app" });
    expect(ps).toContain("Platform: Windows");
    expect(ps).toContain("write PowerShell");
    expect(ps).toContain("Folder: C:\\Users\\me\\moon-app");
    const gitBash = systemPrompt({ ...base, platform: "win32", shellName: "Git Bash" });
    expect(gitBash).toContain("Git Bash on Windows: POSIX syntax works");
    expect(systemPrompt({ ...base, platform: "darwin" })).toContain("Platform: macOS");
  });

  it("handles a lone agent", () => {
    const p = systemPrompt({ ...base, teammates: [] });
    expect(p).toContain("- Nobody else yet.");
  });
});
