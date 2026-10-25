// Addresses that are not the open web: this machine (localhost, 127.0.0.0/8, ::1), private and
// carrier-grade NAT networks, link-local ones (169.254.169.254 is the cloud metadata endpoint that
// hands out credentials), multicast and reserved ranges, and host names that only mean something
// on the local network (*.local, *.internal, *.lan, single-label names). A fetch there is not "just
// reading the web": it reaches lu-minal's own servers, the user's dev servers and router, or a
// cloud VM's credentials, so web_fetch asks first (see src/tools/web.ts).
import { isIP } from "node:net";

/** Whether an IPv4 address (dotted quad) is not a public internet address. */
function privateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // "this network", private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** The IPv4 address inside an IPv4-mapped / NAT64 IPv6 address, or null. */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (m) return m[1];
  const hex = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Whether an IP address (v4 or v6, brackets allowed) is not a public internet address. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind !== 6) return false;
  const v4 = embeddedV4(ip);
  if (v4) return privateV4(v4);
  if (ip === "::" || ip === "::1") return true;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Host names that only resolve on this machine or the local network. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".intranet", ".corp", ".localdomain"];

/** Whether a URL's host name (as `new URL().hostname` gives it) is not on the open web. */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (isIP(host.replace(/^\[|\]$/g, ""))) return isPrivateAddress(host);
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  // A single label ("router", "metadata") is looked up in the local search domains.
  return !host.includes(".");
}

/** Whether a URL points at this machine or the local network (true for URLs that don't parse). */
export function isPrivateUrl(url: string): boolean {
  try {
    return isPrivateHostname(new URL(String(url ?? "").trim()).hostname);
  } catch {
    return false;
  }
}

/** A DNS lookup: every address a host name resolves to. */
export type LookupAll = (hostname: string) => Promise<string[]>;

/** The system resolver's answers for `hostname` (what fetch will connect to). */
export const systemLookup: LookupAll = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

/**
 * Whether `hostname` is or resolves to a private address. A name that doesn't resolve counts as
 * public (the fetch will fail on its own).
 */
export async function resolvesPrivate(hostname: string, lookup: LookupAll = systemLookup): Promise<boolean> {
  if (isPrivateHostname(hostname)) return true;
  let addresses: string[];
  try {
    addresses = await lookup(hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
  return addresses.some(isPrivateAddress);
}
