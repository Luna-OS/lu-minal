import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import {
  createGrepTool,
  displayPath,
  editFileTool,
  isInside,
  listFilesTool,
  readFileTool,
  resolvePath,
  writeFileTool,
} from "../../src/tools/fs.js";
import { runToolCall } from "../../src/tools/run.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";
import { makeCtx, removeDir, tempProject } from "./helpers.js";

let dir = "";
let ctx: ToolContext;

beforeEach(() => {
  dir = tempProject();
  ctx = makeCtx({ cwd: dir });
});
afterEach(() => removeDir(dir));

function write(rel: string, content: string | Buffer): string {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(dir, ...rel.split("/")), "utf8");
}

const run = (tool: Tool, args: Record<string, unknown>, c: ToolContext = ctx) => tool.run(args, c);

describe("path helpers", () => {
  it("resolves against the project, strips quotes, and shows paths relative to it", () => {
    expect(resolvePath(dir, "src/a.ts")).toBe(path.join(dir, "src", "a.ts"));
    expect(resolvePath(dir, '"src/a.ts"')).toBe(path.join(dir, "src", "a.ts"));
    expect(resolvePath(dir, path.join(dir, "x"))).toBe(path.join(dir, "x"));
    expect(displayPath(dir, path.join(dir, "src", "a.ts"))).toBe(path.join("src", "a.ts"));
    expect(displayPath(dir, dir)).toBe(".");
    const outside = path.resolve(dir, "..", "elsewhere.txt");
    expect(displayPath(dir, outside)).toBe(outside);
  });

  it("knows what is inside the project", () => {
    expect(isInside(dir, path.join(dir, "a", "b"))).toBe(true);
    expect(isInside(dir, path.join(dir, "..foo"))).toBe(true);
    expect(isInside(dir, path.resolve(dir, ".."))).toBe(false);
    expect(isInside(dir, path.resolve(dir, "..", path.basename(dir) + "-other", "x"))).toBe(false);
  });
});

