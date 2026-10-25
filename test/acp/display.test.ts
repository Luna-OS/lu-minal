import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessAcpCall,
  contentText,
  describeAcpTool,
  diffDisplay,
  diffItems,
  KIND_RISKS,
  KIND_VERBS,
  modeFor,
  permissionOptions,
  pickPermissionOption,
  planEntries,
  planSummary,
  resultDetail,
  riskFor,
  rowStatus,
  stopReasonNote,
  toolKind,
  type ToolCallView,
} from "../../src/agents/acp/display.js";

const cwd = path.resolve("/work/demo");
const view = (v: Partial<ToolCallView>): ToolCallView => ({ kind: null, title: "", name: "", rawInput: {}, locations: undefined, ...v });

describe("tool kinds", () => {
  it("maps every ACP kind to a verb and a risk", () => {
    expect(KIND_VERBS).toEqual({
      read: "read",
      edit: "edit",
      delete: "delete",
      move: "move",
      search: "grep",
      execute: "run",
      think: "think",
      fetch: "fetch",
      switch_mode: "mode",
      other: "tool",
    });
    expect(KIND_RISKS.read).toBe("read");
    expect(KIND_RISKS.search).toBe("read");
    expect(KIND_RISKS.think).toBe("read");
    expect(KIND_RISKS.edit).toBe("edit");
    expect(KIND_RISKS.execute).toBe("exec");
    expect(KIND_RISKS.fetch).toBe("network");
    expect(KIND_RISKS.other).toBe("other");
    expect(riskFor(null)).toBe("other");
    expect(toolKind("execute")).toBe("execute");
    expect(toolKind("shell")).toBeNull();
  });

  it("maps statuses to rows", () => {
    expect(rowStatus("pending")).toBe("running");
    expect(rowStatus("in_progress")).toBe("running");
    expect(rowStatus("completed")).toBe("ok");
    expect(rowStatus("failed")).toBe("error");
    expect(rowStatus(undefined)).toBe("running");
  });
});

describe("describeAcpTool", () => {
  const file = path.join(cwd, "src", "app.ts");

  it("takes the target from locations, raw input or the title", () => {
    expect(describeAcpTool(view({ kind: "read", title: "read", locations: [{ path: file }] }), cwd)).toEqual({ verb: "read", target: path.join("src", "app.ts") });
    expect(describeAcpTool(view({ kind: "edit", title: "edit", rawInput: { filePath: file } }), cwd)).toEqual({ verb: "edit", target: path.join("src", "app.ts") });
    expect(describeAcpTool(view({ kind: "edit", title: "edit", rawInput: { filePath: file } }), cwd, true).verb).toBe("new");
    expect(describeAcpTool(view({ kind: "edit", title: "Editing the config" }), cwd)).toEqual({ verb: "edit", target: "Editing the config" });
    expect(describeAcpTool(view({ kind: "delete", locations: [{ path: file }] }), cwd)).toEqual({ verb: "delete", target: path.join("src", "app.ts") });
    expect(describeAcpTool(view({ kind: "move", rawInput: { path: file, destination: path.join(cwd, "b.ts") } }), cwd)).toEqual({
      verb: "move",
      target: `${path.join("src", "app.ts")} → b.ts`,
    });
  });

  it("describes commands, searches, fetches and thoughts", () => {
    expect(describeAcpTool(view({ kind: "execute", title: "npm test", rawInput: { command: "npm test", description: "Runs the tests" } }), cwd)).toEqual({ verb: "run", target: "npm test" });
    expect(describeAcpTool(view({ kind: "execute", title: "ls -la" }), cwd)).toEqual({ verb: "run", target: "ls -la" });
    expect(describeAcpTool(view({ kind: "search", title: "grep", rawInput: { pattern: "TODO", path: path.join(cwd, "src") } }), cwd)).toEqual({ verb: "grep", target: "TODO in src" });
    expect(describeAcpTool(view({ kind: "search", title: "**/*.ts", rawInput: {} }), cwd)).toEqual({ verb: "grep", target: "**/*.ts" });
    expect(describeAcpTool(view({ kind: "fetch", title: "webfetch", rawInput: { url: "https://example.com/docs/page?x=1" } }), cwd)).toEqual({ verb: "fetch", target: "example.com/docs/page" });
    expect(describeAcpTool(view({ kind: "think", title: "task", rawInput: { description: "Explore the repo" } }), cwd)).toEqual({ verb: "think", target: "Explore the repo" });
  });

  it("takes other tools' verb from the title's first word", () => {
    expect(describeAcpTool(view({ kind: "other", title: "todowrite" }), cwd)).toEqual({ verb: "todowrite" });
    expect(describeAcpTool(view({ kind: "other", title: "Searching the web" }), cwd)).toEqual({ verb: "searching", target: "the web" });
    expect(describeAcpTool(view({ kind: "other", title: "luminal_send_message" }), cwd)).toEqual({ verb: "luminal send message" });
    expect(describeAcpTool(view({ kind: null, title: "", name: "" }), cwd)).toEqual({ verb: "tool" });
  });
});

