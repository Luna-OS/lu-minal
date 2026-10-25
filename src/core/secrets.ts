// Secret values lu-minal knows (stored API keys and tokens, secret-looking environment variables,
// the MCP servers' bearer tokens) and the redaction that keeps them out of what models read and
// what the panels and session.json show. Defense in depth: a tool that prints the environment, or a
// provider error that echoes a key, shows "[redacted]" instead of the value.

const secrets = new Set<string>();
let envScanned = false;

/** Values shorter than this are too likely to be ordinary text ("public", "true"). */
const MIN_LENGTH = 12;

/** Environment variables whose values are secrets by their names. */
const SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;

/** Names that hold a location rather than the secret itself. */
const NOT_A_VALUE = /(?:_SOCK|_PATH|_FILE|_DIR|_HOME|_URL|_HOST|_CREDENTIALS)$/i;

export const REDACTED = "[redacted]";

/** Remembers a secret value so redactSecrets() hides it. */
export function registerSecret(value: string | null | undefined): void {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length >= MIN_LENGTH) secrets.add(v);
}

/**
 * Forgets every secret (tests). A removed sign-in's key stays redacted until lu-minal quits: it
 * may still be valid.
 */
export function clearSecrets(): void {
  secrets.clear();
  envScanned = false;
}

/** Registers the values of secret-looking environment variables (OPENAI_API_KEY, GITHUB_TOKEN, ...). */
export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    // SSH_AUTH_SOCK, GOOGLE_APPLICATION_CREDENTIALS=/path/...: where a secret is, not the secret.
    if (value && SECRET_NAME.test(name) && !NOT_A_VALUE.test(name)) registerSecret(value);
  }
}

/** `text` with every known secret value replaced by "[redacted]". */
export function redactSecrets(text: string): string {
  if (!envScanned) {
    envScanned = true;
    registerEnvSecrets();
  }
  if (!text || !secrets.size) return text;
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}
