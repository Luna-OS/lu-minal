#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose
// --include-partial-messages`: reads user messages from stdin and prints lines in the shapes the
// real CLI prints. What it does depends on the message text:
//   "hello" (anything else)  thinking + streamed text, a rate_limit_event, a result
//   "edit <file>"            an Edit tool call that really edits <file> ("old" -> "new")
//   "write <file>"           a Write tool call with a structured tool_use_result
//   "bash"                   a Bash call that fails with exit code 1
//   "luminal"                a call of lu-minal's own MCP tool send_message
//   "deny"                   a result that reports a permission denial
//   "fail"                   an error result (not signed in)
//   "slow" / "hang"          starts streaming and waits; "slow" stops on an interrupt, "hang" never
//   "crash"                  writes to stderr and exits with code 3
//   "ask"                    asks the host for a permission (control_request can_use_tool)
//   "pause"                  answers after 300 ms
//   "mode"                   answers with the current permission mode ("mode=acceptEdits")
//   "compact"                compacts the conversation first (status lines), then answers
//   "[message from x] ..."   echoes the message ("got [message from x] ...")
//   "mcp-approve <command>"  asks lu-minal's MCP "approve" tool (from --mcp-config) about Bash
//   "mcp-echo <text>"        calls lu-minal's MCP tool "echo" and reports it as a tool call
// Every start is logged to $FAKE_CLAUDE_LOG (one JSON line: argv, cwd, a few env vars).
import fs from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      env: {
        MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? null,
        CLAUDECODE: process.env.CLAUDECODE ?? null,
        CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
      },
      pid: process.pid,
    })}\n`,
  );
}

const resume = flag("--resume");
if (resume && process.env.FAKE_CLAUDE_MISSING_SESSION === resume) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const sessionId = resume ?? `sess-${process.pid}`;
const model = flag("--model") ?? "claude-opus-5-5";
let mode = flag("--permission-mode") ?? "default";
let initialized = false;
let totalCost = 0;
let turn = 0;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}${process.env.FAKE_CLAUDE_CRLF ? "\r\n" : "\n"}`);
const base = () => ({ session_id: sessionId, uuid: `u-${Math.random().toString(36).slice(2)}` });

/** Waiters for control responses from the host, by request id. */
const answers = new Map();
/** The running "slow" turn's interrupt hook. */
let onInterrupt = null;

function init() {
  if (initialized) return;
  initialized = true;
  out({ type: "autocompact_state", value: { enabled: true, effective_window: 180000 }, ...base() });
  out({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: ["Bash", "Edit", "Read", "Write", "mcp__luminal__send_message", "mcp__luminal__approve"],
    mcp_servers: [{ name: "luminal", status: process.env.FAKE_CLAUDE_MCP_STATUS ?? "connected" }],
    model,
    permissionMode: mode,
    apiKeySource: "none",
    claude_code_version: "2.1.310",
    uuid: "init-uuid",
  });
}

function start(id, inputTokens = 10) {
  out({ type: "system", subtype: "status", status: "requesting", ...base() });
  out({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 4141, output_tokens: 1 },
      },
    },
    parent_tool_use_id: null,
    ...base(),
  });
}

function stop(outputTokens) {
  out({
    type: "stream_event",
    event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } },
    parent_tool_use_id: null,
    ...base(),
  });
  out({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, ...base() });
}

function text(id, t) {
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null, ...base() });
  for (const piece of t.match(/.{1,6}/gs) ?? []) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }, parent_tool_use_id: null, ...base() });
  }
  out({ type: "assistant", message: { id, type: "message", role: "assistant", model, content: [{ type: "text", text: t }] }, parent_tool_use_id: null, ...base() });
}

function toolUse(id, toolId, name, input) {
  out({ type: "assistant", message: { id, type: "message", role: "assistant", model, content: [{ type: "tool_use", id: toolId, name, input }] }, parent_tool_use_id: null, ...base() });
}

function toolResult(toolId, content, isError = false, extra = {}) {
  out({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content, is_error: isError }] },
    parent_tool_use_id: null,
    ...extra,
    ...base(),
  });
}

function rateLimit() {
  out({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: 1791504000,
      rateLimitType: "seven_day",
      utilization: 0.66,
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.48, resetsAt: 1791081600 },
        seven_day: { utilization: 0.66, resetsAt: 1791504000 },
      },
    },
    ...base(),
  });
}

function result(extra = {}) {
  totalCost += 0.01;
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 1100,
    num_turns: 1,
    result: "",
    session_id: sessionId,
    total_cost_usd: Number(totalCost.toFixed(4)),
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 4141, output_tokens: 12 },
    permission_denials: [],
    ...extra,
    uuid: `r-${turn}`,
  });
}

/** One JSON-RPC call to the MCP server named in --mcp-config. */
let mcpSession = null;
async function mcp(method, params) {
  const config = JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8")).mcpServers.luminal;
  const headers = { ...config.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (mcpSession) headers["Mcp-Session-Id"] = mcpSession;
  if (!mcpSession && method !== "initialize") await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
  const res = await fetch(config.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params }) });
  if (method === "initialize") mcpSession = res.headers.get("mcp-session-id");
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function askHost(request) {
  const id = `req-${Math.random().toString(36).slice(2)}`;
  out({ type: "control_request", request_id: id, request });
  return new Promise((resolve) => answers.set(id, resolve));
}

