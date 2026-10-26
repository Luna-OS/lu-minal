// Secret stores, protected project files and symlink escapes: what the file tools, Claude Code's
// approvals and the shell rules treat as more than a plain read or edit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { createGrepTool, readFileTool, writeFileTool, editFileTool } from "../../src/tools/fs.js";
import { runToolCall } from "../../src/tools/run.js";
import { assessRead, assessWrite, isRealInside, isUncPath, protectedProjectPath } from "../../src/tools/sensitive.js";
import type { Tool } from "../../src/tools/types.js";
import { makeCtx } from "./helpers.js";

let home = "";
let project = "";
let outside = "";

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lu-minal-sec-")));
  project = path.join(home, "code", "app");
  outside = path.join(home, "elsewhere");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "secret\n");
  fs.writeFileSync(path.join(home, ".bashrc"), "# rc\n");
  vi.stubEnv("LU_MINAL_HOME_DIR", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A symlink, or false where this machine doesn't allow one (Windows without developer mode). */
function link(target: string, at: string, type: "file" | "junction"): boolean {
  try {
    fs.symlinkSync(target, at, type);
    return true;
  } catch {
    return false;
  }
}

const risk = (tool: Tool, args: Record<string, unknown>) => {
  const ctx = makeCtx({ cwd: project });
  return typeof tool.risk === "function" ? tool.risk(args, ctx) : tool.risk;
};

describe("assessWrite", () => {
  it("lets ordinary project files be edits and asks for the rest", () => {
    expect(assessWrite(project, path.join(project, "src", "a.ts"), { home })).toMatchObject({ risk: "edit", outside: false });
    expect(assessWrite(project, path.join(outside, "a.ts"), { home })).toMatchObject({ risk: "other", outside: true });
    for (const rel of [".git/hooks/pre-commit", "vendor/lib/.git/config", ".claude/settings.json", ".mcp.json", "opencode.json", ".gemini/settings.json", ".opencode/x.json"]) {
      expect(assessWrite(project, path.join(project, ...rel.split("/")), { home }).risk, rel).toBe("other");
    }
    expect(protectedProjectPath(project, path.join(project, "docs", "claude.md"))).toBeNull();
  });

  it("follows a symlinked folder out of the project", () => {
    if (!link(outside, path.join(project, "out"), "junction")) return;
    expect(assessWrite(project, path.join(project, "out", "x.txt"), { home })).toMatchObject({ risk: "other", outside: true });
  });

  it("follows a file symlink, also a dangling one a write would create", () => {
    if (!link(path.join(home, ".bashrc"), path.join(project, "notes.md"), "file")) return;
    expect(assessWrite(project, path.join(project, "notes.md"), { home })).toMatchObject({ risk: "other", outside: true });
    if (!link(path.join(outside, "new-file"), path.join(project, "later.md"), "file")) return;
    expect(assessWrite(project, path.join(project, "later.md"), { home })).toMatchObject({ risk: "other", outside: true });
  });

  it("tells the project from a folder that differs only in case on macOS, not on Windows", () => {
    // A case-sensitive APFS volume can have /Users/ada/Proj next to /Users/ada/proj; on the default
    // volume the real path already has the case on disk.
    expect(isRealInside("/Users/ada/proj", "/Users/ada/Proj/evil.sh", "darwin")).toBe(false);
    expect(assessWrite("/Users/ada/proj", "/Users/ada/Proj/.git/hooks/pre-commit", { platform: "darwin" })).toMatchObject({ risk: "other", outside: true });
    expect(assessWrite("/Users/ada/proj", "/Users/ada/Proj/src/x.ts", { platform: "darwin" }).risk).toBe("other");
    expect(assessWrite("/Users/ada/proj", "/Users/ada/proj/.GIT/config", { platform: "darwin" }).risk).toBe("other");
    expect(assessWrite("/Users/ada/proj", "/Users/ada/proj/src/x.ts", { platform: "darwin" }).risk).toBe("edit");
    expect(isRealInside("C:\\Users\\ada\\proj", "c:\\users\\ADA\\Proj\\x.ts", "win32")).toBe(true);
    expect(assessWrite("C:\\Users\\ada\\proj", "c:\\users\\ada\\PROJ\\.Git\\config", { platform: "win32" }).risk).toBe("other");
  });

  it("asks for secrets and dotfiles of a home folder opened as the project", () => {
    expect(assessWrite(home, path.join(home, ".ssh", "authorized_keys"), { home })).toMatchObject({ risk: "other", reason: "secret" });
    expect(assessWrite(home, path.join(home, ".bashrc"), { home })).toMatchObject({ risk: "other", reason: "home dotfile" });
    expect(assessWrite(home, path.join(home, "code", "a.ts"), { home }).risk).toBe("edit");
  });
});

describe("assessRead", () => {
  it("asks for secret stores, searches that reach them and network shares", () => {
    expect(assessRead(path.join(home, ".ssh", "id_ed25519"), { home })).toBe("other");
    expect(assessRead(path.join(project, "README.md"), { home })).toBe("read");
    expect(assessRead(home, { home })).toBe("read");
    expect(assessRead(home, { home, recursive: true })).toBe("other");
    expect(assessRead(project, { home, recursive: true })).toBe("read");
    expect(isUncPath("\\\\attacker.example\\share\\x", "win32")).toBe(true);
    expect(isUncPath("//attacker.example/share/x", "win32")).toBe(true);
    expect(isUncPath("\\\\?\\C:\\long\\path", "win32")).toBe(false);
    expect(isUncPath("C:\\Users\\ada", "win32")).toBe(false);
    // A project that lives on a share may use it; another server may not be reached.
    const share = "\\\\srv\\share\\proj";
    expect(assessRead(`${share}\\a.ts`, { platform: "win32", cwd: share })).toBe("read");
    expect(assessRead("\\\\attacker.example\\x\\y", { platform: "win32", cwd: share })).toBe("other");
    expect(assessWrite(share, `${share}\\a.ts`, { platform: "win32" }).risk).toBe("edit");
    expect(assessWrite(share, "\\\\attacker.example\\x\\y", { platform: "win32" })).toMatchObject({ risk: "other", reason: "network path" });
  });

  it("treats the Windows window's cloud pane data (the claude.ai sign-in) as a secret store", () => {
    const win = { platform: "win32" as const, home: "C:\\Users\\ada", env: { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" } };
    const pane = "C:\\Users\\ada\\AppData\\Local\\lu-minal\\WebView2";
    expect(assessRead(`${pane}\\EBWebView\\Default\\Network\\Cookies`, win)).toBe("other");
    expect(assessRead("c:\\users\\ADA\\appdata\\local\\LU-MINAL\\webview2\\EBWebView\\Local State", win)).toBe("other");
    expect(assessRead("C:\\Users\\ada\\AppData\\Local\\lu-minal", { ...win, recursive: true })).toBe("other");
    // The window's own settings next to it are not a secret.
    expect(assessRead("C:\\Users\\ada\\AppData\\Local\\lu-minal\\window.json", win)).toBe("read");
    expect(assessWrite("C:\\Users\\ada\\code", `${pane}\\EBWebView\\Default\\Preferences`, win)).toMatchObject({ risk: "other" });
  });

  it("treats the macOS app's cloud pane data (the claude.ai sign-in) as a secret store", () => {
    const mac = { platform: "darwin" as const, home: "/Users/ada", env: {} };
    expect(assessRead("/Users/ada/Library/HTTPStorages/os.luna.lu-minal/httpstorages.sqlite", mac)).toBe("other");
    expect(assessRead("/Users/ada/Library/HTTPStorages/os.luna.lu-minal.binarycookies", mac)).toBe("other");
    expect(assessRead("/Users/ada/Library/WebKit/os.luna.lu-minal/WebsiteData/LocalStorage/x", mac)).toBe("other");
    expect(assessRead("/Users/ada/Library/WebKit", { ...mac, recursive: true })).toBe("other");
    // Another app's WebKit data is not lu-minal's to guard.
    expect(assessRead("/Users/ada/Library/WebKit/com.example.notes/x", mac)).toBe("read");
  });
});

describe("the file tools", () => {
  it("ask before reading or searching a secret store", () => {
    expect(risk(readFileTool, { path: "~/.ssh/id_ed25519" })).toBe("other");
    expect(risk(readFileTool, { path: "../../.ssh/id_ed25519" })).toBe("other");
    expect(risk(readFileTool, { path: "README.md" })).toBe("read");
    const grep = createGrepTool({ rg: null });
    expect(risk(grep, { pattern: "key", path: "~" })).toBe("other");
    expect(risk(grep, { pattern: "key" })).toBe("read");
  });

  it("treat writes through a symlink and into .git as risky, remembered per file", () => {
    expect(risk(writeFileTool, { path: ".git/hooks/post-checkout", content: "x" })).toBe("other");
    expect(risk(editFileTool, { path: ".git/config", old_string: "a", new_string: "b" })).toBe("other");
    const approval = writeFileTool.approval!({ path: ".git/hooks/post-checkout", content: "x" } as never, makeCtx({ cwd: project }));
    expect(approval.allowKey).toBe(`write_file:${path.join(project, ".git", "hooks", "post-checkout")}`);
    expect(approval.summary).toContain("inside .git");
    if (!link(outside, path.join(project, "out"), "junction")) return;
    expect(risk(writeFileTool, { path: "out/payload.sh", content: "x" })).toBe("other");
  });

  it("ask in auto-edit mode before writing through a symlink out of the project", async () => {
    if (!link(outside, path.join(project, "out"), "junction")) return;
    const agent = new Agent({ name: "vega", role: "worker", model: { provider: "x", model: "y" } }, new Notifier(), "auto-edit");
    const ctx = makeCtx({ cwd: project });
    const pending = runToolCall({ agent, tool: writeFileTool, name: "write_file", toolCallId: "t1", args: { path: "out/payload.sh", content: "x" }, ctx });
    await vi.waitFor(() => expect(agent.pendingApproval).not.toBeNull());
    expect(agent.pendingApproval).toMatchObject({ risk: "other" });
    agent.answerApproval("deny");
    expect((await pending).isError).toBe(true);
    expect(fs.existsSync(path.join(outside, "payload.sh"))).toBe(false);
  });
});
