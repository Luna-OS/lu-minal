import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import {
  approvalAnswer,
  askWithdrawable,
  assessClaudeTool,
  automaticAnswer,
  claudeToolRisk,
  isReadOnlyCommand,
} from "../../src/mcp/approve.js";

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lm-approve-"));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "App.tsx"), "export {}\n");
});

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("isReadOnlyCommand", () => {
  it.each([
    "ls -la",
    "pwd",
    "git status",
    "git diff --stat HEAD~1",
    "git --no-pager log --oneline -5",
    "cat package.json | head -20",
    "grep -rn 'foo|bar; baz' src",
    "rg TODO src --type ts",
    "find . -name '*.ts' -not -path './node_modules/*' 2>/dev/null",
    "tail -n 50 logs/app.log",
    "wc -l src/*.ts",
    'echo "a > b"',
    "/usr/bin/ls",
  ])("reads only: %s", (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    "",
    "npm test",
    "rm -rf build",
    "ls; rm -rf build",
    "ls && rm x",
    "ls || rm x",
    "cat a.txt > b.txt",
    "cat < in.txt",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} \\;",
    "git push origin main",
    "git branch -D old",
    "git diff --output=patch.txt",
    "git -c core.pager=sh log",
    "echo $(whoami)",
    'echo "$(whoami)"',
    "cat `which node`",
    "FOO=1 ls",
    "rg --pre ./run.sh pattern",
    "sort -o out.txt in.txt",
    "ls |",
    "ls & rm x",
    "cat 'unclosed",
    "ls\nrm -rf /",
  ])("does more than read: %s", (command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});

describe("claudeToolRisk", () => {
  it("maps Claude Code's tools to lu-minal's risks", () => {
    expect(claudeToolRisk("Read", { file_path: "x" }, cwd)).toBe("read");
    expect(claudeToolRisk("Glob", {}, cwd)).toBe("read");
    expect(claudeToolRisk("Task", {}, cwd)).toBe("read");
    expect(claudeToolRisk("TodoWrite", {}, cwd)).toBe("read");
    expect(claudeToolRisk("WebSearch", {}, cwd)).toBe("read");
    expect(claudeToolRisk("mcp__luminal__send_message", {}, cwd)).toBe("read");
    expect(claudeToolRisk("Edit", { file_path: path.join(cwd, "src", "App.tsx") }, cwd)).toBe("edit");
    expect(claudeToolRisk("Write", { file_path: "src/new.ts" }, cwd)).toBe("edit");
    expect(claudeToolRisk("MultiEdit", { file_path: "src/App.tsx" }, cwd)).toBe("edit");
    expect(claudeToolRisk("NotebookEdit", { notebook_path: "nb.ipynb" }, cwd)).toBe("edit");
    expect(claudeToolRisk("Bash", { command: "git log -3" }, cwd)).toBe("read");
    expect(claudeToolRisk("Bash", { command: "npm install" }, cwd)).toBe("exec");
    expect(claudeToolRisk("PowerShell", { command: "Get-ChildItem" }, cwd)).toBe("exec");
    expect(claudeToolRisk("WebFetch", { url: "https://x" }, cwd)).toBe("network");
    expect(claudeToolRisk("mcp__github__create_pull_request", {}, cwd)).toBe("other");
    expect(claudeToolRisk("ExitPlanMode", {}, cwd)).toBe("other");
    expect(claudeToolRisk("SomethingNew", {}, cwd)).toBe("other");
    // Claude Code 2.1's newer tools.
    expect(claudeToolRisk("ToolSearch", { query: "select:Read" }, cwd)).toBe("read");
    expect(claudeToolRisk("TaskCreate", { subject: "x" }, cwd)).toBe("read");
    expect(claudeToolRisk("EnterPlanMode", {}, cwd)).toBe("read");
    expect(claudeToolRisk("ReadMcpResourceTool", { uri: "x" }, cwd)).toBe("read");
    expect(claudeToolRisk("Monitor", { command: "tail -f log" }, cwd)).toBe("exec");
    expect(claudeToolRisk("TaskStop", { task_id: "b1" }, cwd)).toBe("exec");
  });

  it("asks for edits outside the project and in .git / .claude", () => {
    expect(claudeToolRisk("Edit", { file_path: path.join(os.homedir(), ".bashrc") }, cwd)).toBe("other");
    expect(claudeToolRisk("Write", { file_path: path.join(cwd, "..", "elsewhere.txt") }, cwd)).toBe("other");
    expect(claudeToolRisk("Edit", { file_path: path.join(cwd, ".git", "config") }, cwd)).toBe("other");
    expect(claudeToolRisk("Write", { file_path: ".claude/settings.json" }, cwd)).toBe("other");
    expect(claudeToolRisk("Edit", { file_path: ".github/workflows/ci.yml" }, cwd)).toBe("edit");
  });
});

describe("assessClaudeTool", () => {
  it("describes a command with its first two words as the 'always' key", () => {
    expect(assessClaudeTool("Bash", { command: "npm test -- --watch=false", description: "Run the tests" }, cwd)).toEqual({
      risk: "exec",
      summary: "run npm test -- --watch=false",
      detail: "npm test -- --watch=false\n(Run the tests)",
      allowKey: "Bash:npm test",
    });
    expect(assessClaudeTool("Bash", { command: "ls" }, cwd).allowKey).toBe("Bash:ls");
  });

  it("describes edits with the old and new text", () => {
    const edit = assessClaudeTool("Edit", { file_path: path.join(cwd, "src", "App.tsx"), old_string: "a\nb", new_string: "c" }, cwd);
    expect(edit).toEqual({
      risk: "edit",
      summary: `edit ${path.join("src", "App.tsx")}`,
      detail: "- a\n- b\n+ c",
      allowKey: "Edit",
    });
    expect(assessClaudeTool("Write", { file_path: "src/App.tsx", content: "x\ny\n" }, cwd)).toMatchObject({
      summary: `overwrite ${path.join("src", "App.tsx")}`,
      detail: "2 lines\n+ x\n+ y",
    });
    expect(assessClaudeTool("Write", { file_path: "src/new.ts", content: "" }, cwd).summary).toBe(`create ${path.join("src", "new.ts")}`);
    const outside = assessClaudeTool("Edit", { file_path: path.join(os.homedir(), "notes.md"), old_string: "", new_string: "x" }, cwd);
    expect(outside.risk).toBe("other");
    expect(outside.summary).toMatch(/^edit ~.*notes\.md \(outside the project\)$/);
    const multi = assessClaudeTool("MultiEdit", { file_path: "src/App.tsx", edits: [{ old_string: "a", new_string: "b" }, {}] }, cwd);
    expect(multi.detail).toBe("2 changes\n- a\n+ b");
  });

  it("describes fetches, plan mode and unknown tools", () => {
    expect(assessClaudeTool("WebFetch", { url: "https://docs.claude.com/x", prompt: "Summarize" }, cwd)).toEqual({
      risk: "network",
      summary: "fetch docs.claude.com/x",
      detail: "https://docs.claude.com/x\n(Summarize)",
      allowKey: "WebFetch",
    });
    expect(assessClaudeTool("ExitPlanMode", { plan: "1. Build\n2. Test" }, cwd)).toMatchObject({
      risk: "other",
      summary: "leave plan mode and start working",
      detail: "1. Build\n2. Test",
    });
    expect(assessClaudeTool("mcp__github__merge", { pr: 3 }, cwd)).toEqual({
      risk: "other",
      summary: "github merge",
      detail: '{"pr":3}',
      allowKey: "mcp__github__merge",
    });
  });
});

describe("approvalAnswer", () => {
  it("allows with the input unchanged, or denies with a reason", () => {
    expect(approvalAnswer(true, { command: "ls" }, "ask")).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(approvalAnswer(false, {}, "ask")).toEqual({ behavior: "deny", message: "The user denied this in lu-minal." });
    expect(approvalAnswer(false, {}, "plan")).toEqual({
      behavior: "deny",
      message: "Not allowed: lu-minal is in plan mode (read-only). Describe the change instead.",
    });
  });
});

describe("automaticAnswer", () => {
  it("turns down AskUserQuestion (a yes / no prompt can't collect the picks) and nothing else", () => {
    expect(automaticAnswer("AskUserQuestion")).toMatchObject({ behavior: "deny", message: expect.stringMatching(/plain text/) });
    expect(automaticAnswer("Bash")).toBeNull();
    expect(automaticAnswer("ExitPlanMode")).toBeNull();
  });
});

describe("askWithdrawable", () => {
  const request = { tool: "Bash", risk: "exec" as const, summary: "run make", allowKey: "Bash:make" };

  it("asks like requestApproval and passes the answer on", async () => {
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, new Notifier(), "ask");
    const ask = askWithdrawable(agent, request);
    expect(agent.pendingApproval).toMatchObject({ summary: "run make" });
    agent.answerApproval("allow");
    expect(await ask.decision).toBe("allow");
    // Withdrawing an answered question changes nothing.
    ask.withdraw();
    expect(agent.approvals).toHaveLength(0);
  });

  it("withdraws the question: it leaves the panel and counts as a denial", async () => {
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, new Notifier(), "ask");
    const other = agent.requestApproval({ ...request, summary: "run other" });
    const ask = askWithdrawable(agent, request);
    expect(agent.approvals).toHaveLength(2);
    ask.withdraw();
    expect(await ask.decision).toBe("deny");
    expect(agent.approvals.map((a) => a.request.summary)).toEqual(["run other"]);
    const entry = agent.log.filter((e) => e.kind === "approval")[1] as any;
    expect(entry.decision).toBe("deny");
    agent.answerApproval("allow");
    expect(await other).toBe("allow");
  });

  it("decides at once when the mode does, with nothing to withdraw", async () => {
    const agent = new Agent({ name: "luna", role: "lead", model: { provider: "claude-code", model: "opus" } }, new Notifier(), "yolo");
    const ask = askWithdrawable(agent, request);
    expect(agent.approvals).toHaveLength(0);
    ask.withdraw();
    expect(await ask.decision).toBe("allow");
  });
});
