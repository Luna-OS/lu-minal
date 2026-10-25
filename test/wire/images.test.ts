import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "../../src/providers/wire/anthropic.js";
import { toOpenAIChatMessages } from "../../src/providers/wire/openai-chat.js";
import { toResponsesInput } from "../../src/providers/wire/openai-responses.js";
import type { ChatMessage } from "../../src/providers/types.js";

const withPicture: ChatMessage[] = [
  { role: "user", content: "What does the screenshot show?", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] },
];

describe("pictures in user messages", () => {
  it("become image_url parts for OpenAI-compatible chat", () => {
    const [, user] = toOpenAIChatMessages("sys", withPicture);
    expect(user).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What does the screenshot show?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    });
    // Without pictures the content stays a plain string.
    expect(toOpenAIChatMessages("", [{ role: "user", content: "hi" }])[0]).toEqual({ role: "user", content: "hi" });
  });

  it("become base64 image blocks before the text for Anthropic", () => {
    const [user] = toAnthropicMessages(withPicture);
    expect(user.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    expect(user.content[1]).toMatchObject({ type: "text", text: "What does the screenshot show?" });
  });

  it("become input_image parts for the Responses API", () => {
    const [user] = toResponsesInput(withPicture) as Array<{ content: unknown[] }>;
    expect(user.content).toEqual([
      { type: "input_text", text: "What does the screenshot show?" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });
});
