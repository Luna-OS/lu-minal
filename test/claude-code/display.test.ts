import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanResultText,
  contentBefore,
  describeClaudeTool,
  displayPath,
  hunksToDiff,
  toolResultDisplay,
} from "../../src/agents/claude-code/display.js";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lm-display-"));
  fs.mkdirSync(path.join(cwd, "src"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const at = (...parts: string[]) => path.join(cwd, ...parts);

describe("describeClaudeTool", () => {
  it("names Claude Code's own tools with a verb and a project-relative target", () => {
    fs.writeFileSync(at("src", "App.tsx"), "x\n");
    expect(describeClaudeTool("Read", { file_path: at("src", "App.tsx") }, cwd)).toEqual({
      verb: "read",
      target: path.join("src", "App.tsx"),
    });
    expect(describeClaudeTool("Write", { file_path: at("src", "App.tsx"), content: "" }, cwd)).toEqual({
      verb: "write",
      target: path.join("src", "App.tsx"),
    });
    expect(describeClaudeTool("Write", { file_path: at("src", "new.ts"), content: "" }, cwd).verb).toBe("new");
    for (const name of ["Edit", "MultiEdit"]) {
      expect(describeClaudeTool(name, { file_path: "src/App.tsx" }, cwd)).toEqual({ verb: "edit", target: path.join("src", "App.tsx") });
    }
    expect(describeClaudeTool("NotebookEdit", { notebook_path: at("nb.ipynb") }, cwd)).toEqual({ verb: "edit", target: "nb.ipynb" });
    expect(describeClaudeTool("LS", { path: cwd }, cwd)).toEqual({ verb: "list", target: "." });
  });

  it("shows paths outside the project from the home folder", () => {
    const outside = path.join(os.homedir(), "notes.md");
    const shown = describeClaudeTool("Read", { file_path: outside }, cwd).target!;
    expect(shown.startsWith("~")).toBe(true);
    expect(shown.endsWith("notes.md")).toBe(true);
    expect(displayPath("", cwd)).toBe("");
  });

  it("cuts commands to their first line, 60 characters at most", () => {
    expect(describeClaudeTool("Bash", { command: "npm test" }, cwd)).toEqual({ verb: "run", target: "npm test" });
    const long = describeClaudeTool("Bash", { command: `\n  echo ${"x".repeat(100)}\nsecond line` }, cwd).target!;
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
    expect(long.startsWith("echo ")).toBe(true);
  });

  it("covers search, web, delegation and todo tools", () => {
    expect(describeClaudeTool("Grep", { pattern: "useState" }, cwd)).toEqual({ verb: "grep", target: "useState" });
    expect(describeClaudeTool("Grep", { pattern: "x", path: at("src") }, cwd).target).toBe("x in src");
    expect(describeClaudeTool("Glob", { pattern: "**/*.ts" }, cwd)).toEqual({ verb: "glob", target: "**/*.ts" });
    expect(describeClaudeTool("WebFetch", { url: "https://docs.claude.com/en/docs/claude-code?x=1", prompt: "?" }, cwd)).toEqual({
      verb: "fetch",
      target: "docs.claude.com/en/docs/claude-code",
    });
    expect(describeClaudeTool("WebFetch", { url: "https://example.com/" }, cwd).target).toBe("example.com");
    expect(describeClaudeTool("WebSearch", { query: "ink 8 release" }, cwd)).toEqual({ verb: "search", target: "ink 8 release" });
    expect(describeClaudeTool("Task", { description: "Find the bug", prompt: "..." }, cwd)).toEqual({ verb: "delegate", target: "Find the bug" });
    expect(describeClaudeTool("Agent", { description: "Review", prompt: "..." }, cwd).verb).toBe("delegate");
    expect(describeClaudeTool("TodoWrite", { todos: [{}, {}, {}] }, cwd)).toEqual({ verb: "todo", target: "3 items" });
  });

  it("names lu-minal's tools and other MCP servers' tools", () => {
    expect(describeClaudeTool("mcp__luminal__send_message", { to: "vega", text: "hi" }, cwd)).toEqual({ verb: "message", target: "→ vega" });
    expect(describeClaudeTool("mcp__luminal__spawn_agent", { task: "Build the room", label: "room" }, cwd)).toEqual({
      verb: "spawn",
      target: "room",
    });
    expect(describeClaudeTool("mcp__luminal__task_add", { title: "Voice" }, cwd)).toEqual({ verb: "task add", target: "Voice" });
    expect(describeClaudeTool("mcp__luminal__list_agents", {}, cwd)).toEqual({ verb: "list agents" });
    expect(describeClaudeTool("mcp__github__create_pull_request", {}, cwd)).toEqual({ verb: "github", target: "create pull request" });
    expect(describeClaudeTool("SomethingNew", {}, cwd)).toEqual({ verb: "SomethingNew" });
  });
});

describe("toolResultDisplay", () => {
  it("counts the lines Read returned (numbered, without the CLI's reminders)", () => {
    const text = "     1\timport x\n     2\t\n     3\texport {}\n\n<system-reminder>\nWhenever you read a file, consider malware.\n</system-reminder>";
    expect(toolResultDisplay("Read", { file_path: "a.ts" }, text, false, cwd)).toEqual({ detail: "3 lines" });
    expect(toolResultDisplay("Read", {}, "     1→only", false, cwd)).toEqual({ detail: "1 line" });
    expect(toolResultDisplay("Read", {}, "x", false, cwd, { meta: { type: "text", file: { numLines: 94 } } })).toEqual({ detail: "94 lines" });
    expect(
      toolResultDisplay("Read", {}, "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>", false, cwd),
    ).toEqual({ detail: "empty" });
    expect(toolResultDisplay("Read", {}, "[image]", false, cwd)).toEqual({ detail: "image" });
  });

  it("diffs an Edit at the line it really changed, read back from the file", () => {
    const file = at("src", "theme.ts");
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    // The edit replaced line 54 ("warmth = 0.4") by two lines.
    lines.splice(53, 1, "moon = 'full'", "glow = 0.25");
    fs.writeFileSync(file, lines.join("\r\n"));
    const d = toolResultDisplay(
      "Edit",
      { file_path: file, old_string: "line 53\nwarmth = 0.4", new_string: "line 53\nmoon = 'full'\nglow = 0.25" },
      `The file ${file} has been updated successfully.`,
      false,
      cwd,
    );
    expect(d.diff).toEqual([
      { kind: "ctx", line: 53, text: "line 53" },
      { kind: "del", line: 54, text: "warmth = 0.4" },
      { kind: "add", line: 54, text: "moon = 'full'" },
      { kind: "add", line: 55, text: "glow = 0.25" },
    ]);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.detail).toBe("1 line changed, 1 line added");
  });

  it("numbers an Edit from 1 when the file can't be read back", () => {
    const d = toolResultDisplay("Edit", { file_path: at("gone.ts"), old_string: "a", new_string: "b" }, "ok", false, cwd);
    expect(d.diff).toEqual([
      { kind: "del", line: 1, text: "a" },
      { kind: "add", line: 1, text: "b" },
    ]);
    expect(d.detail).toBe("1 line changed");
  });

  it("uses the CLI's structuredPatch (real line numbers) when the stream has it", () => {
    const meta = {
      filePath: "src/a.ts",
      structuredPatch: [
        {
          oldStart: 120,
          oldLines: 7,
          newStart: 120,
          newLines: 7,
          lines: ["   one", "   two", "   three", "-  old", "+  new", "   four", "   five", "   six"],
        },
        { oldStart: 300, oldLines: 2, newStart: 300, newLines: 3, lines: ["   x", "+  added\r"] },
      ],
    };
    const d = toolResultDisplay("Edit", { file_path: "src/a.ts", old_string: "old", new_string: "new" }, "ok", false, cwd, { meta });
    // Like makeDiff: gaps only between changes, the line numbers say where it starts.
    expect(d.diff).toEqual([
      { kind: "ctx", line: 122, text: "  three" },
      { kind: "del", line: 123, text: "  old" },
      { kind: "add", line: 123, text: "  new" },
      { kind: "ctx", line: 124, text: "  four" },
      { kind: "gap", line: null, text: "…" },
      { kind: "ctx", line: 300, text: "  x" },
      { kind: "add", line: 301, text: "  added" },
    ]);
    expect(d).toMatchObject({ added: 2, removed: 1, detail: "1 line changed, 1 line added" });
  });

  it("diffs each change of a MultiEdit", () => {
    const file = at("m.ts");
    fs.writeFileSync(file, "a\nB\nc\nd\nE\n");
    const d = toolResultDisplay(
      "MultiEdit",
      { file_path: file, edits: [{ old_string: "b", new_string: "B" }, { old_string: "e", new_string: "E" }] },
      "ok",
      false,
      cwd,
    );
    expect(d.diff).toEqual([
      { kind: "del", line: 2, text: "b" },
      { kind: "add", line: 2, text: "B" },
      { kind: "gap", line: null, text: "…" },
      { kind: "del", line: 5, text: "e" },
      { kind: "add", line: 5, text: "E" },
    ]);
    expect(d.detail).toBe("2 lines changed");
  });

  it("shows a Write as a diff against the old content, or as written lines", () => {
    const content = "one\ntwo\nthree\n";
    expect(toolResultDisplay("Write", { file_path: "n.ts", content }, "File created successfully", false, cwd, { before: null })).toEqual({
      detail: "wrote 3 lines",
      added: 3,
    });
    const over = toolResultDisplay("Write", { file_path: "n.ts", content }, "ok", false, cwd, { before: "one\n2\nthree\n" });
    expect(over.diff).toEqual([
      { kind: "ctx", line: 1, text: "one" },
      { kind: "del", line: 2, text: "2" },
      { kind: "add", line: 2, text: "two" },
      { kind: "ctx", line: 3, text: "three" },
    ]);
    expect(over.detail).toBe("1 line changed");
    // Read too late (the CLI was faster): no diff, just the line count.
    expect(toolResultDisplay("Write", { file_path: "n.ts", content }, "ok", false, cwd, { before: content })).toEqual({ detail: "wrote 3 lines" });
    expect(toolResultDisplay("Write", { file_path: "n.ts", content }, "ok", false, cwd, { meta: { type: "create" } })).toEqual({
      detail: "wrote 3 lines",
      added: 3,
    });
    expect(
      toolResultDisplay("Write", { file_path: "n.ts", content }, "ok", false, cwd, { meta: { type: "update", structuredPatch: [] } }),
    ).toEqual({ detail: "no changes" });
  });

  it("shows a command's first meaningful line, or its exit code", () => {
    expect(toolResultDisplay("Bash", { command: "npm test" }, "\n> lu-minal@0.1.0 test\n> vitest run\n\n Test Files  12 passed (12)\n", false, cwd)).toEqual({
      detail: "✓ Test Files  12 passed (12)",
    });
    expect(toolResultDisplay("Bash", { command: "mkdir x" }, "", false, cwd)).toEqual({ detail: "✓ exit 0" });
    expect(toolResultDisplay("Bash", { command: "npm test" }, 'Exit code 1\nnpm ERR! Missing script: "test"', true, cwd)).toEqual({
      detail: 'exit 1 · npm ERR! Missing script: "test"',
    });
    expect(toolResultDisplay("Bash", { command: "x" }, "", false, cwd, { meta: { stdout: "", interrupted: true } })).toEqual({ detail: "interrupted" });
  });

  it("counts grep hits and glob files", () => {
    expect(toolResultDisplay("Grep", { pattern: "x" }, "Found 3 files\nsrc/a.ts\nsrc/b.ts\nsrc/c.ts", false, cwd)).toEqual({ detail: "3 files" });
    expect(toolResultDisplay("Grep", { pattern: "x", output_mode: "content" }, "a.ts:1:x\na.ts:9:x\nb.ts:2:x\n", false, cwd)).toEqual({
      detail: "3 hits",
    });
    expect(toolResultDisplay("Grep", { pattern: "x", output_mode: "count" }, "a.ts:4\nb.ts:2\n", false, cwd)).toEqual({ detail: "6 hits" });
    expect(toolResultDisplay("Grep", { pattern: "x" }, "No files found", false, cwd)).toEqual({ detail: "no matches" });
    expect(toolResultDisplay("Grep", { pattern: "x" }, "", false, cwd, { meta: { mode: "content", numLines: 1 } })).toEqual({ detail: "1 hit" });
    expect(toolResultDisplay("Glob", { pattern: "*.ts" }, "/p/a.ts\n/p/b.ts\n(Results are truncated. Consider a narrower pattern.)", false, cwd)).toEqual({
      detail: "2 files",
    });
    expect(toolResultDisplay("Glob", { pattern: "*.rs" }, "No files found", false, cwd)).toEqual({ detail: "no files" });
  });

  it("shows other tools' first line, todo progress and errors", () => {
    expect(toolResultDisplay("TodoWrite", { todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }] }, "ok", false, cwd)).toEqual({
      detail: "1/3 done",
    });
    expect(toolResultDisplay("WebFetch", { url: "https://x" }, "body", false, cwd, { meta: { code: 200, codeText: "OK", bytes: 2048 } })).toEqual({
      detail: "200 OK · 2.0 KB",
    });
    expect(toolResultDisplay("mcp__luminal__send_message", {}, "Delivered to vega.\nmore", false, cwd)).toEqual({ detail: "Delivered to vega." });
    expect(toolResultDisplay("Edit", {}, "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>", true, cwd)).toEqual({
      detail: "File has not been read yet. Read it first before writing to it.",
    });
    expect(toolResultDisplay("Bash", {}, "The user denied this in lu-minal.", true, cwd)).toEqual({ detail: "denied" });
    expect(toolResultDisplay("Edit", {}, "", true, cwd)).toEqual({ detail: "failed" });
  });
});

describe("helpers", () => {
  it("cleans the CLI's notes from a result", () => {
    expect(cleanResultText("a\n<system-reminder>x\ny</system-reminder>\n")).toBe("a");
    expect(cleanResultText("<tool_use_error>bad</tool_use_error>")).toBe("bad");
  });

  it("trims hunk context to one line around changes", () => {
    const d = hunksToDiff([{ oldStart: 1, newStart: 1, lines: [" a", " b", "-c", " d", " e", " f", " g", "+h", " i"] }]);
    expect(d.lines.map((l) => `${l.kind}:${l.line ?? ""}:${l.text}`)).toEqual([
      "ctx:2:b",
      "del:3:c",
      "ctx:3:d",
      "gap::…",
      "ctx:6:g",
      "add:7:h",
      "ctx:8:i",
    ]);
  });

  it("reads a file's content before a Write replaces it", () => {
    fs.writeFileSync(at("w.txt"), "old\n");
    expect(contentBefore("Write", { file_path: at("w.txt") }, cwd)).toBe("old\n");
    expect(contentBefore("Write", { file_path: "nope.txt" }, cwd)).toBeNull();
    expect(contentBefore("Edit", { file_path: at("w.txt") }, cwd)).toBeUndefined();
  });
});