describe("read_file", () => {
  it("returns numbered lines and the line count", async () => {
    write("src/app.ts", "const a = 1;\nconst b = 2;\n");
    const res = await run(readFileTool, { path: "src/app.ts" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("   1\tconst a = 1;\n   2\tconst b = 2;");
    expect(res.display?.detail).toBe("2 lines");
    expect(readFileTool.describe({ path: "src/app.ts" }, ctx)).toEqual({ verb: "read", target: path.join("src", "app.ts") });
  });

  it("reads CRLF files without carriage returns and drops a BOM", async () => {
    write("win.txt", "﻿first\r\nsecond\r\n");
    const res = await run(readFileTool, { path: "win.txt" });
    expect(res.content).toBe("   1\tfirst\n   2\tsecond");
  });

  it("pages with offset and limit and says how to go on", async () => {
    write("long.txt", Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
    const res = await run(readFileTool, { path: "long.txt", offset: 10, limit: 5 });
    expect(res.content.split("\n").slice(0, 5)).toEqual(["  10\tline 10", "  11\tline 11", "  12\tline 12", "  13\tline 13", "  14\tline 14"]);
    expect(res.content).toContain("[Lines 10-14 of 50. Call read_file with offset 15 to read more.]");
    expect(res.display?.detail).toBe("5 lines");
  });

  it("reads 2000 lines by default and notes the rest", async () => {
    write("big.txt", Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n"));
    const res = await run(readFileTool, { path: "big.txt" });
    expect(res.display?.detail).toBe("2000 lines");
    expect(res.content).toContain("2000\tl2000");
    expect(res.content).not.toContain("l2001");
    expect(res.content).toContain("offset 2001");
  });

  it("cuts very long lines", async () => {
    write("min.js", `${"x".repeat(5000)}\nshort`);
    const res = await run(readFileTool, { path: "min.js" });
    const first = res.content.split("\n")[0];
    expect(first.length).toBeLessThan(2100);
    expect(first).toContain("[line cut]");
    expect(res.content).toContain("longer than 2000 characters");
  });

  it("refuses binary files and folders, and suggests similar names", async () => {
    write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48]));
    write("src/App.tsx", "x");
    const bin = await run(readFileTool, { path: "logo.png" });
    expect(bin.isError).toBe(true);
    expect(bin.content).toMatch(/binary/);
    const folder = await run(readFileTool, { path: "src" });
    expect(folder.isError).toBe(true);
    expect(folder.content).toMatch(/list_files/);
    const missing = await run(readFileTool, { path: "src/app.tsx" });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("File not found");
    expect(missing.content).toContain(path.join("src", "App.tsx"));
  });

  it("handles empty files and offsets past the end", async () => {
    write("empty.txt", "");
    write("three.txt", "a\nb\nc\n");
    expect((await run(readFileTool, { path: "empty.txt" })).content).toMatch(/empty/);
    const past = await run(readFileTool, { path: "three.txt", offset: 9 });
    expect(past.isError).toBe(true);
    expect(past.content).toContain("3 lines");
  });
});

describe("write_file", () => {
  it("creates files with parent folders and shows every line as added", async () => {
    expect(writeFileTool.describe({ path: "src/new/thing.ts", content: "" }, ctx).verb).toBe("new");
    const res = await run(writeFileTool, { path: "src/new/thing.ts", content: "export const a = 1;\nexport const b = 2;\n" });
    expect(res.isError).toBeFalsy();
    expect(read("src/new/thing.ts")).toBe("export const a = 1;\nexport const b = 2;\n");
    expect(res.display?.verb).toBe("new");
    expect(res.display?.added).toBe(2);
    expect(res.display?.removed).toBe(0);
    expect(res.display?.diff?.map((l) => [l.kind, l.line])).toEqual([
      ["add", 1],
      ["add", 2],
    ]);
    expect(res.display?.detail).toBe("2 lines added");
    expect(res.content).toContain("Created");
  });

  it("caps the diff of a big new file but counts every line", async () => {
    const content = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join("\n");
    const res = await run(writeFileTool, { path: "big.txt", content });
    expect(res.display?.added).toBe(1000);
    expect(res.display!.diff!.length).toBeLessThanOrEqual(200);
  });

  it("overwrites with a real diff and keeps CRLF line endings", async () => {
    write("win.txt", "one\r\ntwo\r\nthree\r\n");
    expect(writeFileTool.describe({ path: "win.txt", content: "" }, ctx).verb).toBe("write");
    const res = await run(writeFileTool, { path: "win.txt", content: "one\nTWO\nthree\n" });
    expect(read("win.txt")).toBe("one\r\nTWO\r\nthree\r\n");
    expect(res.display?.verb).toBe("write");
    expect(res.display?.added).toBe(1);
    expect(res.display?.removed).toBe(1);
    expect(res.display?.diff).toContainEqual({ kind: "add", line: 2, text: "TWO" });
    expect(res.display?.diff).toContainEqual({ kind: "del", line: 2, text: "two" });
  });

  it("is an edit inside the project and 'other' outside, and says so", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-outside-"));
    try {
      const outside = path.join(outsideDir, "notes.txt");
      expect(typeof writeFileTool.risk === "function" && writeFileTool.risk({ path: "a.txt", content: "" }, ctx)).toBe("edit");
      expect(typeof writeFileTool.risk === "function" && writeFileTool.risk({ path: outside, content: "" }, ctx)).toBe("other");
      const approval = writeFileTool.approval!({ path: outside, content: "hi\n" }, ctx);
      expect(approval.risk).toBe("other");
      expect(approval.summary).toContain("outside the project");
      expect(approval.allowKey).toBe(`write_file:${outside}`);
      expect(approval.detail).toContain("+    1 hi");
      expect(writeFileTool.approval!({ path: "a.txt", content: "x" }, ctx).allowKey).toBe("write_file");
    } finally {
      removeDir(outsideDir);
    }
  });

  it("asks before writing outside the project in auto-edit mode", async () => {
    const agent = new Agent({ name: "vega", role: "worker", model: { provider: "x", model: "y" } }, new Notifier(), "auto-edit");
    const outside = path.join(os.tmpdir(), `lu-minal-outside-${process.pid}-${Date.now()}.txt`);
    const call = runToolCall({ agent, tool: writeFileTool, name: "write_file", toolCallId: "c1", args: { path: outside, content: "x" }, ctx });
    await new Promise((r) => setTimeout(r, 10));
    expect(agent.pendingApproval?.risk).toBe("other");
    agent.answerApproval("deny");
    const res = await call;
    expect(res.isError).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);

    // Inside the project the same mode just writes.
    const inside = await runToolCall({ agent, tool: writeFileTool, name: "write_file", toolCallId: "c2", args: { path: "in.txt", content: "x" }, ctx });
    expect(inside.isError).toBeFalsy();
    expect(read("in.txt")).toBe("x");
  });

  it("rejects missing content and folder targets", async () => {
    write("src/a.ts", "x");
    expect((await run(writeFileTool, { path: "a.txt" })).isError).toBe(true);
    expect((await run(writeFileTool, { path: "src", content: "x" })).content).toMatch(/folder/);
  });
});

