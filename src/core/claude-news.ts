// News about Claude for the start screen: the release notes of the Claude apps (the Help Center's
// page: model launches, plan offers such as monthly credits, new features) and of the Claude
// Platform (API, SDKs, Console), newest first. Both are public pages; nothing but the request is
// sent. Each entry is marked as a model launch, an offer or other news.
import type { FetchLike } from "../providers/types.js";

export const APPS_NOTES_URL = "https://support.claude.com/en/articles/12138966-release-notes";
export const PLATFORM_NOTES_URL = "https://docs.claude.com/en/release-notes/overview.md";

export type ClaudeNewsKind = "model" | "offer" | "news";

export interface ClaudeNewsItem {
  /** yyyy-mm-dd. */
  date: string;
  title: string;
  kind: ClaudeNewsKind;
  source: "apps" | "platform";
  url: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "October 21, 2026" -> "2026-10-21", or null. */
export function isoDate(text: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const MODEL = /\b(Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(\.\d+)?\b/;
const LAUNCH = /\b(launch(es|ed|ing)?|releas(e|ed|ing)|introduc(e|es|ed|ing))\b/i;
/** "Claude Opus 5.5 is now available" - the model itself, not a feature for it. */
const AVAILABLE = /^(Claude\s+)?(Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(\.\d+)?\s+(is|are)\s+(now\s+)?available\b/i;
const OFFER = /\b(credits?|bonus|promo(tion)?s?|double[ds]?|2x|resets?|discounts?|offers?|extra usage|trials?|on us|free (usage|month|week|access|credits?))\b/i;

/** A model launch ("Claude Haiku 5.5 launch"), an offer ("Monthly API credits for Max ..."), or news. */
export function classifyNews(title: string): ClaudeNewsKind {
  if (MODEL.test(title) && (LAUNCH.test(title) || AVAILABLE.test(title))) return "model";
  if (OFFER.test(title)) return "offer";
  return "news";
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;| /g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/**
 * The Claude apps' release notes (the Help Center's HTML): a <h3> per date ("October 21, 2026"),
 * then one bold paragraph per entry ("<p><b>Claude Haiku 5.5 launch</b></p>").
 */
export function parseAppNotes(html: string): ClaudeNewsItem[] {
  const out: ClaudeNewsItem[] = [];
  const parts = html.split(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const date = isoDate(decode(parts[i]));
    if (!date) continue;
    for (const m of parts[i + 1].matchAll(/<p[^>]*>\s*<b>([\s\S]*?)<\/b>/gi)) {
      const title = decode(m[1]);
      if (title) out.push({ date, title, kind: classifyNews(title), source: "apps", url: APPS_NOTES_URL });
    }
  }
  return out;
}

/** Markdown links and emphasis as plain text. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The first sentence of a release-note bullet, at most `max` characters. */
function firstSentence(text: string, max = 160): string {
  const end = text.search(/\.(\s|$)/);
  const s = end > 0 ? text.slice(0, end) : text;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * The Claude Platform's release notes (Markdown): "### October 22, 2026" and a "* " bullet per
 * change; each bullet's first sentence is an entry.
 */
export function parsePlatformNotes(md: string): ClaudeNewsItem[] {
  const out: ClaudeNewsItem[] = [];
  let date: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const head = /^#{2,4}\s+(.+?)\s*$/.exec(line);
    if (head) {
      date = isoDate(head[1]);
      continue;
    }
    const bullet = /^[*-]\s+(.+)$/.exec(line);
    if (!bullet || !date) continue;
    const title = firstSentence(plain(bullet[1]));
    if (title) out.push({ date, title, kind: classifyNews(title), source: "platform", url: "https://platform.claude.com/docs/en/release-notes/overview" });
  }
  return out;
}

/**
 * Both release notes, newest first (the apps' entries before the platform's on the same day), at
 * most `limit`: all of the apps' entries, and the platform's model launches and offers (its other
 * entries are API details that would crowd them out). A page that can't be loaded is left out;
 * this never throws.
 */
export async function fetchClaudeNews(opts: { fetchImpl?: FetchLike; limit?: number; timeoutMs?: number } = {}): Promise<ClaudeNewsItem[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const get = async (url: string): Promise<string | null> => {
    try {
      const res = await fetchImpl(url, { headers: { "user-agent": "lu-minal" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const [apps, platform] = await Promise.all([get(APPS_NOTES_URL), get(PLATFORM_NOTES_URL)]);
  const own = apps ? parseAppNotes(apps) : [];
  // The same launch or offer on both pages, on the same day, is shown once (the apps' words).
  const key = (i: ClaudeNewsItem) => `${i.date} ${i.kind} ${i.kind === "model" ? (MODEL.exec(i.title)?.[0] ?? i.title) : ""}`;
  const seen = new Set(own.map(key));
  const items = [...own, ...(platform ? parsePlatformNotes(platform).filter((i) => i.kind !== "news" && !seen.has(key(i))) : [])];
  // Stable: same-day entries keep their page order, the apps' first.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.date.localeCompare(a.item.date) || a.i - b.i)
    .map((x) => x.item)
    .slice(0, opts.limit ?? 20);
}
