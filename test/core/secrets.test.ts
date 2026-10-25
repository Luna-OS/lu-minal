// Known secrets (stored keys, secret-looking environment variables, MCP and git tokens) never reach
// a model through a tool result, nor the panel through an error row.
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { Notifier } from "../../src/core/emitter.js";
import { clearSecrets, redactSecrets, registerEnvSecrets, registerSecret } from "../../src/core/secrets.js";
import { basicAuthHeader } from "../../src/git/shared.js";
import { runToolCall } from "../../src/tools/run.js";
import type { Tool } from "../../src/tools/types.js";
import { cloudTools } from "../../src/tools/cloud.js";
import { makeCtx } from "../tools/helpers.js";

afterEach(() => clearSecrets());

describe("secret redaction", () => {
  it("hides registered secrets and secret-looking environment variables, not short or path-like values", () => {
    registerSecret("sk-or-v1-0123456789abcdef");
    registerSecret("public");
    registerEnvSecrets({ MY_API_KEY: "abcdefghijklmnop", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock.1234", HOME_DIR_NAME: "nothing-secret-here" });
    expect(redactSecrets("key=sk-or-v1-0123456789abcdef and abcdefghijklmnop")).toBe("key=[redacted] and [redacted]");
    expect(redactSecrets("public /tmp/ssh-agent.sock.1234")).toBe("public /tmp/ssh-agent.sock.1234");
  });

  it("applies to tool results and error rows", async () => {
    registerSecret("ghp_0123456789abcdefghij");
    const leaky: Tool = {
      name: "leaky",
      description: "prints the environment",
      parameters: { type: "object", properties: {} },
      risk: "read",
      describe: () => ({ verb: "env" }),
      run: async () => ({ content: "GITHUB_TOKEN=ghp_0123456789abcdefghij", display: { detail: "ghp_0123456789abcdefghij" } }),
    };
    const agent = new Agent({ name: "vega", role: "worker", model: { provider: "x", model: "y" } }, new Notifier(), "auto-edit");
    const result = await runToolCall({ agent, tool: leaky, name: "leaky", toolCallId: "t1", args: {}, ctx: makeCtx() });
    expect(result.content).toBe("GITHUB_TOKEN=[redacted]");
    expect(JSON.stringify(agent.log)).not.toContain("ghp_0123456789abcdefghij");
    agent.error("401: bad key ghp_0123456789abcdefghij");
    expect(agent.lastError).toBe("401: bad key [redacted]");
  });

  it("covers git tokens and their basic-auth form", () => {
    const header = basicAuthHeader("x-access-token", "gho_secretsecretsecret");
    const encoded = header.split(" ").pop()!;
    expect(redactSecrets(`token gho_secretsecretsecret header ${encoded}`)).toBe("token [redacted] header [redacted]");
  });
});

describe("cloud_send", () => {
  it("asks like a command (the cloud agent acts with the user's account) and remembers per session", () => {
    const send = cloudTools().find((t) => t.name === "cloud_send")!;
    expect(send.risk).toBe("other");
    expect(send.approval!({ session: "session_1", text: "push it" } as never, makeCtx())).toMatchObject({ risk: "other", allowKey: "cloud_send:session_1" });
  });
});
