// The claude.ai website beside the terminal. A lu-minal window with a web pane (the macOS app, the
// Windows window app) sets LU_MINAL_WEB_PANE=1 and reads a private OSC sequence out of what
// lu-minal writes to the terminal:
//
//   ESC ] 7701 ; <command> [; <argument>] BEL
//
// "open;<url>" shows the pane on <url>, "show" shows it (keeping its page), "hide" and "toggle".
// The host takes these sequences out of the stream before its terminal draws it and only ever
// displays the real website: it never scripts the page or reads its cookies, and lu-minal doesn't
// either. Any program in the terminal could print the sequence, so the URL check (https on
// claude.ai or a subdomain of it) is the security boundary; the hosts make the same check, and
// lu-minal sends nothing they would refuse.

/** The private OSC number the hosts listen for. */
export const WEB_PANE_OSC = 7701;

/** Hosts drop a sequence longer than this (in bytes, ESC to BEL). */
export const WEB_PANE_MAX_BYTES = 4096;

/** The page the pane shows first: Claude Code's cloud sessions. */
export const WEB_PANE_HOME = "https://claude.ai/code";

export type WebPaneCommand = "open" | "show" | "hide" | "toggle";

const COMMANDS: readonly WebPaneCommand[] = ["open", "show", "hide", "toggle"];

/** Whether the window lu-minal runs in has a web pane beside the terminal. */
export function hasWebPane(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LU_MINAL_WEB_PANE === "1";
}

/** The host's own key that shows and hides the pane (it never reaches lu-minal). */
export function webPaneKey(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "cmd+shift+k" : "ctrl+shift+k";
}

/** C0 controls, DEL and C1 controls: none may travel inside the sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The URL as the pane would load it (normalised: lower-case host, no default port), or null when
 * it is not an https page on claude.ai or one of its subdomains. Refused as well: control
 * characters, spaces and backslashes anywhere (URL parsers disagree on what they mean), a user
 * name or password ("https://claude.ai@evil.com" is a page on evil.com) and any other port.
 */
export function cloudUrl(url: string): string | null {
  if (typeof url !== "string" || CONTROL.test(url) || /[\s\\]/.test(url)) return null;
  if (!/^https:\/\//i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname;
  if (host !== "claude.ai" && !(host.endsWith(".claude.ai") && host.length > ".claude.ai".length)) return null;
  // The parser percent-encodes what it doesn't keep; nothing outside printable ASCII is left.
  return /^[\x21-\x7e]+$/.test(u.href) ? u.href : null;
}

/** Whether lu-minal may send `url` to the pane (and a host would show it). */
export function isCloudUrl(url: string): boolean {
  return cloudUrl(url) !== null;
}

/**
 * The OSC 7701 sequence for a command, or null when there is nothing safe to send: an unknown
 * command, "open" without a claude.ai URL, an argument for the commands that take none, or a
 * sequence longer than the hosts accept. The URL goes out normalised (see cloudUrl).
 */
export function webPaneSequence(command: WebPaneCommand, arg?: string): string | null {
  if (!COMMANDS.includes(command)) return null;
  let body: string = command;
  if (command === "open") {
    const url = arg === undefined ? null : cloudUrl(arg);
    if (!url) return null;
    body = `open;${url}`;
  } else if (arg !== undefined && arg !== "") {
    return null;
  }
  const seq = `\u001b]${WEB_PANE_OSC};${body}\u0007`;
  if (CONTROL.test(body) || Buffer.byteLength(seq, "utf8") > WEB_PANE_MAX_BYTES) return null;
  return seq;
}

/** Where the sequence is written: the terminal (process.stdout), past Ink. */
export interface TerminalOut {
  write(data: string): unknown;
}

/**
 * Tells the window's web pane what to do. The sequence goes straight to the terminal, not through
 * Ink: it moves no cursor and the host takes it out, so Ink's frame stays as it is. Writes nothing
 * (and returns false) outside a window with a pane, or when webPaneSequence refuses the command.
 */
export function writeWebPane(
  command: WebPaneCommand,
  arg?: string,
  out: TerminalOut = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!hasWebPane(env)) return false;
  const seq = webPaneSequence(command, arg);
  if (!seq) return false;
  out.write(seq);
  return true;
}

/**
 * A claude.ai page from what was typed after /web: a full https link, the same without "https://"
 * ("claude.ai/code/session_…"), or a cloud session's id. Null for anything else.
 */
export function cloudUrlFromInput(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(?:session|cse)_[A-Za-z0-9_-]{6,}$/.test(t)) return `${WEB_PANE_HOME}/${t}`;
  if (/^https?:\/\//i.test(t)) return cloudUrl(t);
  // A link without its scheme: only the host part decides, so "evil.com/claude.ai" stays out.
  return /^(?:[a-z0-9-]+\.)*claude\.ai(?:[/?#]|$)/i.test(t) ? cloudUrl(`https://${t}`) : null;
}