async function handleUser(content) {
  turn++;
  init();
  const id = `msg_${turn}`;
  // The argument is the rest of the line, so paths with spaces (Windows profiles) work.
  const line = String(content).trim();
  const word = line.split(/\s+/)[0] ?? "";
  const arg = line.slice(word.length).trim();
  switch (word) {
    case "edit": {
      start(id);
      toolUse(id, `toolu_edit_${turn}`, "Edit", { file_path: arg, old_string: "old line", new_string: "new line\nanother line" });
      const before = fs.readFileSync(arg, "utf8");
      fs.writeFileSync(arg, before.replace("old line", "new line\nanother line"));
      toolResult(`toolu_edit_${turn}`, `The file ${arg} has been updated successfully.`);
      stop(20);
      start(`${id}b`);
      text(`${id}b`, "Done.");
      stop(3);
      result({ result: "Done." });
      return;
    }
    case "write": {
      start(id);
      toolUse(id, `toolu_write_${turn}`, "Write", { file_path: arg, content: "a\nB\nc\n" });
      fs.writeFileSync(arg, "a\nB\nc\n");
      toolResult(`toolu_write_${turn}`, `The file ${arg} has been updated successfully.`, false, {
        tool_use_result: {
          type: "update",
          filePath: arg,
          content: "a\nB\nc\n",
          structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] }],
          originalFile: "a\nb\nc\n",
        },
      });
      stop(9);
      result({ result: "" });
      return;
    }
    case "bash": {
      start(id);
      toolUse(id, `toolu_bash_${turn}`, "Bash", { command: "npm test", description: "Run the tests" });
      toolResult(`toolu_bash_${turn}`, "Exit code 1\nnpm ERR! Missing script: \"test\"", true, {
        tool_use_result: "Error: Exit code 1\nnpm ERR! Missing script: \"test\"",
      });
      stop(5);
      result({ result: "" });
      return;
    }
    case "luminal": {
      start(id);
      toolUse(id, `toolu_msg_${turn}`, "mcp__luminal__send_message", { to: "vega", text: "please review" });
      toolResult(`toolu_msg_${turn}`, [{ type: "text", text: "Delivered to vega." }]);
      stop(4);
      result({ result: "" });
      return;
    }
    case "deny": {
      start(id);
      text(id, "I could not run that.");
      stop(5);
      result({
        result: "I could not run that.",
        permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_other", tool_input: { command: "rm -rf build" } }],
      });
      return;
    }
    case "fail": {
      start(id);
      text(id, "Invalid API key · Please run /login");
      stop(1);
      result({ is_error: true, result: "Invalid API key · Please run /login" });
      return;
    }
    case "slow":
    case "hang": {
      start(id);
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } }, parent_tool_use_id: null, ...base() });
      await new Promise((resolve) => {
        onInterrupt = word === "slow" ? resolve : () => undefined;
      });
      onInterrupt = null;
      result({ subtype: "error_during_execution", is_error: true, result: "" });
      return;
    }
    case "crash": {
      process.stderr.write("fatal: something broke\nat main (cli.js:1:1)\n");
      process.exit(3);
      return;
    }
    case "pause": {
      start(id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      text(id, "Paused.");
      stop(2);
      result({ result: "Paused." });
      return;
    }
    case "compact": {
      out({ type: "system", subtype: "status", status: "compacting", ...base() });
      out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 170000 }, ...base() });
      out({ type: "system", subtype: "status", status: null, ...base() });
      start(id, 900);
      text(id, "Compacted.");
      stop(2);
      result({ result: "Compacted." });
      return;
    }
    case "mode": {
      start(id);
      text(id, `mode=${mode}`);
      stop(2);
      result({ result: `mode=${mode}` });
      return;
    }
    case "mcp-approve": {
      start(id);
      const res = await mcp("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: arg }, tool_use_id: "toolu_p" } });
      const decision = JSON.parse(res.content[0].text);
      text(id, `approve=${decision.behavior}${decision.message ? `: ${decision.message}` : ""}`);
      stop(2);
      result({ result: "" });
      return;
    }
    case "mcp-echo": {
      start(id);
      const tools = await mcp("tools/list", {});
      const toolId = `toolu_echo_${turn}`;
      toolUse(id, toolId, "mcp__luminal__echo", { text: arg });
      const res = await mcp("tools/call", { name: "echo", arguments: { text: arg } });
      toolResult(toolId, res.content, res.isError);
      text(`${id}b`, `tools=${tools.tools.map((t) => t.name).join(",")}`);
      stop(2);
      result({ result: "" });
      return;
    }
    case "ask": {
      start(id);
      const answer = await askHost({ subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm publish" }, tool_use_id: "toolu_ask" });
      const behavior = answer?.response?.behavior ?? "none";
      text(id, `behavior=${behavior}`);
      stop(2);
      result({ result: `behavior=${behavior}` });
      return;
    }
    default: {
      start(id);
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } }, parent_tool_use_id: null, ...base() });
      // A subagent's line, which must not reach the main conversation.
      out({ type: "assistant", message: { id: "sub", content: [{ type: "text", text: "inner" }] }, parent_tool_use_id: "toolu_task", ...base() });
      const answer = String(content).startsWith("[message from") ? `got ${content}` : "Hello there!";
      text(id, answer);
      stop(12);
      rateLimit();
      result({ result: answer });
    }
  }
}

let queue = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`bad input line: ${line}\n`);
    return;
  }
  if (msg.type === "control_request") {
    const subtype = msg.request?.subtype;
    if (subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      onInterrupt?.();
    } else if (subtype === "set_permission_mode") {
      if (process.env.FAKE_CLAUDE_REFUSE_MODE) {
        out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "Cannot switch modes" } });
      } else {
        mode = msg.request.mode;
        out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      }
    }
    return;
  }
  if (msg.type === "control_response") {
    const r = msg.response ?? {};
    answers.get(r.request_id)?.(r);
    answers.delete(r.request_id);
    return;
  }
  if (msg.type === "user") {
    queue = queue.then(() => handleUser(msg.message?.content ?? ""));
  }
});
rl.on("close", () => {
  queue.then(() => process.exit(0));
});
