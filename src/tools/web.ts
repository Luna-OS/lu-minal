// web_fetch: reads a web page or an API answer as text. HTML becomes readable text (scripts,
// styles and navigation dropped, headings and links kept), JSON is pretty-printed. The fetch is
// injectable, so tests never touch the network.
import type { FetchLike } from "../providers/types.js";
import { clip, defineTool, plural } from "./fs.js";
import { isPrivateUrl, resolvesPrivate, systemLookup, type LookupAll } from "./net-guard.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CHARS = 20_000;
const MAX_CHARS = 200_000;

// ---- HTML to text -------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  plusmn: "±",
  deg: "°",
  micro: "µ",
  para: "¶",
  sect: "§",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  rArr: "⇒",
  lArr: "⇐",
  hearts: "♥",
  star: "☆",
  check: "✓",
  iexcl: "¡",
  iquest: "¿",
  shy: "",
  zwj: "",
  zwnj: "",
  auml: "\u00e4",
  ouml: "\u00f6",
  uuml: "\u00fc",
  Auml: "\u00c4",
  Ouml: "\u00d6",
  Uuml: "\u00dc",
  szlig: "\u00df",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  ccedil: "ç",
  Eacute: "É",
  oslash: "ø",
  aring: "å",
  aelig: "æ",
};

/** Decodes HTML entities: named ones, "&#39;" and "&#x1F600;". Unknown names stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code === 160 ? 32 : code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) return match;
    // Without the ";" only the common ones decode (as browsers do for "&amp" in old pages).
    if (!match.endsWith(";") && !["amp", "lt", "gt", "quot", "nbsp"].includes(body)) return match;
    return named;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

function absolute(href: string, base: string | undefined): string {
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

const DROP_BLOCKS = ["script", "style", "noscript", "template", "svg", "nav", "iframe", "canvas", "object", "select"];
const BREAK_TAGS =
  /^(p|div|section|article|main|aside|header|footer|blockquote|figure|figcaption|table|thead|tbody|tfoot|ul|ol|dl|form|fieldset|address|details|summary|hr)$/;

/**
 * Turns an HTML page into readable text: drops scripts, styles and navigation, keeps the title,
 * headings ("## Heading"), list items ("- item"), links ("text (url)", resolved against `baseUrl`)
 * and preformatted blocks, decodes entities and collapses whitespace.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  s = s.replace(/<head[\s>][\s\S]*?<\/head>/i, "");
  for (const tag of DROP_BLOCKS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, "gi"), " ");
  }

  // Preformatted blocks keep their line breaks; park them until the whitespace is collapsed.
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
    const text = decodeEntities(body.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
    pres.push(text.replace(/^\n+|\s+$/g, ""));
    return `\n\n\u0000PRE${pres.length - 1}\u0000\n\n`;
  });

  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const href = attr(` ${attrs}`, "href");
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return text;
    const url = absolute(href, baseUrl);
    if (!text) return url;
    return text === url || text === href ? text : `${text} (${url})`;
  });
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = attr(tag, "alt");
    return alt ? ` [image: ${alt}] ` : " ";
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
  });
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(td|th)\b[^>]*>/gi, " ");
  s = s.replace(/<\/?(tr|dt|dd)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, tag: string) => (BREAK_TAGS.test(tag.toLowerCase()) ? "\n\n" : ""));
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);

  const lines = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim());
  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  text = text.replace(/\u0000PRE(\d+)\u0000/g, (_m, i: string) => pres[Number(i)] ?? "");
  const heading = title ? decodeEntities(title[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
  if (heading && !text.startsWith(`# ${heading}`)) text = `# ${heading}\n\n${text}`;
  return text;
}

// ---- fetching -----------------------------------------------------------------------------------

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return m ? m[1].toLowerCase() : "utf-8";
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readBody(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > max ? { bytes: buf.subarray(0, max), truncated: true } : { bytes: buf, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out, truncated };
}

/** Aborts when any of `signals` does (AbortSignal.any where the runtime has it). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any.call(AbortSignal, signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

type FetchArgs = { url: string; max_chars?: number };

function isTextual(type: string): boolean {
  return /^text\/|[/+](json|xml|javascript|ecmascript|x-www-form-urlencoded|yaml|toml|csv|markdown)\b|^application\/(x-)?(sh|sql|graphql)/i.test(type);
}

/** How many redirects web_fetch follows (each one is checked like the first URL). */
const MAX_REDIRECTS = 5;

