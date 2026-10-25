#!/usr/bin/env node
// A stand-in for an ACP agent (`opencode acp`, `gemini --experimental-acp`): speaks the Agent
// Client Protocol (newline-delimited JSON-RPC 2.0) on stdin/stdout, with the shapes OpenCode 1.19
// really sends (recorded from `opencode acp`). What a prompt does depends on its last text block:
//   "hello" (anything else)  a thought, streamed text, usage_update, end_turn with usage
//   "edit <file>"            an edit tool call that asks permission (with a diff), then edits <file>
//   "bash <command>"         an execute tool call that asks permission, then "runs" it
//   "read <file>"            a read tool call that returns the file's text
//   "luminal [title]"        a call of lu-minal's own MCP tool (title: luminal_send_message)
//   "plan"                   plan updates (3 entries, then progress)
//   "slow"                   streams, then waits for session/cancel and answers "cancelled"
//   "hang"                   streams and ignores session/cancel (never answers)
//   "ask-wait"               asks a permission and waits; reports the outcome it got
//   "provider-error"         logs a provider error to stderr (as OpenCode does) and waits for a cancel
//   "fail"                   logs that error, then answers with an error (as OpenCode does)
//   "auth-error"             an auth_required error answer
//   "crash"                  writes to stderr and exits with code 3
//   "max" / "refusal"        stopReason max_tokens / refusal
//   "fs"                     calls fs/read_text_file on the client and reports the error code
//   "mode" / "model"         answers with the session's current mode / model
//   "context"                answers with how many blocks the prompt had and how the first began
//   "attach"                 answers with the prompt's blocks (images, resources, links)
//   "stray"                  prints a non-JSON line to stdout first
//   "split"                  sends its answer in tiny pieces (partial lines)
// Environment switches: FAKE_ACP_LOG (every message received, JSONL), FAKE_ACP_STATE (sessions
// for session/load across processes), FAKE_ACP_NO_HTTP, FAKE_ACP_LOAD (loadSession instead of
// resume), FAKE_ACP_NO_RESUME, FAKE_ACP_AUTH (session/new needs authenticate first),
// FAKE_ACP_LEGACY_MODELS (unstable `models` + session/set_model), FAKE_ACP_MODES (session modes
// instead of a mode config option), FAKE_ACP_CRLF, FAKE_ACP_NO_MODEL_OPTION.
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const log = (obj) => {
  if (env.FAKE_ACP_LOG) fs.appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), ...obj })}\n`);
};
log({ start: true, cwd: process.cwd(), env: { OPENCODE_PERMISSION: env.OPENCODE_PERMISSION ?? null, FAKE_EXTRA: env.FAKE_EXTRA ?? null } });
const eol = env.FAKE_ACP_CRLF ? "\r\n" : "\n";
const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}${eol}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = ["opencode/big-pickle", "opencode/beam-free", "anthropic/claude-sonnet-5-5"];
// What `opencode acp --print-logs` writes to stderr while it retries a failing provider.
const OPENCODE_ERROR_LINE =
  'timestamp=2026-10-25T14:25:01.122Z level=ERROR run=a01868a2 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_1 small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai)"';
let nextId = 1;
const waiting = new Map();
const sessions = new Map();
let authed = !env.FAKE_ACP_AUTH;
const cancelled = new Set();
const cancelWaiters = new Map();

function loadState() {
  if (!env.FAKE_ACP_STATE) return {};
  try {
    return JSON.parse(fs.readFileSync(env.FAKE_ACP_STATE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(id, data) {
  if (!env.FAKE_ACP_STATE) return;
  const all = loadState();
  all[id] = data;
  fs.writeFileSync(env.FAKE_ACP_STATE, JSON.stringify(all));
}

function request(method, params) {
  const id = `agent-${nextId++}`;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
const update = (sessionId, u) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text, messageId = "msg_1") => update(sessionId, { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });

function configOptions(s) {
  const out = [];
  if (!env.FAKE_ACP_NO_MODEL_OPTION && !env.FAKE_ACP_LEGACY_MODELS) {
    out.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: s.model,
      options: MODELS.map((m) => ({ value: m, name: m })),
    });
  }
  if (!env.FAKE_ACP_MODES) {
    out.push({
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: s.mode,
      options: [
        { value: "build", name: "build", description: "The default agent. Executes tools based on configured permissions." },
        { value: "plan", name: "plan", description: "Plan mode. Disallows all edit tools." },
      ],
    });
  }
  return out;
}

function sessionState(s) {
  const out = { configOptions: configOptions(s) };
  if (env.FAKE_ACP_MODES) {
    out.modes = {
      currentModeId: s.mode,
      availableModes: [
        { id: "build", name: "Build" },
        { id: "plan", name: "Plan" },
      ],
    };
  }
  if (env.FAKE_ACP_LEGACY_MODELS) {
    out.models = { currentModelId: s.model, availableModels: MODELS.map((m) => ({ modelId: m, name: m })) };
  }
  return out;
}

function waitForCancel(sessionId) {
  if (cancelled.has(sessionId)) return Promise.resolve();
  return new Promise((resolve) => cancelWaiters.set(sessionId, resolve));
}

async function toolWithPermission(s, call, permissionCall, run) {
  update(s.id, { sessionUpdate: "tool_call", ...call, status: "pending" });
  const answer = await request("session/request_permission", {
    sessionId: s.id,
    toolCall: { toolCallId: call.toolCallId, status: "pending", ...permissionCall },
    options: [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  });
  const outcome = answer.result?.outcome;
  if (outcome?.outcome === "selected" && (outcome.optionId === "once" || outcome.optionId === "always")) {
    update(s.id, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: "in_progress", kind: call.kind, title: call.title });
    const done = run();
    update(s.id, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: "completed", ...done });
    return outcome.optionId;
  }
  update(s.id, {
    sessionUpdate: "tool_call_update",
    toolCallId: call.toolCallId,
    status: "failed",
    kind: call.kind,
    content: [{ type: "content", content: { type: "text", text: "The user rejected permission to use this specific tool call." } }],
    rawOutput: { error: "The user rejected permission to use this specific tool call." },
  });
  return outcome?.outcome === "cancelled" ? "cancelled" : "reject";
}

async function prompt(id, params) {
  const s = sessions.get(params.sessionId);
  if (!s) return write({ jsonrpc: "2.0", id, error: { code: -32002, message: `Session not found: ${params.sessionId}` } });
  cancelled.delete(s.id);
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
  // The command is the last text block that isn't lu-minal's context or an inlined file.
  const text = ([...texts].reverse().find((t) => !t.startsWith("<")) ?? "").trim();
  s.history.push(...texts);
  saveState(s.id, { history: s.history, model: s.model, mode: s.mode });
  const end = (stopReason = "end_turn", extra = {}) => write({ jsonrpc: "2.0", id, result: { stopReason, ...extra, _meta: {} } });
  const [word, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  const cwd = s.cwd;

  if (text === "stray") process.stdout.write(`some log line that is not JSON${eol}`);
  switch (word) {
    case "edit": {
      const file = path.resolve(cwd, arg);
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const after = before === null ? "new\n" : before.replace("old", "new");
      const diff = { type: "diff", path: file, oldText: before, newText: after };
      const got = await toolWithPermission(
        s,
        { toolCallId: "call_edit", title: "edit", kind: "edit", locations: [{ path: file }], rawInput: { filePath: file, oldString: "old", newString: "new" } },
        { title: arg, kind: "edit", locations: [{ path: file }], rawInput: { filepath: file }, content: [diff] },
        () => {
          fs.writeFileSync(file, after);
          return { title: arg, content: [diff], rawOutput: { output: "Edit applied successfully." } };
        },
      );
      say(s.id, got === "once" || got === "always" ? `Edited (${got}).` : `Not edited (${got}).`);
      return end();
    }
    case "bash": {
      const got = await toolWithPermission(
        s,
        { toolCallId: "call_bash", title: arg, kind: "execute", locations: [{ path: cwd }], rawInput: { command: arg, description: "Runs a command", cwd } },
        { title: arg, kind: "execute", rawInput: { command: arg } },
        () => ({ content: [{ type: "content", content: { type: "text", text: "ok 3 tests\n" } }], rawOutput: { output: "ok 3 tests\n", metadata: { exit: 0 } } }),
      );
      say(s.id, `ran: ${got}`);
      return end();
    }
    case "read": {
      const file = path.resolve(cwd, arg);
      update(s.id, { sessionUpdate: "tool_call", toolCallId: "call_read", title: "read", kind: "read", status: "pending", locations: [{ path: file }], rawInput: { filePath: file } });
      const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      update(s.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_read",
        status: "completed",
        title: arg,
        content: [{ type: "content", content: { type: "text", text: body } }],
        rawOutput: { output: body },
      });
      say(s.id, "Read it.");
      return end();
    }
    case "luminal": {
      // "luminal" alone: OpenCode's name; "luminal <title>": another agent's way of naming it.
      const title = arg || "luminal_send_message";
      const input = { to: "lead", text: "done" };
      update(s.id, { sessionUpdate: "tool_call", toolCallId: "call_msg", title, kind: "other", status: "pending", locations: [], rawInput: input });
      const answer = await request("session/request_permission", {
        sessionId: s.id,
        toolCall: { toolCallId: "call_msg", title, kind: "other", status: "pending", rawInput: input },
        options: [
          { optionId: "once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject", kind: "reject_once", name: "Reject" },
        ],
      });
      update(s.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_msg",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "Message sent to luna." } }],
        rawOutput: { output: "Message sent to luna." },
      });
      say(s.id, `sent (${answer.result?.outcome?.optionId ?? "cancelled"})`);
      return end();
    }
    case "plan": {
      const entries = (done) => [
        { content: "Read the code", priority: "high", status: done > 0 ? "completed" : "in_progress" },
        { content: "Write the fix", priority: "high", status: done > 1 ? "completed" : done === 1 ? "in_progress" : "pending" },
        { content: "Run the tests", priority: "medium", status: "pending" },
      ];
      update(s.id, { sessionUpdate: "plan", entries: entries(0) });
      update(s.id, { sessionUpdate: "plan", entries: entries(1) });
      say(s.id, "Planned.");
      return end();
    }
    case "slow": {
      say(s.id, "Working");
      await waitForCancel(s.id);
      return end("cancelled");
    }
    case "hang": {
      say(s.id, "Working");
      return; // never answers
    }
    case "ask-wait": {
      update(s.id, { sessionUpdate: "tool_call", toolCallId: "call_wait", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
      const answerP = request("session/request_permission", {
        sessionId: s.id,
        toolCall: { toolCallId: "call_wait", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } },
        options: [
          { optionId: "once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject", kind: "reject_once", name: "Reject" },
        ],
      });
      const first = await Promise.race([answerP.then((a) => ({ a })), waitForCancel(s.id).then(() => ({ cancelled: true }))]);
      const answer = first.a ?? (await answerP);
      log({ permissionOutcome: answer.result?.outcome ?? null });
      if (cancelled.has(s.id)) return end("cancelled");
      say(s.id, `outcome ${answer.result?.outcome?.outcome}`);
      return end();
    }
    case "provider-error":
      process.stderr.write(`${OPENCODE_ERROR_LINE}\n${OPENCODE_ERROR_LINE.replace("small=false agent=build", "small=true agent=title")}\n`);
      await waitForCancel(s.id);
      return end("cancelled");
    case "fail":
      process.stderr.write(`${OPENCODE_ERROR_LINE}\n`);
      return write({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Internal error", data: { message: "Free usage limit reached. Free models work in OpenCode (https://opencode.ai)" } },
      });
    case "auth-error":
      return write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } });
    case "crash":
      process.stderr.write("panic: something broke\n");
      process.exit(3);
      return;
    case "max":
      say(s.id, "Too long");
      return end("max_tokens");
    case "refusal":
      return end("refusal");
    case "fs": {
      const answer = await request("fs/read_text_file", { sessionId: s.id, path: path.join(cwd, "x.txt") });
      say(s.id, `fs error ${answer.error?.code ?? "none"}`);
      return end();
    }
    case "mode":
      say(s.id, `mode=${s.mode}`);
      return end();
    case "model":
      say(s.id, `model=${s.model}`);
      return end();
    case "attach": {
      const describe = (b) =>
        b.type === "image" ? `image:${b.mimeType}:${Buffer.from(b.data, "base64").length}` : b.type === "resource" ? `resource:${b.resource.text.trim()}` : b.type === "resource_link" ? `link:${b.name}` : b.type;
      say(s.id, blocks.map(describe).join(" "));
      return end();
    }
    case "context": {
      const first = texts[0] ?? "";
      say(s.id, `blocks=${blocks.length} first=${first.split("\n")[0].slice(0, 18)}`);
      return end();
    }
    case "split": {
      const line = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: s.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pieces" } } } })}${eol}`;
      for (let i = 0; i < line.length; i += 7) {
        process.stdout.write(line.slice(i, i + 7));
        await sleep(1);
      }
      return end();
    }
    default: {
      if (text.startsWith("[message from")) {
        say(s.id, `got ${text}`);
        return end();
      }
      update(s.id, { sessionUpdate: "agent_thought_chunk", messageId: "msg_1", content: { type: "text", text: "Let me think." } });
      say(s.id, "Hello");
      say(s.id, " there!");
      update(s.id, { sessionUpdate: "usage_update", used: 7819, size: 200000, cost: { amount: 0.01, currency: "USD" } });
      return end("end_turn", { usage: { inputTokens: 6027, outputTokens: 2, totalTokens: 7821, cachedReadTokens: 1792 } });
    }
  }
}

