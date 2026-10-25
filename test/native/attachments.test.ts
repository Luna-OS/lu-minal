import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeContent } from "../../src/agents/claude-code/driver.js";
import { saveConversation, userMessageFor } from "../../src/agents/native/context.js";
import { attachmentFromPath, type Attachment } from "../../src/core/attachments.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-att-msg-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
fs.writeFileSync(path.join(dir, "shot.png"), PNG);
fs.writeFileSync(path.join(dir, "notes.txt"), "remember the moon");
const shot = attachmentFromPath(path.join(dir, "shot.png")) as Attachment;
const notes = attachmentFromPath(path.join(dir, "notes.txt")) as Attachment;

describe("pictures and files for native agents", () => {
  it("adds images for models that can see and lists files for all", () => {
    const seeing = userMessageFor({ from: "you", text: "look", attachments: [shot, notes] }, true);
    expect(seeing.images).toEqual([{ mediaType: "image/png", data: PNG.toString("base64") }]);
    expect(seeing.content).toContain("look");
    expect(seeing.content).toContain("remember the moon");
    const blind = userMessageFor({ from: "you", text: "look", attachments: [shot] }, false);
    expect(blind.images).toBeUndefined();
    expect(blind.content).toContain("can't see pictures");
    expect(userMessageFor({ from: "vega", text: "hi" }, true)).toEqual({ role: "user", content: "[message from vega] hi" });
  });

  it("keeps pictures out of the saved session", () => {
    const saved = saveConversation([userMessageFor({ from: "you", text: "look", attachments: [shot] }, true)]);
    expect(JSON.stringify(saved)).not.toContain(PNG.toString("base64"));
    expect(JSON.stringify(saved)).toContain("not kept after the restart");
  });
});

describe("pictures for Claude Code agents", () => {
  it("sends image blocks with the text, and plain text without attachments", () => {
    expect(claudeContent("hi", [])).toBe("hi");
    const blocks = claudeContent("what is this?", [shot]) as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  });
});
