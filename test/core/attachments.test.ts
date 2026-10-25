import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  attachmentFromPath,
  clipboardImageCommands,
  describeAttachment,
  droppedFiles,
  messageParts,
  pruneAttachments,
  splitDroppedText,
} from "../../src/core/attachments.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-att-"));
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("dropped files", () => {
  it("splits the paths terminals paste for dropped files", () => {
    expect(splitDroppedText("/Users/me/My\\ Shot.png /tmp/a.txt", "darwin")).toEqual(["/Users/me/My Shot.png", "/tmp/a.txt"]);
    expect(splitDroppedText("'/home/me/a b.png' '/home/me/c.md'", "linux")).toEqual(["/home/me/a b.png", "/home/me/c.md"]);
    expect(splitDroppedText("file:///home/me/x%20y.png", "linux")).toEqual(["/home/me/x y.png"]);
    expect(splitDroppedText('"C:\\Users\\me\\shot one.png" C:\\x\\b.txt', "win32")).toEqual(["C:\\Users\\me\\shot one.png", "C:\\x\\b.txt"]);
  });

  it("only treats a paste as files when every part is an existing file", () => {
    const a = path.join(dir, "shot one.png");
    const b = path.join(dir, "notes.md");
    fs.writeFileSync(a, PNG);
    fs.writeFileSync(b, "# notes");
    // The real paths of this OS, pasted the way its terminals do it.
    const platform = process.platform;
    const win = platform === "win32";
    const q = (p: string) => (win ? `"${p}"` : `'${p}'`);
    expect(droppedFiles(`${q(a)} ${q(b)}`, platform)).toEqual([a, b]);
    // macOS and Linux terminals also escape spaces with a backslash (a path separator on Windows).
    if (!win) expect(droppedFiles(a.replace(/ /g, "\\ "), platform)).toEqual([a]);
    expect(droppedFiles(`please look at ${q(a)}`, platform)).toBeNull();
    expect(droppedFiles("hello world", platform)).toBeNull();
    expect(droppedFiles(q(path.join(dir, "missing.png")), platform)).toBeNull();
    expect(droppedFiles(q(dir), platform)).toBeNull();
  });
});

describe("attachmentFromPath", () => {
  it("tells pictures, text and other files apart", () => {
    fs.writeFileSync(path.join(dir, "a.png"), PNG);
    fs.writeFileSync(path.join(dir, "b.md"), "hello");
    fs.writeFileSync(path.join(dir, "c.bin"), Buffer.from([0, 1, 2, 0]));
    const img = attachmentFromPath(path.join(dir, "a.png"));
    const txt = attachmentFromPath(path.join(dir, "b.md"));
    const bin = attachmentFromPath(path.join(dir, "c.bin"));
    expect(img).toMatchObject({ kind: "image", mediaType: "image/png", name: "a.png" });
    expect(txt).toMatchObject({ kind: "text", mediaType: "text/markdown" });
    expect(bin).toMatchObject({ kind: "file", mediaType: "application/octet-stream" });
    expect(attachmentFromPath(path.join(dir, "nope.txt"))).toMatch(/No such file/);
    expect(attachmentFromPath(dir)).toMatch(/folder/);
    if (typeof img !== "string") expect(describeAttachment(img)).toBe("a.png · 11 B");
  });
});

describe("messageParts", () => {
  it("sends pictures as images to models that can see, and inlines text files", () => {
    fs.writeFileSync(path.join(dir, "a.png"), PNG);
    fs.writeFileSync(path.join(dir, "b.txt"), "line one");
    const img = attachmentFromPath(path.join(dir, "a.png"));
    const txt = attachmentFromPath(path.join(dir, "b.txt"));
    if (typeof img === "string" || typeof txt === "string") throw new Error("setup");
    const seeing = messageParts("what is this?", [img, txt], { images: true });
    expect(seeing[0].type).toBe("text");
    if (seeing[0].type === "text") {
      expect(seeing[0].text).toContain("what is this?");
      expect(seeing[0].text).toContain("picture, shown below");
      expect(seeing[0].text).toContain("line one");
    }
    expect(seeing[1]).toMatchObject({ type: "image", mediaType: "image/png", data: PNG.toString("base64") });

    const blind = messageParts("what is this?", [img], { images: false });
    expect(blind).toHaveLength(1);
    if (blind[0].type === "text") expect(blind[0].text).toContain("can't see pictures");
    expect(messageParts("plain", [], { images: true })).toEqual([{ type: "text", text: "plain" }]);
  });
});

describe("clipboard commands", () => {
  it("uses osascript, PowerShell and wl-paste / xclip", () => {
    expect(clipboardImageCommands("/tmp/x.png", "darwin")[0].exe).toBe("osascript");
    const win = clipboardImageCommands("C:\\t\\x.png", "win32");
    expect(win[0].exe).toBe("powershell.exe");
    expect(win[0].args).toContain("-STA");
    expect(win[0].args.join(" ")).toContain("C:\\t\\x.png");
    expect(clipboardImageCommands("/tmp/x.png", "linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.exe)).toEqual(["wl-paste", "xclip"]);
    expect(clipboardImageCommands("/tmp/x.png", "linux", {}).map((c) => c.exe)).toEqual(["xclip"]);
  });
});

describe("pruneAttachments", () => {
  it("removes old clipboard pictures only", () => {
    const old = path.join(dir, "old.png");
    const fresh = path.join(dir, "fresh.png");
    fs.writeFileSync(old, PNG);
    fs.writeFileSync(fresh, PNG);
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(old, longAgo, longAgo);
    pruneAttachments(dir, 30);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