function newSession(params) {
  const id = `ses_${process.pid}_${sessions.size + 1}`;
  const s = { id, cwd: params.cwd, model: "opencode/big-pickle", mode: "build", history: [] };
  sessions.set(id, s);
  saveState(id, { history: [], model: s.model, mode: s.mode });
  return s;
}

async function handle(msg) {
  log({ in: msg });
  if (msg.id !== undefined && !msg.method) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve?.(msg);
    return;
  }
  const { id, method, params = {} } = msg;
  const ok = (result) => write({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: Boolean(env.FAKE_ACP_LOAD),
          mcpCapabilities: { http: !env.FAKE_ACP_NO_HTTP, sse: !env.FAKE_ACP_NO_HTTP },
          promptCapabilities: { embeddedContext: !env.FAKE_ACP_NO_EMBED, image: !env.FAKE_ACP_NO_IMAGE },
          sessionCapabilities: env.FAKE_ACP_LOAD || env.FAKE_ACP_NO_RESUME ? { list: {} } : { close: {}, list: {}, resume: {} },
        },
        authMethods: [
          { description: "Run `fake auth login` in the terminal", name: "Login with fake", id: "fake-login" },
          { name: "Use FAKE_API_KEY", id: "fake-api-key" },
        ],
        agentInfo: { name: "FakeAgent", version: "1.0.0" },
      });
    case "authenticate":
      authed = true;
      return ok({});
    case "session/new": {
      if (!authed) return fail(-32000, "Authentication required");
      const s = newSession(params);
      ok({ sessionId: s.id, ...sessionState(s) });
      update(s.id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "guided AGENTS.md setup" }] });
      return;
    }
    case "session/load":
    case "session/resume": {
      const saved = loadState()[params.sessionId];
      if (!saved) return fail(-32002, `Session not found: ${params.sessionId}`);
      const s = { id: params.sessionId, cwd: params.cwd, model: saved.model, mode: saved.mode, history: saved.history };
      sessions.set(s.id, s);
      if (method === "session/load") {
        for (const h of s.history) {
          update(s.id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: h } });
          update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
        }
      }
      return ok(sessionState(s));
    }
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      if (!s) return fail(-32002, "Session not found");
      if (params.configId === "model") {
        if (!MODELS.includes(params.value)) return fail(-32602, `Unknown model: ${params.value}`);
        s.model = params.value;
      } else if (params.configId === "mode") {
        s.mode = params.value;
      } else {
        return fail(-32602, `Unknown config option: ${params.configId}`);
      }
      saveState(s.id, { history: s.history, model: s.model, mode: s.mode });
      update(s.id, { sessionUpdate: "config_option_update", configOptions: configOptions(s) });
      return ok({ configOptions: configOptions(s) });
    }
    case "session/set_model": {
      const s = sessions.get(params.sessionId);
      if (!s || !env.FAKE_ACP_LEGACY_MODELS) return fail(-32601, "Method not found");
      s.model = params.modelId;
      return ok({});
    }
    case "session/set_mode": {
      const s = sessions.get(params.sessionId);
      if (!s) return fail(-32002, "Session not found");
      s.mode = params.modeId;
      update(s.id, { sessionUpdate: "current_mode_update", currentModeId: s.mode });
      return ok({});
    }
    case "session/prompt":
      return prompt(id, params);
    case "session/cancel": {
      cancelled.add(params.sessionId);
      const w = cancelWaiters.get(params.sessionId);
      cancelWaiters.delete(params.sessionId);
      w?.();
      return;
    }
    default:
      if (id !== undefined) return fail(-32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
