import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitIgnore, globToRegExp, looksBinary, patternMatcher, toPosix, walkFiles } from "../../src/tools/glob.js";
import { removeDir, tempProject } from "./helpers.js";

describe("globToRegExp", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*.ts", "app.ts", true],
    ["*.ts", "src/app.ts", false],
    ["*.ts", "app.tsx", false],
    ["src/**/*.ts", "src/app.ts", true],
    ["src/**/*.ts", "src/a/b/c/app.ts", true],
    ["src/**/*.ts", "lib/app.ts", false],
    ["src/**/*.ts", "src/app.js", false],
    ["**/*.md", "README.md", true],
    ["**/*.md", "docs/guide/intro.md", true],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["*.{js,ts}", "index.js", true],
    ["*.{js,ts}", "index.ts", true],
    ["*.{js,ts}", "index.tsx", false],
    ["{src,test}/**/*.{ts,tsx}", "test/ui/a.tsx", true],
    ["{src,test}/**/*.{ts,tsx}", "docs/a.ts", false],
    ["*.{test.{ts,js},spec.ts}", "a.test.js", true],
    ["*.{test.{ts,js},spec.ts}", "a.spec.ts", true],
    ["*.{test.{ts,js},spec.ts}", "a.spec.js", false],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file12.txt", false],
    ["file?.txt", "file/.txt", false],
    ["[abc].ts", "b.ts", true],
    ["[abc].ts", "d.ts", false],
    ["[!abc].ts", "d.ts", true],
    ["[!abc].ts", "a.ts", false],
    ["[a-c]x", "bx", true],
    ["a.b", "axb", false],
    ["a+(b).ts", "a+(b).ts", true],
    ["$weird^.ts", "$weird^.ts", true],
    ["./src/*.ts", "src/a.ts", true],
  ];
  it.each(cases)("%s against %s -> %s", (glob, p, expected) => {
    expect(globToRegExp(glob).test(p)).toBe(expected);
  });

  it("can ignore case", () => {
    expect(globToRegExp("*.TS").test("a.ts")).toBe(false);
    expect(globToRegExp("*.TS", { nocase: true }).test("a.ts")).toBe(true);
  });

  it("treats unbalanced brackets and braces as literal text", () => {
    expect(globToRegExp("a[b").test("a[b")).toBe(true);
    expect(globToRegExp("a{b").test("a{b")).toBe(true);
  });
});

describe("patternMatcher", () => {
  it("matches file names at any depth when the pattern has no slash", () => {
    const m = patternMatcher("*.ts");
    expect(m("a.ts")).toBe(true);
    expect(m("src/deep/a.ts")).toBe(true);
    expect(m("src/a.js")).toBe(false);
  });

  it("matches the whole path when the pattern has a slash (backslashes too)", () => {
    expect(patternMatcher("src/*.ts")("src/a.ts")).toBe(true);
    expect(patternMatcher("src/*.ts")("lib/src/a.ts")).toBe(false);
    expect(patternMatcher("src\\**\\*.ts")("src/x/a.ts")).toBe(true);
  });

  it("matches everything for empty and catch-all patterns", () => {
    for (const p of ["", "*", "**", "**/*"]) expect(patternMatcher(p)("a/b/c.txt")).toBe(true);
  });
});

describe("GitIgnore", () => {
  const ig = new GitIgnore(
    [
      "# build output",
      "",
      "*.log",
      "!keep.log",
      "coverage/",
      "/secret.txt",
      "docs/*.pdf",
      "**/tmp",
      "\\#notes",
    ].join("\r\n"),
  );

  it("matches base names at any depth", () => {
    expect(ig.ignores("debug.log", false)).toBe(true);
    expect(ig.ignores("a/b/debug.log", false)).toBe(true);
  });

  it("supports negation", () => {
    expect(ig.ignores("keep.log", false)).toBe(false);
    expect(ig.ignores("sub/keep.log", false)).toBe(false);
  });

  it("applies trailing-slash rules to folders only", () => {
    expect(ig.ignores("coverage", true)).toBe(true);
    expect(ig.ignores("pkg/coverage", true)).toBe(true);
    expect(ig.ignores("coverage", false)).toBe(false);
  });

  it("anchors rules with a slash to the root", () => {
    expect(ig.ignores("secret.txt", false)).toBe(true);
    expect(ig.ignores("sub/secret.txt", false)).toBe(false);
    expect(ig.ignores("docs/a.pdf", false)).toBe(true);
    expect(ig.ignores("other/docs/a.pdf", false)).toBe(false);
    expect(ig.ignores("x/y/tmp", true)).toBe(true);
  });

  it("reads escaped leading characters literally and skips comments", () => {
    expect(ig.ignores("#notes", false)).toBe(true);
    expect(ig.ignores("# build output", false)).toBe(false);
  });

  it("is empty without rules", () => {
    expect(new GitIgnore("# only a comment\n\n").empty).toBe(true);
  });
});

describe("walkFiles", () => {
  let dir = "";
  afterEach(() => removeDir(dir));

  it("skips dependency and build folders and what .gitignore excludes", async () => {
    dir = tempProject({
      ".gitignore": "*.log\nout/\n",
      "src/a.ts": "a",
      "src/b/c.ts": "c",
      "node_modules/pkg/index.js": "x",
      "dist/bundle.js": "x",
      ".git/HEAD": "ref",
      "__pycache__/m.pyc": "x",
      "target/debug/app": "x",
      "out/x.txt": "x",
      "debug.log": "x",
      ".github/workflows/ci.yml": "on: push",
    });
    const ignore = await GitIgnore.load(dir);
    const { files } = await walkFiles(dir, { ignore });
    expect(files.map((f) => f.rel).sort()).toEqual([".github/workflows/ci.yml", ".gitignore", "src/a.ts", "src/b/c.ts"]);
    const a = files.find((f) => f.rel === "src/a.ts")!;
    expect(a.abs).toBe(path.join(dir, "src", "a.ts"));
    expect(a.size).toBe(1);
  });

  it("stops at maxFiles and reports it", async () => {
    dir = tempProject(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, "x"])));
    const { files, truncated } = await walkFiles(dir, { maxFiles: 5 });
    expect(files).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it("does not follow symlinked folders", async () => {
    dir = tempProject({ "real/a.txt": "a" });
    try {
      fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"), "junction");
    } catch {
      return; // no symlink rights (Windows without developer mode)
    }
    const { files } = await walkFiles(dir);
    expect(files.map((f) => f.rel)).toEqual(["real/a.txt"]);
  });
});

describe("looksBinary / toPosix", () => {
  it("spots NUL bytes and control-character soup", () => {
    expect(looksBinary(Buffer.from("hello\nworld\n"))).toBe(false);
    expect(looksBinary(Buffer.from("café ☃ \u001b[31mred\u001b[0m\r\n", "utf8"))).toBe(false);
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toBe(true);
    expect(looksBinary(Buffer.from(Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : 65))))).toBe(true);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  it("turns native separators into slashes", () => {
    expect(toPosix(["a", "b", "c.ts"].join(path.sep))).toBe("a/b/c.ts");
    expect(toPosix("a\\b\\c.ts")).toBe("a/b/c.ts");
  });
});