describe("edit_file", () => {
  const source = ["import x from 'x';", "", "function moon() {", "  const phase = 'new';", "  return phase;", "}", "", "export default moon;", ""].join("\n");

  it("replaces a unique match and reports the change with real line numbers", async () => {
    write("src/moon.ts", source);
    const res = await run(editFileTool, { path: "src/moon.ts", old_string: "  const phase = 'new';", new_string: "  const phase = 'full';" });
    expect(res.isError).toBeFalsy();
    expect(read("src/moon.ts")).toContain("const phase = 'full';");
    expect(res.display?.diff).toEqual([
      { kind: "ctx", line: 3, text: "function moon() {" },
      { kind: "del", line: 4, text: "  const phase = 'new';" },
      { kind: "add", line: 4, text: "  const phase = 'full';" },
      { kind: "ctx", line: 5, text: "  return phase;" },
    ]);
    expect(res.display?.detail).toBe("1 line changed");
    expect(res.display?.added).toBe(1);
    expect(res.display?.removed).toBe(1);
    expect(res.content).toContain("4\t  const phase = 'full';");
  });

  it("keeps CRLF line endings when old/new strings use \\n", async () => {
    write("win.ts", "a\r\nb\r\nc\r\n");
    const res = await run(editFileTool, { path: "win.ts", old_string: "a\nb", new_string: "a\nB\nb2" });
    expect(res.isError).toBeFalsy();
    expect(read("win.ts")).toBe("a\r\nB\r\nb2\r\nc\r\n");
    expect(res.display?.diff?.filter((l) => l.kind === "add").map((l) => l.line)).toEqual([2, 3]);
  });

  it("refuses ambiguous matches with the count and lines, unless replace_all", async () => {
    write("dup.txt", "x = 1\ny = 2\nx = 1\nx = 1\n");
    const res = await run(editFileTool, { path: "dup.txt", old_string: "x = 1", new_string: "x = 3" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("appears 3 times");
    expect(res.content).toContain("lines 1, 3, 4");
    expect(read("dup.txt")).toBe("x = 1\ny = 2\nx = 1\nx = 1\n");

    const all = await run(editFileTool, { path: "dup.txt", old_string: "x = 1", new_string: "x = 3", replace_all: true });
    expect(all.isError).toBeFalsy();
    expect(read("dup.txt")).toBe("x = 3\ny = 2\nx = 3\nx = 3\n");
    expect(all.content).toContain("3 replacements");
  });

  it("shows the closest line when old_string is not found", async () => {
    write("src/moon.ts", source);
    const res = await run(editFileTool, { path: "src/moon.ts", old_string: "const phaze = 'new';", new_string: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
    expect(res.content).toContain("closest line is 4");
    expect(res.display?.detail).toBe("old_string not found");
  });

  it("hints at whitespace differences", async () => {
    write("tabs.ts", "if (a) {\n\treturn 1;\n}\n");
    const res = await run(editFileTool, { path: "tabs.ts", old_string: "if (a) {\n    return 1;\n}", new_string: "x" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/whitespace is ignored/);
  });

  it("does not expand $ patterns in the replacement", async () => {
    write("money.ts", "const price = 0;\n");
    await run(editFileTool, { path: "money.ts", old_string: "0", new_string: "'$&$1$$'" });
    expect(read("money.ts")).toBe("const price = '$&$1$$';\n");
  });

  it("creates a new file from an empty old_string, but won't clobber content", async () => {
    const created = await run(editFileTool, { path: "fresh/new.md", old_string: "", new_string: "# Hi\n" });
    expect(created.isError).toBeFalsy();
    expect(created.display?.verb).toBe("new");
    expect(read("fresh/new.md")).toBe("# Hi\n");
    const refused = await run(editFileTool, { path: "fresh/new.md", old_string: "", new_string: "other" });
    expect(refused.isError).toBe(true);
  });

  it("validates its arguments", async () => {
    write("a.txt", "a");
    expect((await run(editFileTool, { path: "a.txt", old_string: "a", new_string: "a" })).content).toMatch(/same/);
    expect((await run(editFileTool, { path: "a.txt", new_string: "b" })).isError).toBe(true);
    expect((await run(editFileTool, { path: "missing.txt", old_string: "a", new_string: "b" })).content).toMatch(/write_file/);
  });

  it("is riskier outside the project", () => {
    const risk = editFileTool.risk as (a: Record<string, unknown>, c: ToolContext) => string;
    expect(risk({ path: "a.txt" }, ctx)).toBe("edit");
    expect(risk({ path: path.resolve(dir, "..", "x.txt") }, ctx)).toBe("other");
    write("a.txt", "hello\n");
    const approval = editFileTool.approval!({ path: "a.txt", old_string: "hello", new_string: "bye" }, ctx);
    expect(approval.detail).toContain("-    1 hello");
    expect(approval.detail).toContain("+    1 bye");
  });
});

describe("list_files", () => {
  it("globs, skips ignored folders and sorts newest first", async () => {
    write(".gitignore", "generated/\n*.tmp\n");
    const old = write("src/old.ts", "o");
    write("src/deep/mid.ts", "m");
    const fresh = write("src/new.tsx", "n");
    write("src/skip.tmp", "t");
    write("generated/out.ts", "g");
    write("node_modules/dep/index.ts", "d");
    write("README.md", "r");
    const now = Date.now() / 1000;
    fs.utimesSync(old, now - 300, now - 300);
    fs.utimesSync(path.join(dir, "src", "deep", "mid.ts"), now - 200, now - 200);
    fs.utimesSync(fresh, now - 100, now - 100);

    const res = await run(listFilesTool, { pattern: "src/**/*.{ts,tsx}" });
    expect(res.content.split("\n")).toEqual([
      path.join("src", "new.tsx"),
      path.join("src", "deep", "mid.ts"),
      path.join("src", "old.ts"),
    ]);
    expect(res.display?.detail).toBe("3 files");

    const names = await run(listFilesTool, { pattern: "*.ts" });
    expect(names.content.split("\n").sort()).toEqual([path.join("src", "deep", "mid.ts"), path.join("src", "old.ts")].sort());

    const everything = await run(listFilesTool, {});
    expect(everything.content).toContain("README.md");
    expect(everything.content).not.toContain("generated");
    expect(everything.content).not.toContain("node_modules");
    expect(everything.content).not.toContain("skip.tmp");
  });

  it("lists a sub folder with paths relative to the project and honours limit", async () => {
    for (let i = 0; i < 8; i++) write(`pkg/f${i}.txt`, "x");
    const res = await run(listFilesTool, { path: "pkg", limit: 3 });
    const lines = res.content.split("\n");
    expect(lines.slice(0, 3).every((l) => l.startsWith(`pkg${path.sep}`))).toBe(true);
    expect(res.content).toContain("Showing the 3 newest of 8 files");
    expect(res.display?.detail).toBe("8 files");
  });

  it("explains empty results and missing folders", async () => {
    write("a.txt", "x");
    expect((await run(listFilesTool, { pattern: "*.rs" })).content).toMatch(/No files match/);
    expect((await run(listFilesTool, { path: "nope" })).isError).toBe(true);
  });
});

describe("grep", () => {
  function fixture() {
    write(".gitignore", "ignored/\n");
    write("src/moon.ts", "export const phase = 'full';\n// TODO: wax\nconst Phase = 2;\n");
    write("src/sky.tsx", "const stars = 3; // todo later\n");
    write("ignored/x.ts", "phase\n");
    write("node_modules/m/index.js", "phase\n");
    write("bin.dat", Buffer.concat([Buffer.from("phase"), Buffer.from([0, 1, 2, 3])]));
    write("big.txt", `${"phase\n".repeat(10)}${"x".repeat(2.2 * 1024 * 1024)}`);
  }

  const engines: Array<[string, Tool]> = [
    ["JS fallback", createGrepTool({ rg: null })],
    ["ripgrep (when installed)", createGrepTool()],
  ];

  for (const [label, grep] of engines) {
    describe(label, () => {
      it("finds matches as path:line: text, skipping ignored, binary and big files", async () => {
        fixture();
        const res = await run(grep, { pattern: "phase" });
        expect(res.isError).toBeFalsy();
        expect(res.content.split("\n")).toEqual([`${path.join("src", "moon.ts")}:1: export const phase = 'full';`]);
        expect(res.display?.detail).toBe("1 hit");
      });

      it("ignores case, filters by glob and searches a single file", async () => {
        fixture();
        const ci = await run(grep, { pattern: "todo", ignore_case: true });
        expect(ci.content.split("\n")).toEqual([
          `${path.join("src", "moon.ts")}:2: // TODO: wax`,
          `${path.join("src", "sky.tsx")}:1: const stars = 3; // todo later`,
        ]);
        const globbed = await run(grep, { pattern: "todo", ignore_case: true, glob: "*.tsx" });
        expect(globbed.content).toBe(`${path.join("src", "sky.tsx")}:1: const stars = 3; // todo later`);
        const single = await run(grep, { pattern: "[Pp]hase", path: "src/moon.ts" });
        expect(single.content.split("\n").map((l) => l.split(": ")[0])).toEqual([
          `${path.join("src", "moon.ts")}:1`,
          `${path.join("src", "moon.ts")}:3`,
        ]);
      });

      it("stops at max_results and says so", async () => {
        write("many.txt", Array.from({ length: 50 }, (_, i) => `hit ${i}`).join("\n"));
        const res = await run(grep, { pattern: "hit", max_results: 5 });
        expect(res.content.split("\n\n")[0].split("\n")).toHaveLength(5);
        expect(res.content).toContain("Stopped at 5 results");
      });

      it("reports no matches and bad patterns", async () => {
        write("a.txt", "nothing here");
        const none = await run(grep, { pattern: "moon" });
        expect(none.isError).toBeFalsy();
        expect(none.content).toBe("No matches.");
        expect(none.display?.detail).toBe("0 hits");
        const bad = await run(grep, { pattern: "(unclosed" });
        expect(bad.isError).toBe(true);
      });
    });
  }

  it("falls back to the JS search when the ripgrep program can't start", async () => {
    write("a.txt", "moon\n");
    const res = await run(createGrepTool({ rg: path.join(dir, "no-such-rg") }), { pattern: "moon" });
    expect(res.content).toBe("a.txt:1: moon");
  });
});
