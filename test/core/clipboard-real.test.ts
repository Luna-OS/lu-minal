// The real clipboard on Windows and macOS: files copied in Explorer / Finder and a picture, put
// there with the system's own API and read back the way a paste reads them. CI only, because it
// replaces whatever is on the clipboard; skipped where the runner has no clipboard to write to.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clipboardFiles, readClipboard } from "../../src/core/attachments.js";
import { runProgram } from "../../src/platform/process.js";
import { encodePng, renderIcon } from "../../scripts/windows-icon.js";

const real = Boolean(process.env.CI) && (process.platform === "win32" || process.platform === "darwin");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-clip-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const js = (s: string) => JSON.stringify(s);

/** Runs a script that writes the clipboard: its output, or null when this machine has no clipboard to write to. */
async function write(script: string): Promise<string | null> {
  const res =
    process.platform === "win32"
      ? await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeoutMs: 30_000 })
      : await runProgram("osascript", ["-l", "JavaScript", "-e", script], { timeoutMs: 30_000 });
  if (res.code !== 0) console.warn(`could not write the clipboard: ${res.stderr.trim()}`);
  return res.code === 0 ? res.stdout.trim() : null;
}

describe.skipIf(!real)("the real clipboard", () => {
  it("lists the files copied in Explorer / Finder, names with spaces and non-ASCII too", async (ctx) => {
    const files = ["night sky ☾.png", "b.png"].map((n) => path.join(dir, n));
    for (const f of files) fs.writeFileSync(f, encodePng(renderIcon(8), 8));
    // Both scripts answer how many files are on the clipboard now.
    const written = await write(
      process.platform === "win32"
        ? `Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; ${files.map((f) => `[void]$c.Add(${quote(f)});`).join(" ")} [System.Windows.Forms.Clipboard]::SetFileDropList($c); [System.Windows.Forms.Clipboard]::GetFileDropList().Count`
        : `ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; var urls = $.NSMutableArray.array; ${files.map((f) => `urls.addObject($.NSURL.fileURLWithPath(${js(f)}));`).join(" ")} pb.writeObjects(urls); pb.pasteboardItems.count;`,
    );
    if (written === null) return ctx.skip();
    expect(written).toBe(String(files.length));
    // Finder and Explorer may name the folder differently (/private/var vs /var, 8.3 names).
    const real = (p: string) => fs.realpathSync.native(p);
    expect((await clipboardFiles()).map(real)).toEqual(files.map(real));
    const got = await readClipboard(path.join(dir, "attachments"));
    expect(got.image).toBeNull();
    expect(got.files.map(real)).toEqual(files.map(real));
  });

  it("saves a picture on the clipboard as a PNG", async (ctx) => {
    const png = path.join(dir, "shot.png");
    fs.writeFileSync(png, encodePng(renderIcon(16), 16));
    const ok = await write(
      process.platform === "win32"
        ? `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = New-Object System.Drawing.Bitmap 16, 16; [System.Windows.Forms.Clipboard]::SetImage($b)`
        : `ObjC.import('AppKit'); var pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.setDataForType($.NSData.dataWithContentsOfFile(${js(png)}), 'public.png');`,
    );
    if (ok === null) return ctx.skip();
    expect(await clipboardFiles()).toEqual([]);
    const got = await readClipboard(path.join(dir, "attachments"));
    expect(got.files).toEqual([]);
    expect(got.image).toMatchObject({ kind: "image", name: "clipboard.png", mediaType: "image/png" });
    expect(fs.readFileSync(got.image!.path).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
