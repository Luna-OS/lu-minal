// What /copy takes from an agent's log: its words since the message it answered, no tool output.
import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/core/types.js";
import { lastReply } from "../../src/ui/copy.js";

let n = 0;
const at = <T extends object>(e: T) => ({ id: `l${n++}`, at: 0, ...e }) as unknown as LogEntry;
const user = (text: string, from = "you") => at({ kind: "user", from, text });
const text = (t: string) => at({ kind: "text", text: t });
const tool = (target: string) => at({ kind: "tool", toolCallId: target, name: "Bash", verb: "run", target, status: "ok", detail: "12 lines" });

describe("lastReply", () => {
  it("joins the texts of the last answer, without the tool calls and the thinking between them", () => {
    const log = [
      user("old question"),
      text("old answer"),
      user("fix the build"),
      text("Looking at the errors first.  "),
      tool("npm run build"),
      at({ kind: "reasoning", text: "hmm" }),
      tool("npm test"),
      text("Fixed.\nShould I also bump the version?"),
      at({ kind: "info", text: "turn done" }),
    ];
    expect(lastReply(log)).toBe("Looking at the errors first.\n\nFixed.\nShould I also bump the version?");
  });

  it("takes the answer before when the agent hasn't written in this turn yet", () => {
    expect(lastReply([user("a"), text("the answer"), tool("x"), user("next one"), tool("y")])).toBe("the answer");
  });

  it("answers to a teammate count too", () => {
    expect(lastReply([user("hi"), text("hello"), user("done with the lamp", "vega"), text("Thanks, vega.")])).toBe("Thanks, vega.");
  });

  it("is null before the agent has written anything", () => {
    expect(lastReply([])).toBeNull();
    expect(lastReply([user("hi"), tool("x"), text("   ")])).toBeNull();
  });
});
