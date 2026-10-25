import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeContent } from "../../src/agents/claude-code/driver.js";
import { MAX_IMAGE_CHARS, MAX_IMAGES, saveConversation, trimImages, userMessageFor } from "../../src/agents/native/context.js";
import { attachmentFromPath, type Attachment } from "../../src/core/attachments.js";
import type { ChatMessage, ImagePart } from "../../src/providers/types.js";
import { buildAnthropicBody } from "../../src/providers/wire/anthropic.js";
import { toOpenAIChatMessages } from "../../src/providers/wire/openai-chat.js";
import { toResponsesInput } from "../../src/providers/wire/openai-responses.js";

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

describe("trimImages", () => {
  const img = (chars: number): ImagePart => ({ mediaType: "image/png", data: "x".repeat(chars) });
  const count = (messages: ChatMessage[]) => messages.reduce((n, m) => n + (m.role === "user" ? (m.images?.length ?? 0) : 0), 0);

  it("keeps the newest pictures within the budget and notes the others where they were", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first", images: [img(5)] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second", images: [img(10), img(10)] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third", images: [img(15)] },
    ];
    // 15 + 10 fit in 30; the next picture doesn't, and nothing older goes along after that.
    expect(trimImages(messages, 30, 20)).toBe(2);
    expect(messages[4]).toEqual({ role: "user", content: "third", images: [img(15)] });
    expect(messages[2]).toEqual({ role: "user", content: "second\n[the last 1 of these 2 pictures left out to keep the request small]", images: [img(10)] });
    expect(messages[0]).toEqual({ role: "user", content: "first\n[1 picture(s) left out to keep the request small]" });
    // Settled: the next request is the same (and so is the provider's prompt cache).
    expect(trimImages(messages, 30, 20)).toBe(0);
    expect(count(messages)).toBe(2);
  });

  it("keeps at most `maxImages` pictures, and the defaults are the providers' limits", () => {
    const messages: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({ role: "user", content: `shot ${i}`, images: [img(1)] }));
    expect(trimImages(messages)).toBe(25 - MAX_IMAGES);
    expect(count(messages)).toBe(MAX_IMAGES);
    expect(messages[4]).not.toHaveProperty("images");
    expect(messages[5]).toHaveProperty("images");
    expect(MAX_IMAGES).toBeLessThanOrEqual(20);
    // Two pictures at the 5 MB per-picture limit fit, with room left under Gemini's 20 MB.
    expect(MAX_IMAGE_CHARS).toBeGreaterThanOrEqual(2 * Math.ceil((5 * 1024 * 1024) / 3) * 4);
    expect(MAX_IMAGE_CHARS).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("leaves a conversation every wire can still send", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "look", images: [img(8)] },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "a" },
      { role: "user", content: "and this", images: [img(8)] },
    ];
    trimImages(messages, 10, 20);
    const anthropic = buildAnthropicBody({ model: "m", system: "", messages, tools: [] }, { baseURL: "https://x", apiKey: "k" }).messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    expect(anthropic.map((m) => [m.role, m.content.map((b) => b.type).join(",")])).toEqual([
      ["user", "text"],
      ["assistant", "tool_use"],
      ["user", "tool_result,image,text"],
    ]);
    expect(toOpenAIChatMessages("", messages)[0]).toEqual({ role: "user", content: "look\n[1 picture(s) left out to keep the request small]" });
    expect(toResponsesInput(messages)[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "look\n[1 picture(s) left out to keep the request small]" }] });
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
