// The OSC 7701 sequence lu-minal writes for the web pane of its window (macOS app, Windows window
// app), and the URL check in front of it: any program in the terminal could print the sequence, so
// only https pages on claude.ai and its subdomains may go out, and the hosts check the same.
import { describe, expect, it } from "vitest";
import {
  cloudUrl,
  cloudUrlFromInput,
  hasWebPane,
  isCloudUrl,
  WEB_PANE_HOME,
  WEB_PANE_MAX_BYTES,
  webPaneKey,
  webPaneSequence,
  writeWebPane,
} from "../../src/platform/web-pane.js";
import { titleSequence } from "../../src/ui/text.js";

const ESC = "\u001b";
const BEL = "\u0007";

function fakeOut() {
  const written: string[] = [];
  return { written, write: (data: string) => void written.push(data) };
}

describe("hasWebPane", () => {
  it("is on only where the window says so with LU_MINAL_WEB_PANE=1", () => {
    expect(hasWebPane({ LU_MINAL_WEB_PANE: "1" })).toBe(true);
    expect(hasWebPane({})).toBe(false);
    expect(hasWebPane({ LU_MINAL_WEB_PANE: "0" })).toBe(false);
    expect(hasWebPane({ LU_MINAL_WEB_PANE: "true" })).toBe(false);
    // The macOS app's own marker alone is not a pane (an older app has none).
    expect(hasWebPane({ LU_MINAL_APP: "1", TERM_PROGRAM: "lu-minal" })).toBe(false);
  });

  it("names the host's key: cmd+shift+k on macOS, ctrl+shift+k on Windows", () => {
    expect(webPaneKey("darwin")).toBe("cmd+shift+k");
    expect(webPaneKey("win32")).toBe("ctrl+shift+k");
  });
});

