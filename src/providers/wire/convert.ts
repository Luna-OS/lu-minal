// Helpers the wire clients share: tolerant parsing of streamed tool-call arguments (models and
// providers sometimes send trailing garbage, cut-off objects or double-encoded JSON), and small
// guards for the loosely typed JSON the providers send.

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.parse`, or undefined when the text is not JSON. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A string field, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A finite number field, or undefined. */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const DANGLING_MEMBER = /,\s*"(?:[^"\\]|\\.)*"\s*$/;
const DANGLING_FIRST_MEMBER = /\{\s*"(?:[^"\\]|\\.)*"\s*$/;

/**
 * A light repair for broken JSON objects: skips text before the first "{" (and a markdown code
 * fence), drops what follows the object's closing brace, removes trailing commas, closes an open
 * string, and adds missing closing brackets. Returns JSON text that parses, or null.
 */
export function repairJson(text: string): string | null {
  let s = text.trim();
  const fence = /^```[\w-]*\s*([\s\S]*?)\s*(?:```)?\s*$/.exec(s);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  if (start === -1) return null;

  let out = "";
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let closed = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out += ch;
    } else if (ch === "}" || ch === "]") {
      out = out.replace(/[\s,]+$/, "");
      out += stack.pop();
      if (stack.length === 0) {
        closed = true;
        break;
      }
    } else {
      out += ch;
    }
  }

  const candidates: string[] = [];
  if (closed) {
    candidates.push(out);
  } else {
    if (inString) {
      if (escaped) out = out.slice(0, -1);
      out += '"';
    }
    out = out.replace(/[\s,]+$/, "");
    const close = (body: string) => body + [...stack].reverse().join("");
    if (/:\s*$/.test(out)) {
      candidates.push(close(`${out}null`));
      candidates.push(close(out.replace(/:\s*$/, "").replace(DANGLING_MEMBER, "").replace(DANGLING_FIRST_MEMBER, "{")));
    } else {
      candidates.push(close(out));
      if (DANGLING_MEMBER.test(out)) candidates.push(close(out.replace(DANGLING_MEMBER, "")));
      else if (DANGLING_FIRST_MEMBER.test(out)) candidates.push(close(out.replace(DANGLING_FIRST_MEMBER, "{")));
    }
  }
  for (const candidate of candidates) {
    if (safeJsonParse(candidate) !== undefined) return candidate;
  }
  return null;
}

/**
 * Parses a tool call's streamed arguments. Never throws: empty text gives {}, double-encoded JSON
 * ("\"{...}\"") is unwrapped, broken JSON goes through `repairJson`, and anything that still is
 * not a JSON object gives {}.
 */
export function parseToolArguments(text: string | null | undefined): Record<string, unknown> {
  if (text === null || text === undefined) return {};
  const t = text.trim();
  if (t === "") return {};
  let value = safeJsonParse(t);
  if (typeof value === "string") value = safeJsonParse(value.trim()) ?? value;
  if (isRecord(value)) return value;
  if (value !== undefined) return {};
  const repaired = repairJson(t);
  if (repaired === null) return {};
  const parsed = safeJsonParse(repaired);
  return isRecord(parsed) ? parsed : {};
}
