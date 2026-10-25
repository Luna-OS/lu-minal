import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../src/providers/types.js";
import { createWebFetchTool, decodeEntities, htmlToText } from "../../src/tools/web.js";
import { makeCtx } from "./helpers.js";

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Moon phases &amp; tides</title>
  <style>body { color: red; }</style>
  <script>window.track = function () { return "<p>not text</p>"; };</script>
</head>
<body>
  <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
  <!-- a comment that should vanish -->
  <main>
    <h1>Moon phases &amp; tides</h1>
    <p>The moon has <strong>eight</strong>&nbsp;phases.
       See the <a href="/docs/phases?x=1&amp;y=2">phase guide</a> or <a href="#top">jump</a>.</p>
    <h2>Phases</h2>
    <ul>
      <li>New moon</li>
      <li>Waxing &#8220;crescent&#8221;</li>
      <li>Full moon &#x1F315;</li>
    </ul>
    <pre><code>const phase = "full";
if (phase) {
  wax();
}</code></pre>
    <img src="moon.png" alt="The full moon">
    <table><tr><th>Day</th><td>1</td></tr></table>
    <noscript>Enable JavaScript</noscript>
    <svg><text>svg text</text></svg>
  </main>
  <footer>&copy; 2026 Luna &mdash; all rights reserved</footer>
</body>
</html>`;

describe("htmlToText", () => {
  const text = htmlToText(PAGE, "https://example.org/moon/index.html");

  it("keeps the title, headings and list items", () => {
    expect(text.startsWith("# Moon phases & tides")).toBe(true);
    expect(text).toContain("## Phases");
    expect(text).toContain("- New moon");
    expect(text).toContain("- Waxing “crescent”");
    expect(text).toContain("- Full moon 🌕");
  });

  it("drops scripts, styles, navigation, comments, svg and noscript", () => {
    for (const gone of ["window.track", "color: red", "Home", "About", "a comment", "svg text", "Enable JavaScript", "not text"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("keeps links as text with absolute URLs, decoding entities", () => {
    expect(text).toContain("phase guide (https://example.org/docs/phases?x=1&y=2)");
    expect(text).toContain("or jump.");
    expect(text).toContain("The moon has eight phases.");
  });

  it("keeps preformatted blocks and image alt text", () => {
    expect(text).toContain('const phase = "full";\nif (phase) {\n  wax();\n}');
    expect(text).toContain("[image: The full moon]");
    expect(text).toContain("© 2026 Luna — all rights reserved");
  });

  it("collapses whitespace outside preformatted blocks", () => {
    expect(text).not.toMatch(/\n{3,}/);
    const prose = text.replace(/const phase[\s\S]*?\n\}/, "");
    expect(prose).not.toMatch(/[ \t]{2,}/);
    expect(prose.split("\n").every((l) => l === l.trim())).toBe(true);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones", () => {
    expect(decodeEntities("&lt;a&gt; &amp;amp; &#39;x&#39; &#x41;&#66; &hellip; &notathing; &amp")).toBe("<a> &amp; 'x' AB … &notathing; &");
  });
});

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  };
  return { fetchImpl, calls };
}

describe("web_fetch", () => {
  const ctx = makeCtx();

  it("fetches HTML as readable text", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const tool = createWebFetchTool(fetchImpl);
    const res = await tool.run({ url: "https://example.org/moon/" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls[0].url).toBe("https://example.org/moon/");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(res.content).toContain("# Moon phases & tides");
    expect(res.content).not.toContain("<p>");
    expect(res.display?.detail).toMatch(/^\d+ chars$/);
    expect(tool.describe({ url: "https://example.org/moon/" }, ctx)).toEqual({ verb: "fetch", target: "example.org/moon/" });
    expect(tool.risk).toBe("network");
  });

  it("pretty-prints JSON", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('{"name":"lu-minal","tags":["moon","agents"]}', { headers: { "content-type": "application/json" } }),
    );
    const res = await createWebFetchTool(fetchImpl).run({ url: "https://api.example.org/repo" }, ctx);
    expect(res.content).toContain('{\n  "name": "lu-minal",\n  "tags": [\n    "moon",');
  });

  it("cuts long text at max_chars and says so", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } }));
    const res = await createWebFetchTool(fetchImpl).run({ url: "http://example.org/big.txt", max_chars: 1000 }, ctx);
    expect(res.content).toContain("[Cut at 1000 of 5000 characters");
    expect(res.display?.detail).toBe("1000 chars");
  });

  it("reads at most 5 MB of a body", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const { fetchImpl } = fakeFetch(() => new Response(body, { headers: { "content-type": "text/plain" } }));
    const res = await createWebFetchTool(fetchImpl).run({ url: "https://example.org/huge", max_chars: 100 }, ctx);
    expect(res.content).toContain("of 5242880 characters");
    expect(res.content).toContain("Only the first 5 MB were read");
    expect(sent).toBeLessThanOrEqual(7);
  });

  it("refuses non-http URLs and binary content", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(new Uint8Array([0x89, 0x50]), { headers: { "content-type": "image/png" } }));
    const tool = createWebFetchTool(fetchImpl);
    expect((await tool.run({ url: "file:///etc/passwd" }, ctx)).isError).toBe(true);
    expect((await tool.run({ url: "not a url" }, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(0);
    const png = await tool.run({ url: "https://example.org/moon.png" }, ctx);
    expect(png.isError).toBe(true);
    expect(png.content).toContain("image/png");
  });

  it("returns error pages as errors with the status", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("<h1>Not here</h1>", { status: 404, statusText: "Not Found", headers: { "content-type": "text/html" } }),
    );
    const res = await createWebFetchTool(fetchImpl).run({ url: "https://example.org/missing" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("404 Not Found");
    expect(res.content).toContain("# Not here");
    expect(res.display?.detail).toBe("HTTP 404 Not Found");
  });

  it("explains network failures and interrupts", async () => {
    const failing = createWebFetchTool(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const res = await failing.run({ url: "https://nowhere.invalid" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("ENOTFOUND");

    const controller = new AbortController();
    const hanging = createWebFetchTool(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = hanging.run({ url: "https://slow.example.org" }, makeCtx({ signal: controller.signal }));
    controller.abort();
    expect((await pending).content).toBe("Interrupted.");
  });

  it("times out on its own signal when AbortSignal.any is missing (older runtimes)", async () => {
    const original = AbortSignal.any;
    (AbortSignal as { any?: unknown }).any = undefined;
    try {
      const controller = new AbortController();
      const seen: AbortSignal[] = [];
      const tool = createWebFetchTool(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            seen.push(init!.signal!);
            init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
      const pending = tool.run({ url: "https://slow.example.org" }, makeCtx({ signal: controller.signal }));
      await new Promise((r) => setTimeout(r, 5));
      expect(seen[0].aborted).toBe(false);
      controller.abort();
      expect((await pending).content).toBe("Interrupted.");
      expect(seen[0].aborted).toBe(true);
    } finally {
      AbortSignal.any = original;
    }
  });

  it("sniffs HTML without a content type and decodes other charsets", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith("latin")
        ? new Response(latin1, { headers: { "content-type": "text/plain; charset=iso-8859-1" } })
        : new Response("<html><body><p>Hi&nbsp;there</p></body></html>"),
    );
    const tool = createWebFetchTool(fetchImpl);
    expect((await tool.run({ url: "https://example.org/latin" }, ctx)).content).toContain("café");
    expect((await tool.run({ url: "https://example.org/plain" }, ctx)).content).toContain("Hi there");
  });
});