describe("webPaneSequence", () => {
  it("is ESC ] 7701 ; <command> [; <argument>] BEL", () => {
    expect(webPaneSequence("open", "https://claude.ai/code/session_01Abc")).toBe(`${ESC}]7701;open;https://claude.ai/code/session_01Abc${BEL}`);
    expect(webPaneSequence("show")).toBe(`${ESC}]7701;show${BEL}`);
    expect(webPaneSequence("hide")).toBe(`${ESC}]7701;hide${BEL}`);
    expect(webPaneSequence("toggle")).toBe(`${ESC}]7701;toggle${BEL}`);
    expect(webPaneSequence("toggle", "")).toBe(`${ESC}]7701;toggle${BEL}`);
  });

  it("sends the URL normalised, the way the pane loads it", () => {
    expect(webPaneSequence("open", "https://CLAUDE.ai")).toBe(`${ESC}]7701;open;https://claude.ai/${BEL}`);
    expect(webPaneSequence("open", "https://claude.ai:443/code")).toBe(`${ESC}]7701;open;https://claude.ai/code${BEL}`);
    // A non-ASCII path (an accented e) goes out percent-encoded.
    expect(webPaneSequence("open", "https://claude.ai/code/é")).toBe(`${ESC}]7701;open;https://claude.ai/code/%C3%A9${BEL}`);
  });

  it("sends only the characters RFC 3986 allows, which the macOS app's check takes", () => {
    // The WHATWG parser keeps these as typed; Foundation's URLComponents (the macOS app) refuses them.
    expect(cloudUrl("https://claude.ai/code?q={x}")).toBe("https://claude.ai/code?q=%7Bx%7D");
    expect(cloudUrl("https://claude.ai/a|b^c")).toBe("https://claude.ai/a%7Cb%5Ec");
    expect(cloudUrl("https://claude.ai/code?k=[1]")).toBe("https://claude.ai/code?k=%5B1%5D");
    expect(cloudUrl("https://claude.ai/#a#b`c")).toBe("https://claude.ai/#a%23b%60c");
    // A "%" that starts no escape becomes one; real escapes stay as they are.
    expect(cloudUrl("https://claude.ai/%zz?x=%&y=%41")).toBe("https://claude.ai/%25zz?x=%25&y=%41");
    // What claude.ai links hold anyway is left alone.
    expect(cloudUrl("https://claude.ai/a;b=c?d=e;f&g=(h)#i?j/k@l:m")).toBe("https://claude.ai/a;b=c?d=e;f&g=(h)#i?j/k@l:m");
    const strict = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*(?:#[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*)?$/;
    const printable = Array.from({ length: 0x7f - 0x21 }, (_, i) => String.fromCharCode(0x21 + i)).join("");
    for (const raw of [
      `https://claude.ai/${printable.replace(/\\/g, "")}`,
      `https://claude.ai/code?${printable.replace(/\\/g, "")}`,
      `https://claude.ai/code#${printable.replace(/\\/g, "")}`,
      // Non-ASCII in the path, the query and the fragment.
      "https://claude.ai/code/\u00e9?\u00fc=\u00df#\u00f8",
    ]) {
      const url = cloudUrl(raw);
      expect(url, raw).not.toBeNull();
      expect(url, raw).toMatch(strict);
      expect(url!.replace(/%[0-9A-F]{2}/gi, ""), raw).not.toContain("%");
    }
  });

  it("refuses open without a claude.ai URL, arguments for the other commands and unknown commands", () => {
    expect(webPaneSequence("open")).toBeNull();
    expect(webPaneSequence("open", "")).toBeNull();
    expect(webPaneSequence("open", "https://evil.com/")).toBeNull();
    expect(webPaneSequence("show", "https://claude.ai/code")).toBeNull();
    expect(webPaneSequence("hide", "x")).toBeNull();
    expect(webPaneSequence("eval" as never)).toBeNull();
    expect(webPaneSequence("open;https://claude.ai" as never)).toBeNull();
  });

  it("never carries a control character that could end the sequence early or start another", () => {
    for (const bad of [BEL, ESC, `${ESC}\\`, "\u009c", "\u009d", "\n", "\r", "\t", "\u0000", "\u007f"]) {
      expect(webPaneSequence("open", `https://claude.ai/code${bad}`)).toBeNull();
      expect(webPaneSequence("open", `https://claude.ai/code${bad}]7701;open;https://evil.com/`)).toBeNull();
    }
    const seq = webPaneSequence("open", "https://claude.ai/code?q=%07%1b")!;
    // Only the frame's own ESC and BEL.
    expect(seq.slice(2, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("stays within the 4096 bytes the hosts accept", () => {
    const base = "https://claude.ai/";
    const frame = `${ESC}]7701;open;${BEL}`.length;
    const fits = base + "a".repeat(WEB_PANE_MAX_BYTES - frame - base.length);
    expect(webPaneSequence("open", fits)).toHaveLength(WEB_PANE_MAX_BYTES);
    expect(webPaneSequence("open", `${fits}a`)).toBeNull();
  });
});

describe("isCloudUrl", () => {
  it("takes https pages on claude.ai and its subdomains", () => {
    for (const ok of [
      WEB_PANE_HOME,
      "https://claude.ai",
      "https://claude.ai/code/session_01Abc?from=cli",
      "https://code.claude.ai/x?y=1#z",
      "HTTPS://Claude.AI/code",
    ]) {
      expect(isCloudUrl(ok), ok).toBe(true);
    }
  });

  it("refuses other schemes, other hosts and look-alikes", () => {
    for (const bad of [
      "http://claude.ai/code",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "ftp://claude.ai/",
      "https:claude.ai/code",
      "//claude.ai/code",
      "claude.ai/code",
      "https://evil.com/",
      "https://claude.ai.evil.com/",
      "https://evil.com/claude.ai",
      "https://evil.com/?u=https://claude.ai/",
      "https://evilclaude.ai/",
      "https://claude.aii/",
      "https://claude.ai./",
      "https://.claude.ai/",
      "https://claudе.ai/", // a Cyrillic "e"
      "https://claude.ai%2eevil.com/",
      // Host names the macOS app refuses (and claude.ai has none of).
      "https://a_b.claude.ai/",
      "https://a..claude.ai/",
      "https://xn--e1aybc.claude.ai/",
      "https://\u0442\u0435\u0441\u0442.claude.ai/", // a Cyrillic subdomain (xn--e1aybc)
      "https://[::1]/",
      "https://127.0.0.1/",
      "",
    ]) {
      expect(isCloudUrl(bad), bad).toBe(false);
    }
  });

  it("refuses user names and passwords, other ports, backslashes, spaces and control characters", () => {
    for (const bad of [
      "https://claude.ai@evil.com",
      "https://claude.ai@evil.com/code",
      "https://claude.ai:443@evil.com/",
      "https://evil.com@claude.ai/",
      "https://user:pw@claude.ai/",
      "https://claude.ai:8443/",
      "https://claude.ai\\@evil.com",
      "https://evil.com\\.claude.ai/",
      " https://claude.ai/",
      "https://claude.ai/a b",
      "https://claude.ai/\u0007",
      "https://claude.ai/\u001b]7701;open;https://evil.com/\u0007",
      "https://claude.ai/\u009b",
    ]) {
      expect(isCloudUrl(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(cloudUrl(42 as never)).toBeNull();
  });
});

describe("writeWebPane", () => {
  it("writes the sequence straight to the terminal in a window with a pane", () => {
    const out = fakeOut();
    const env = { LU_MINAL_WEB_PANE: "1" };
    expect(writeWebPane("open", "https://claude.ai/code/session_01Abc", out, env)).toBe(true);
    expect(writeWebPane("toggle", undefined, out, env)).toBe(true);
    expect(out.written).toEqual([`${ESC}]7701;open;https://claude.ai/code/session_01Abc${BEL}`, `${ESC}]7701;toggle${BEL}`]);
  });

  it("writes nothing without a pane, or for a URL the pane would refuse", () => {
    const out = fakeOut();
    expect(writeWebPane("open", "https://claude.ai/code", out, {})).toBe(false);
    expect(writeWebPane("toggle", undefined, out, { LU_MINAL_APP: "1" })).toBe(false);
    expect(writeWebPane("open", "https://claude.ai@evil.com", out, { LU_MINAL_WEB_PANE: "1" })).toBe(false);
    expect(out.written).toEqual([]);
  });
});

describe("the window title", () => {
  it("can't carry a pane command in a project's name (a folder may be called anything)", () => {
    const name = `proj${BEL}${ESC}]7701;open;https://claude.ai/new${BEL}\u009d7701;toggle${BEL}`;
    const seq = titleSequence(`lu-minal \u00b7 ${name}`);
    expect(seq).toBe(`${ESC}]0;lu-minal \u00b7 proj]7701;open;https://claude.ai/new7701;toggle${BEL}`);
    // Only the frame's own ESC and BEL.
    expect(seq.slice(2, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("cloudUrlFromInput", () => {
  it("reads a link, a link without https:// and a session id", () => {
    expect(cloudUrlFromInput(" https://claude.ai/code/session_01Abc ")).toBe("https://claude.ai/code/session_01Abc");
    expect(cloudUrlFromInput("claude.ai/code/session_01Abc")).toBe("https://claude.ai/code/session_01Abc");
    expect(cloudUrlFromInput("code.claude.ai")).toBe("https://code.claude.ai/");
    expect(cloudUrlFromInput("session_01Abcdef")).toBe("https://claude.ai/code/session_01Abcdef");
    expect(cloudUrlFromInput("cse_01Abcdef")).toBe("https://claude.ai/code/cse_01Abcdef");
  });

  it("refuses everything else", () => {
    for (const bad of ["", "show", "http://claude.ai/", "evil.com/claude.ai", "claude.ai.evil.com/x", "claude.ai@evil.com", "https://claude.ai@evil.com", "session_x"]) {
      expect(cloudUrlFromInput(bad), bad).toBeNull();
    }
  });
});
