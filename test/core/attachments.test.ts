import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentFromPath,
  attachmentsDir,
  clipboardFiles,
  clipboardImage,
  clipboardImageCommands,
  describeAttachment,
  droppedFiles,
  MAX_IMAGE_BYTES,
  MAX_INLINE_TEXT,
  messageParts,
  parseUriList,
  pruneAttachments,
  readClipboard,
  splitDroppedText,
  type Attachment,
} from "../../src/core/attachments.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-att-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("checks the files again when the message goes out", () => {
    const attach = (name: string, data: string | Buffer) => {
      fs.writeFileSync(path.join(dir, name), data);
      return attachmentFromPath(path.join(dir, name)) as Attachment;
    };
    const gone = attach("gone.png", PNG);
    const goneText = attach("gone.txt", "bye");
    const bigShot = attach("big.png", PNG);
    const log = attach("build.log", "line one\n");
    fs.rmSync(gone.path);
    fs.rmSync(goneText.path);
    // Both grew after they were attached: the picture past the per-picture limit, the log past
    // what is inlined.
    fs.writeFileSync(bigShot.path, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    fs.writeFileSync(log.path, "x".repeat(MAX_INLINE_TEXT + 1));
    const parts = messageParts("look", [gone, goneText, bigShot, log], { images: true });
    expect(parts).toHaveLength(1);
    const text = parts[0].type === "text" ? parts[0].text : "";
    expect(text).toContain(`- ${gone.path} (picture, no longer there)`);
    expect(text).toContain(`- ${goneText.path} (text, no longer there)`);
    expect(text).toContain(`- ${bigShot.path} (picture, too large to show, 5.0 MB)`);
    expect(text).toContain(`- ${log.path} (text, 100 KB)`);
    expect(text).not.toContain("xxxx");
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

describe("clipboardImage", () => {
  // Windows has no file modes (the user's own profile folder protects the files there).
  it.skipIf(process.platform === "win32")("keeps screenshots private: the folder 0700, the files 0600", async () => {
    // Fake clipboard tools on the PATH that write a picture the way the real ones do: xclip and
    // wl-paste to stdout, osascript into the file its script names.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const picture = path.join(dir, "picture.png");
    fs.writeFileSync(picture, PNG);
    const osascript = path.join(dir, "osascript.cjs");
    fs.writeFileSync(
      osascript,
      `const file = /POSIX file "(.*)" with/.exec(process.argv.join(" "))[1];
require("node:fs").writeFileSync(file, require("node:fs").readFileSync(${JSON.stringify(picture)}));
process.stdout.write("ok");`,
    );
    for (const name of ["xclip", "wl-paste"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncat '${picture}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "osascript"), `#!/bin/sh\nexec '${process.execPath}' '${osascript}' "$@"\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);

    // A folder an older version made with the default modes is tightened; a new one is made private.
    const old = attachmentsDir(path.join(dir, "old"));
    fs.mkdirSync(old, { recursive: true });
    fs.chmodSync(old, 0o755);
    const fresh = attachmentsDir(path.join(dir, "fresh"));
    for (const folder of [old, fresh]) {
      const shot = await clipboardImage(folder);
      expect(shot).toMatchObject({ kind: "image", name: "clipboard.png", size: PNG.length });
      expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
      expect(fs.statSync(shot!.path).mode & 0o777).toBe(0o600);
    }
  });
});

describe("files copied in a file manager", () => {
  it("reads the paths of a text/uri-list", () => {
    expect(parseUriList("copy\nfile:///home/ada/My%20Shot.png\r\n# a comment\nhttps://example.com/x.png\nfile:///tmp/b.jpg\n")).toEqual(
      process.platform === "win32" ? [] : ["/home/ada/My Shot.png", "/tmp/b.jpg"],
    );
  });

  // Fake clipboard tools on the PATH, as the real ones answer when two files were copied.
  describe.skipIf(process.platform === "win32")("from the clipboard tools", () => {
    let bin = "";
    let shots: string[] = [];
    beforeEach(() => {
      bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      shots = ["a shot.png", "b.png"].map((n) => path.join(dir, n));
      for (const f of shots) fs.writeFileSync(f, PNG);
      const uris = shots.map((f) => pathToFileURL(f).href).join("\n");
      // xclip / wl-paste: the offered types, or the uri-list.
      const tool = `#!/bin/sh
case "$*" in
  *TARGETS*|*--list-types*) printf 'TARGETS\\ntext/uri-list\\nx-special/gnome-copied-files\\nimage/png\\n' ;;
  *text/uri-list*) printf '%s' '${uris}' ;;
  *image/png*) cat '${shots[1]}' ;;
  *) exit 1 ;;
esac
`;
      for (const name of ["xclip", "wl-paste"]) fs.writeFileSync(path.join(bin, name), tool, { mode: 0o755 });
      // osascript: the JavaScript asks for the pasteboard's file URLs (one path a line).
      fs.writeFileSync(path.join(bin, "osascript"), `#!/bin/sh\n[ "$2" = JavaScript ] && printf '%s\\n' ${shots.map((f) => `'${f}'`).join(" ")}\n`, { mode: 0o755 });
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    });

    it("lists them on X11, Wayland and macOS", async () => {
      expect(await clipboardFiles("linux", { PATH: process.env.PATH })).toEqual(shots);
      expect(await clipboardFiles("linux", { PATH: process.env.PATH, WAYLAND_DISPLAY: "wayland-0" })).toEqual(shots);
      expect(await clipboardFiles("darwin", { PATH: process.env.PATH })).toEqual(shots);
    });

    it("finds none when the clipboard offers no uri-list", async () => {
      fs.writeFileSync(path.join(bin, "xclip"), "#!/bin/sh\nprintf 'TARGETS\\nimage/png\\n'\n", { mode: 0o755 });
      expect(await clipboardFiles("linux", { PATH: process.env.PATH })).toEqual([]);
    });

    it.skipIf(process.platform !== "linux")("prefers copied files over a picture (Finder adds the file's icon)", async () => {
      // xclip has both: the picture is read and saved too, then dropped.
      expect(await clipboardImage(attachmentsDir(path.join(dir, "probe")))).toMatchObject({ kind: "image" });
      const got = await readClipboard(attachmentsDir(path.join(dir, "state")));
      expect(got).toEqual({ files: shots, image: null });
      expect(fs.readdirSync(attachmentsDir(path.join(dir, "state")))).toEqual([]);
    });
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