describe("tool content", () => {
  it("reads text and diffs from content", () => {
    const content = [
      { type: "content", content: { type: "text", text: "line one" } },
      { type: "diff", path: path.join(cwd, "a.txt"), oldText: "a\nold\n", newText: "a\nnew\n" },
      { type: "terminal", terminalId: "t1" },
      { type: "content", content: { type: "resource", resource: { uri: "file:///x", text: "from a resource" } } },
    ];
    expect(contentText(content)).toBe("line one\nfrom a resource");
    expect(diffItems(content)).toEqual([{ path: path.join(cwd, "a.txt"), oldText: "a\nold\n", newText: "a\nnew\n" }]);
    expect(contentText(null)).toBe("");
    expect(diffItems("nope")).toEqual([]);
  });

  it("builds the panel diff, with a file row per file when there are several", () => {
    const one = diffDisplay([{ path: path.join(cwd, "a.txt"), oldText: "a\nold\n", newText: "a\nnew\n" }], cwd)!;
    expect(one).toMatchObject({ added: 1, removed: 1, isNew: false });
    expect(one.lines).toEqual([
      { kind: "ctx", line: 1, text: "a" },
      { kind: "del", line: 2, text: "old" },
      { kind: "add", line: 2, text: "new" },
    ]);
    // A new file: OpenCode sends "" as the old text, others null.
    expect(diffDisplay([{ path: "n.txt", oldText: "", newText: "x\n" }], cwd)!.isNew).toBe(true);
    expect(diffDisplay([{ path: "n.txt", oldText: null, newText: "x\n" }], cwd)!.isNew).toBe(true);
    const two = diffDisplay(
      [
        { path: path.join(cwd, "a.txt"), oldText: "1\n", newText: "2\n" },
        { path: path.join(cwd, "b.txt"), oldText: null, newText: "3\n" },
      ],
      cwd,
    )!;
    expect(two).toMatchObject({ added: 2, removed: 1, isNew: false });
    expect(two.lines.filter((l) => l.kind === "gap").map((l) => l.text)).toEqual(["a.txt", "…", "b.txt"]);
    expect(diffDisplay([], cwd)).toBeNull();
  });

  it("writes the one-line result", () => {
    expect(resultDetail("edit", "ok", "", null, { added: 2, removed: 0 })).toBe("2 lines added");
    expect(resultDetail("read", "ok", "a\nb\nc\n", null, null)).toBe("3 lines");
    expect(resultDetail("execute", "ok", "", { output: "ok 3 tests\n", metadata: { exit: 0 } }, null)).toBe("ok 3 tests");
    expect(resultDetail("execute", "ok", "", { output: "boom\n", metadata: { exit: 2 } }, null)).toBe("exit 2 · boom");
    expect(resultDetail("execute", "ok", "", {}, null)).toBe("done");
    expect(resultDetail("other", "error", "", { error: "The user rejected permission" }, null)).toBe("The user rejected permission");
    expect(resultDetail("other", "error", "", null, null)).toBe("failed");
    expect(resultDetail("search", "ok", "Found 4 matches\nsrc/a.ts", null, null)).toBe("Found 4 matches");
  });
});