function originOf(url: URL | string): string {
  try {
    return new URL(String(url)).origin;
  } catch {
    return String(url);
  }
}

export interface WebFetchOptions {
  /**
   * Resolves host names to check whether a public-looking name points at this machine or the
   * local network. Default: the system resolver with the global fetch; none (literal checks only)
   * with an injected fetch, unless one is given.
   */
  lookup?: LookupAll | null;
}

/**
 * The web_fetch tool, fetching with `fetchImpl` (default: the global fetch). Public http(s) URLs
 * are a "network" action; this machine, the local network, cloud metadata endpoints and names
 * that resolve there are "other" (always asked), also when a redirect or DNS leads there.
 */
export function createWebFetchTool(fetchImpl?: FetchLike, opts: WebFetchOptions = {}): Tool {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const lookup: LookupAll | null = opts.lookup !== undefined ? opts.lookup : fetchImpl ? null : systemLookup;

  /** Asks before a hop to a private address the first approval didn't cover. */
  async function allowPrivate(target: URL, approved: Set<string>, ctx: ToolContext, why: string): Promise<boolean> {
    const origin = originOf(target);
    if (approved.has(origin)) return true;
    const ok = await ctx.approve({
      risk: "other",
      summary: `fetch ${target.toString()} (${why})`,
      allowKey: `web_fetch:${origin}`,
    });
    if (ok) approved.add(origin);
    return ok;
  }

  return defineTool<FetchArgs>({
    name: "web_fetch",
    description:
      "Fetches a URL (http or https) and returns its content as text: HTML pages become readable " +
      "text with headings and links, JSON is pretty-printed. At most 5 MB are read and 20000 " +
      "characters returned (`max_chars` changes that). Use it for docs, issues, API answers.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch." },
        max_chars: { type: "integer", description: "At most this many characters of text (default 20000)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    risk: (args) => (isPrivateUrl(String(args.url ?? "")) ? "other" : "network"),
    describe(args) {
      let target = String(args.url ?? "");
      try {
        const u = new URL(target);
        target = `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
      } catch {
        // shown as given
      }
      return { verb: "fetch", target: clip(target, 70) };
    },
    approval: (args) => {
      const url = String(args.url ?? "");
      if (!isPrivateUrl(url)) return { risk: "network", summary: `fetch ${url}`, allowKey: "web_fetch" };
      return { risk: "other", summary: `fetch ${url} (this machine or the local network)`, allowKey: `web_fetch:${originOf(url)}` };
    },
    async run(args, ctx): Promise<ToolResult> {
      let url: URL;
      try {
        url = new URL(String(args.url ?? "").trim());
      } catch {
        return { content: `Not a valid URL: ${String(args.url ?? "")}`, isError: true, display: { detail: "invalid URL" } };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { content: `Only http and https URLs can be fetched (got ${url.protocol}).`, isError: true, display: { detail: "not http(s)" } };
      }
      const maxChars = Math.min(MAX_CHARS, Math.max(100, Math.floor(Number(args.max_chars) || DEFAULT_CHARS)));
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = anySignal([ctx.signal, timeout]);
      // A private URL was asked about before run (risk "other"); public ones may still lead there.
      const approved = new Set<string>(isPrivateUrl(url.toString()) ? [originOf(url)] : []);
      let res: Response;
      let target = url;
      try {
        for (let hop = 0; ; hop++) {
          if (lookup && !approved.has(originOf(target)) && (await resolvesPrivate(target.hostname, lookup))) {
            if (!(await allowPrivate(target, approved, ctx, "resolves to this machine or the local network"))) {
              return { content: `Not fetched: ${target.host} is on this machine or the local network, and the user said no.`, isError: true, display: { detail: "local address denied" } };
            }
          }
          res = await doFetch(target.toString(), {
            method: "GET",
            // Followed by hand, so every hop is checked like the first URL.
            redirect: "manual",
            signal,
            headers: {
              "User-Agent": "lu-minal (a coding agent; +https://github.com/Luna-OS/lu-minal)",
              Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            },
          });
          const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
          if (!location) break;
          if (hop >= MAX_REDIRECTS) {
            return { content: `${url} redirected more than ${MAX_REDIRECTS} times; stopped at ${target}.`, isError: true, display: { detail: "too many redirects" } };
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, target);
          } catch {
            return { content: `${target} redirected to an invalid address: ${location}`, isError: true, display: { detail: "bad redirect" } };
          }
          if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
            return { content: `${target} redirected to ${nextUrl.protocol} (only http and https are fetched).`, isError: true, display: { detail: "not http(s)" } };
          }
          if (isPrivateUrl(nextUrl.toString()) && !(await allowPrivate(nextUrl, approved, ctx, "a redirect to this machine or the local network"))) {
            return { content: `Not fetched: ${target} redirected to ${nextUrl}, on this machine or the local network, and the user said no.`, isError: true, display: { detail: "local redirect denied" } };
          }
          await res.body?.cancel().catch(() => undefined);
          target = nextUrl;
        }
      } catch (err) {
        if (ctx.signal.aborted) return { content: "Interrupted.", isError: true };
        if (timeout.aborted) {
          return { content: `${url} did not answer within ${TIMEOUT_MS / 1000} s.`, isError: true, display: { detail: "timed out" } };
        }
        const message = err instanceof Error ? err.message : String(err);
        const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
        const why = cause?.code ?? cause?.message ?? "";
        return { content: `Could not fetch ${url}: ${message}${why ? ` (${why})` : ""}`, isError: true, display: { detail: clip(message, 60) } };
      }
      let body: { bytes: Uint8Array; truncated: boolean };
      try {
        body = await readBody(res, MAX_BYTES);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "Interrupted.", isError: true };
        if (timeout.aborted) return { content: `${url} took longer than ${TIMEOUT_MS / 1000} s.`, isError: true, display: { detail: "timed out" } };
        return { content: `Reading ${url} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      const finalUrl = res.url || target.toString();
      let text = decode(body.bytes, charsetOf(type));
      // Untyped or mislabelled ("text/plain") documents that are plainly HTML read as HTML.
      const sniffHtml = (!type || type.startsWith("text/plain")) && /^\s*(<!doctype html|<html[\s>])/i.test(text);
      if (type.includes("html") || sniffHtml) {
        text = htmlToText(text, finalUrl);
      } else if (type.includes("json") || (!type && /^\s*[[{]/.test(text))) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Not valid JSON after all; keep the text.
        }
      } else if (type && !isTextual(type)) {
        return {
          content: `${finalUrl} is ${type.split(";")[0]} (${body.bytes.length} bytes), not text; web_fetch only reads text.`,
          isError: true,
          display: { detail: type.split(";")[0] },
        };
      }
      const total = text.length;
      if (total > maxChars) text = `${text.slice(0, maxChars)}\n\n[Cut at ${maxChars} of ${total} characters; pass a larger max_chars to read more.]`;
      if (body.truncated) text += `\n\n[Only the first ${MAX_BYTES / 1024 / 1024} MB were read.]`;
      const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      const header = `${finalUrl} · ${status}${type ? ` · ${type.split(";")[0]}` : ""}`;
      if (!res.ok) {
        return { content: `${header}\n\n${text || "(empty body)"}`, isError: true, display: { detail: `HTTP ${status}` } };
      }
      return { content: `${header}\n\n${text || "(empty body)"}`, display: { detail: plural(Math.min(total, maxChars), "char") } };
    },
  });
}

/** web_fetch with the global fetch. */
export const webFetchTool = createWebFetchTool();
