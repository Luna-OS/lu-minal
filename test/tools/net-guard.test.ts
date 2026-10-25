// web_fetch and Claude Code's WebFetch against this machine, the local network and cloud metadata:
// they ask first, also when a public URL redirects there or its name resolves there.
import { describe, expect, it } from "vitest";
import { claudeToolRisk } from "../../src/mcp/approve.js";
import { isPrivateAddress, isPrivateHostname, isPrivateUrl, resolvesPrivate } from "../../src/tools/net-guard.js";
import type { ToolApproval } from "../../src/tools/types.js";
import { createWebFetchTool } from "../../src/tools/web.js";
import { makeCtx } from "./helpers.js";

describe("private addresses", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "[::1]",
    "fd00::1",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "224.0.0.1",
  ])("%s is not the open web", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111"])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it("knows local names and the URL parser's spellings of 127.0.0.1", () => {
    for (const host of ["localhost", "app.localhost", "printer.local", "metadata.google.internal", "router", "nas.lan"]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
    expect(isPrivateHostname("example.org")).toBe(false);
    for (const url of ["http://2130706433/", "http://0x7f.1/", "http://127.1:44766/poll", "http://[::1]:3000/", "http://169.254.169.254/latest/meta-data/"]) {
      expect(isPrivateUrl(url), url).toBe(true);
    }
    expect(isPrivateUrl("https://docs.example.org/x")).toBe(false);
  });

  it("checks what a name resolves to", async () => {
    expect(await resolvesPrivate("rebind.example", async () => ["127.0.0.1"])).toBe(true);
    expect(await resolvesPrivate("ok.example", async () => ["93.184.216.34"])).toBe(false);
    expect(await resolvesPrivate("gone.example", async () => {
      throw new Error("ENOTFOUND");
    })).toBe(false);
  });
});

function fetchFrom(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("nope", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("web_fetch", () => {
  it("is a network action for the web and asks for local addresses", () => {
    const tool = createWebFetchTool(async () => new Response("x"));
    const ctx = makeCtx();
    const riskOf = (url: string) => (typeof tool.risk === "function" ? tool.risk({ url }, ctx) : tool.risk);
    expect(riskOf("https://example.org/")).toBe("network");
    expect(riskOf("http://127.0.0.1:44766/status")).toBe("other");
    expect(riskOf("http://169.254.169.254/latest/meta-data/iam/")).toBe("other");
    expect(tool.approval!({ url: "http://localhost:3000/admin" } as never, ctx)).toMatchObject({ risk: "other", allowKey: "web_fetch:http://localhost:3000" });
  });

  it("asks before following a redirect to this machine, and stops when the user says no", async () => {
    const { fetchImpl, calls } = fetchFrom({
      "https://public.example/": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
      "http://169.254.169.254/latest/meta-data/": () => new Response("aws-secret"),
    });
    const asked: ToolApproval[] = [];
    const tool = createWebFetchTool(fetchImpl);
    const denied = await tool.run({ url: "https://public.example/" }, makeCtx({ approve: async (r) => (asked.push(r), false) }));
    expect(denied.isError).toBe(true);
    expect(denied.content).not.toContain("aws-secret");
    expect(calls).toEqual(["https://public.example/"]);
    expect(asked[0]).toMatchObject({ risk: "other", allowKey: "web_fetch:http://169.254.169.254" });

    const allowed = await tool.run({ url: "https://public.example/" }, makeCtx({ approve: async () => true }));
    expect(allowed.content).toContain("aws-secret");
  });

  it("refuses redirects to other schemes and endless chains", async () => {
    const { fetchImpl } = fetchFrom({
      "https://a.example/": () => new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } }),
      "https://loop.example/": () => new Response(null, { status: 302, headers: { location: "https://loop.example/" } }),
    });
    const tool = createWebFetchTool(fetchImpl);
    expect((await tool.run({ url: "https://a.example/" }, makeCtx())).content).toContain("only http and https");
    expect((await tool.run({ url: "https://loop.example/" }, makeCtx())).content).toContain("redirected more than");
  });

  it("asks when a public name resolves to a local address", async () => {
    const { fetchImpl, calls } = fetchFrom({ "https://rebind.example/": () => new Response("inside") });
    const tool = createWebFetchTool(fetchImpl, { lookup: async () => ["10.0.0.7"] });
    const res = await tool.run({ url: "https://rebind.example/" }, makeCtx({ approve: async () => false }));
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("classifies Claude Code's WebFetch the same way", () => {
    expect(claudeToolRisk("WebFetch", { url: "https://docs.example.org" }, process.cwd())).toBe("network");
    expect(claudeToolRisk("WebFetch", { url: "http://127.0.0.1:8080/" }, process.cwd())).toBe("other");
  });
});
