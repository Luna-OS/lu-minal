// /copy: the focused agent's last reply to the clipboard, its own words only (no tool output), so
// a long answer or question can be read or kept elsewhere in full.
import type { Agent } from "../core/agent.js";
import type { Hub } from "../core/hub.js";
import type { LogEntry } from "../core/types.js";
import { copyToClipboard } from "../platform/clipboard.js";

/**
 * The agent's last reply: what it wrote since the message it answered (the texts between its
 * tool calls, one paragraph apart), or null when it hasn't written anything yet.
 */
export function lastReply(log: readonly LogEntry[]): string | null {
  let end = log.length - 1;
  while (end >= 0 && log[end].kind !== "text") end--;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && log[start - 1].kind !== "user") start--;
  const parts = log
    .slice(start, end + 1)
    .flatMap((e) => (e.kind === "text" ? [e.text.trim()] : []))
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

const lineCount = (text: string) => text.split(/\r?\n/).length;

/** Copies the agent's last reply and says how it went in a toast. */
export async function copyLastReply(
  agent: Agent,
  hub: Hub,
  terminal: (data: string) => void,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const text = lastReply(agent.log);
  if (!text) return hub.toast(`${agent.name} hasn't replied yet - nothing to copy.`, "info");
  const n = lineCount(text);
  const lines = `${n} line${n === 1 ? "" : "s"}`;
  const res = await copyToClipboard(text, { terminal, ...opts }).catch(() => ({ via: null }));
  if (res.via === "osc52") {
    hub.toast(`Copied ${lines} through the terminal (OSC 52) - no clipboard program was found.`, "success");
  } else if (res.via) {
    hub.toast(`Copied ${lines}.`, "success");
  } else {
    hub.toast("Could not copy: no clipboard program works here.", "warning");
  }
}