describe("permissions", () => {
  afterEach(() => vi.unstubAllEnvs());

  // OpenCode's options, as `opencode acp` sends them.
  const opencode = permissionOptions([
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]);

  it("answers with the option that matches the decision", () => {
    expect(pickPermissionOption(opencode, "allow")).toBe("once");
    expect(pickPermissionOption(opencode, "always")).toBe("always");
    expect(pickPermissionOption(opencode, "deny")).toBe("reject");
  });

  it("falls back to the nearest option, or none", () => {
    const onlyAlways = permissionOptions([
      { optionId: "a", kind: "allow_always", name: "Always" },
      { optionId: "r", kind: "reject_always", name: "Never" },
    ]);
    expect(pickPermissionOption(onlyAlways, "allow")).toBe("a");
    expect(pickPermissionOption(onlyAlways, "deny")).toBe("r");
    const onlyOnce = permissionOptions([{ optionId: "o", kind: "allow_once", name: "Once" }]);
    expect(pickPermissionOption(onlyOnce, "always")).toBe("o");
    expect(pickPermissionOption(onlyOnce, "deny")).toBeNull();
    expect(permissionOptions([{ kind: "allow_once" }, "x"])).toEqual([]);
  });

  it("checks a path as written and as \"~\" expanded, keeping the stricter answer", () => {
    const home = path.resolve("/home/ada");
    vi.stubEnv("LU_MINAL_HOME_DIR", home);
    const read = (p: string) => assessAcpCall(view({ kind: "read", locations: [{ path: p }] }), cwd);
    expect(read("~/.ssh/id_ed25519")).toMatchObject({ risk: "other", target: path.join(home, ".ssh", "id_ed25519") });
    expect(read("src/a.ts").risk).toBe("read");
    expect(assessAcpCall(view({ kind: "edit", rawInput: { path: "~/.bashrc" } }), cwd).risk).toBe("other");
    expect(assessAcpCall(view({ kind: "edit", rawInput: { path: "src/a.ts" } }), cwd).risk).toBe("edit");
  });
});

describe("turns, plans and modes", () => {
  it("notes stop reasons other than end_turn and cancelled", () => {
    expect(stopReasonNote("end_turn", "OpenCode")).toBeNull();
    expect(stopReasonNote("cancelled", "OpenCode")).toBeNull();
    expect(stopReasonNote("max_tokens", "OpenCode")).toEqual({ level: "info", text: "OpenCode stopped: the model reached its output limit." });
    expect(stopReasonNote("max_turn_requests", "Gemini CLI")?.text).toContain("limit of model requests");
    expect(stopReasonNote("refusal", "OpenCode")).toEqual({ level: "error", text: "OpenCode's model refused to continue." });
    expect(stopReasonNote("weird", "X")).toEqual({ level: "info", text: "X stopped (weird)." });
  });

  it("sums up a plan", () => {
    const entries = planEntries([
      { content: "Read the code", priority: "high", status: "completed" },
      { content: "Write the fix", priority: "high", status: "in_progress" },
      { content: "Run the tests", priority: "low", status: "pending" },
      { nope: true },
    ]);
    expect(entries).toHaveLength(3);
    expect(planSummary(entries)).toBe("plan 1/3 · ▸ Write the fix");
    expect(planSummary(entries.map((e) => ({ ...e, status: "completed" })))).toBe("plan 3/3 · done");
    expect(planSummary([])).toBe("plan cleared");
  });

  it("picks a plan mode only for plan, the default mode otherwise", () => {
    const opencode = [
      { id: "build", name: "build" },
      { id: "plan", name: "plan" },
    ];
    expect(modeFor("plan", opencode, "build")).toBe("plan");
    expect(modeFor("auto-edit", opencode, "build")).toBe("build");
    expect(modeFor("yolo", opencode, "build")).toBe("build");
    expect(modeFor("ask", opencode, "build")).toBe("build");
    const gemini = [
      { id: "default", name: "Default" },
      { id: "autoEdit", name: "Auto Edit" },
      { id: "yolo", name: "YOLO" },
    ];
    expect(modeFor("plan", gemini, "default")).toBe("default"); // no plan mode: lu-minal's rules refuse edits anyway
    expect(modeFor("yolo", gemini, "default")).toBe("default");
    expect(modeFor("plan", [{ id: "architect", name: "Read-only planning" }], null)).toBe("architect");
    expect(modeFor("ask", [], "x")).toBeNull();
  });
});
