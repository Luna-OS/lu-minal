// Tools for Claude Code cloud sessions (claude.ai/code): agents can see the sessions this project
// started and send them follow-up messages - e.g. the lead hands a long-running task to the cloud.
import type { Tool } from "./types.js";

const notAvailable = "Claude Code is not installed or not signed in, so there are no cloud sessions.";

export function cloudTools(): Tool[] {
  const list: Tool<Record<string, never>> = {
    name: "cloud_sessions",
    description:
      "List the Claude Code cloud sessions (claude.ai/code) started from this project, with their ids, links and tasks. " +
      "New cloud sessions are started by the user (/cloud); you can message existing ones with cloud_send.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    mcp: true,
    describe: () => ({ verb: "cloud", target: "sessions" }),
    run: async (_args, ctx) => {
      const cloud = ctx.services.cloud;
      if (!cloud) return { content: notAvailable, isError: true };
      const sessions = cloud.list();
      if (!sessions.length) {
        return { content: "No cloud sessions yet. The user can start one with /cloud.", display: { detail: "none" } };
      }
      const lines = sessions.map((s) => `${s.id}  ${s.url}  started ${new Date(s.startedAt).toISOString()}  task: ${s.task}`);
      return { content: lines.join("\n"), display: { detail: `${sessions.length} session${sessions.length === 1 ? "" : "s"}` } };
    },
  };
  const send: Tool<{ session: string; text: string }> = {
    name: "cloud_send",
    description:
      "Send a follow-up message to a Claude Code cloud session (by its id from cloud_sessions). The cloud agent works on it on claude.ai/code; " +
      "results arrive there (and as a pushed branch / pull request), not in this conversation.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "The session id (session_… or cse_…)" },
        text: { type: "string", description: "The message" },
      },
      required: ["session", "text"],
      additionalProperties: false,
    },
    risk: "network",
    mcp: true,
    describe: (args) => ({ verb: "cloud", target: `→ ${args.session ?? "?"}` }),
    approval: (args) => ({ risk: "network", summary: `message cloud session ${args.session}`, detail: args.text, allowKey: "cloud_send" }),
    run: async (args, ctx) => {
      const cloud = ctx.services.cloud;
      if (!cloud) return { content: notAvailable, isError: true };
      if (!args.session || !args.text?.trim()) return { content: "Give a session id and a message.", isError: true };
      try {
        const url = await cloud.send(args.session, args.text);
        return { content: `Sent. The session is at ${url}`, display: { detail: "sent" } };
      } catch (err) {
        return { content: `Could not send: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
  return [list, send] as Tool[];
}
