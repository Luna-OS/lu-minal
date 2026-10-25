// Real transcripts of Claude Code 2.1.310, recorded with
//   claude -p --input-format stream-json --output-format stream-json --verbose
//          --include-partial-messages --model haiku --permission-mode default
//          --mcp-config <lu-minal's> --permission-prompt-tool mcp__luminal__approve
// and trimmed and anonymised (ids, paths, plugins, timings):
//   stream-reply-ok.jsonl      "reply with OK"
//   stream-permissions.jsonl   two Bash calls (one allowed, one denied through the approve tool),
//                              then a turn interrupted by a control request while its approval waited
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export type RealTranscript = "stream-reply-ok.jsonl" | "stream-permissions.jsonl";

/** The file's path (for the fake CLI's "replay"). */
export function realTranscriptPath(name: RealTranscript): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** The file's text. */
export function realTranscript(name: RealTranscript): string {
  return fs.readFileSync(realTranscriptPath(name), "utf8");
}

/** The tools Claude Code 2.1.310 lists in its init line (this account's set, plus lu-minal's). */
export function realInitTools(): string[] {
  for (const line of realTranscript("stream-reply-ok.jsonl").split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as { type?: string; subtype?: string; tools?: string[] };
    if (msg.type === "system" && msg.subtype === "init") return msg.tools ?? [];
  }
  return [];
}
