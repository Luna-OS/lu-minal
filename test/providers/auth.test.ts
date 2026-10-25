import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore, authFile, keyFor, readEnv } from "../../src/providers/auth.js";
import { tempDir } from "./helpers.js";

const posix = process.platform !== "win32";

describe("AuthStore", () => {
  let dir: string;
  let cleanup: () => void;
  let file: string;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    file = path.join(dir, "config", "auth.json");
  });
  afterEach(() => cleanup());

  it("round-trips every entry type through the file", () => {
    const store = new AuthStore(file);
    expect(store.ids()).toEqual([]);
    expect(store.get("openrouter")).toBeNull();

    store.set("openrouter", { type: "oauth", key: "sk-or-v1-abc", createdAt: 1_700_000_000_000, meta: { label: "lu-minal" } });
    store.set("minimax", { type: "api", key: "mm-key" });
    store.set("github", { type: "token", token: "ghp_123", user: "luna" });

    const again = new AuthStore(file);
    expect(again.ids()).toEqual(["github", "minimax", "openrouter"]);
    expect(again.get("openrouter")).toEqual({ type: "oauth", key: "sk-or-v1-abc", createdAt: 1_700_000_000_000, meta: { label: "lu-minal" } });
    expect(again.get("github")).toEqual({ type: "token", token: "ghp_123", user: "luna" });
    expect(again.secretFor("minimax")).toBe("mm-key");
    expect(again.secretFor("github")).toBe("ghp_123");
    expect(again.secretFor("openrouter")).toBe("sk-or-v1-abc");
    expect(again.secretFor("nobody")).toBeNull();

    again.remove("minimax");
    expect(store.ids()).toEqual(["github", "openrouter"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).not.toHaveProperty("minimax");
  });

  it("sees changes another process wrote", () => {
    const a = new AuthStore(file);
    const b = new AuthStore(file);
    a.set("opencode", { type: "api", key: "one" });
    expect(b.secretFor("opencode")).toBe("one");
    b.set("opencode", { type: "api", key: "two" });
    expect(a.secretFor("opencode")).toBe("two");
  });

  it("refuses malformed entries", () => {
    const store = new AuthStore(file);
    expect(() => store.set("x", { type: "api", key: "" })).toThrow();
    expect(() => store.set("x", { type: "nope" } as never)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps entries it doesn't understand", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ future: { type: "wellknown", url: "https://x" }, broken: { type: "api" } }));
    const store = new AuthStore(file);
    expect(store.ids()).toEqual([]);
    expect(store.get("future")).toBeNull();
    store.set("minimax", { type: "api", key: "k" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.future).toEqual({ type: "wellknown", url: "https://x" });
    expect(raw.minimax).toEqual({ type: "api", key: "k" });
  });

  it("reads a corrupt file as empty and backs it up before writing", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"openrouter": {"type": "api", "key": "sk-or');
    const store = new AuthStore(file);
    expect(store.ids()).toEqual([]);
    expect(store.secretFor("openrouter")).toBeNull();
    // Reading never touches it.
    expect(fs.existsSync(`${file}.bak`)).toBe(false);

    store.set("minimax", { type: "api", key: "k" });
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe('{"openrouter": {"type": "api", "key": "sk-or');
    expect(store.ids()).toEqual(["minimax"]);

    // A second corruption doesn't clobber the first backup.
    fs.writeFileSync(file, "[1, 2");
    store.set("groq", { type: "api", key: "g" });
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".bak"));
    expect(backups).toHaveLength(2);
    expect(store.ids()).toEqual(["groq"]);
  });

  it("treats a JSON array or an empty file as no sign-ins", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(new AuthStore(file).ids()).toEqual([]);
    fs.writeFileSync(file, "[]");
    const store = new AuthStore(file);
    expect(store.ids()).toEqual([]);
    store.set("a", { type: "api", key: "b" });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });

  it("removing from a missing file does nothing", () => {
    new AuthStore(file).remove("x");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves no temp files behind", () => {
    const store = new AuthStore(file);
    for (let i = 0; i < 5; i++) store.set(`p${i}`, { type: "api", key: `k${i}` });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["auth.json"]);
  });

  it.runIf(posix)("keeps the file private (0600, dir 0700)", () => {
    const store = new AuthStore(file);
    store.set("openrouter", { type: "api", key: "secret" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    // A file someone made world-readable gets fixed on the next write.
    fs.chmodSync(file, 0o644);
    store.set("minimax", { type: "api", key: "k" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("puts the default file in the config dir", () => {
    expect(authFile(dir)).toBe(path.join(dir, "auth.json"));
    expect(path.basename(AuthStore.default().file)).toBe("auth.json");
  });
});

describe("keyFor", () => {
  let dir: string;
  let cleanup: () => void;
  let store: AuthStore;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    store = new AuthStore(path.join(dir, "auth.json"));
  });
  afterEach(() => cleanup());

  it("prefers the stored sign-in over the environment", () => {
    store.set("openrouter", { type: "oauth", key: "from-auth", createdAt: 1 });
    expect(keyFor("openrouter", ["OPENROUTER_API_KEY"], store, { OPENROUTER_API_KEY: "from-env" })).toEqual({
      key: "from-auth",
      source: "auth",
    });
  });

  it("takes the first env variable that is set, trimmed", () => {
    const env = { GOOGLE_API_KEY: "  ", GEMINI_API_KEY: " gem-key\n", GOOGLE_GENERATIVE_AI_API_KEY: undefined };
    expect(keyFor("google", ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"], store, env)).toEqual({
      key: "gem-key",
      source: "env",
    });
  });

  it("returns null when there is no key anywhere", () => {
    expect(keyFor("minimax", ["MINIMAX_API_KEY"], store, {})).toBeNull();
    expect(keyFor("minimax", [], store, { MINIMAX_API_KEY: "x" })).toBeNull();
  });

  it("uses tokens too", () => {
    store.set("forgejo", { type: "token", token: "tok" });
    expect(keyFor("forgejo", [], store, {})).toEqual({ key: "tok", source: "auth" });
  });
});

describe("readEnv", () => {
  it("returns trimmed values and null for blanks", () => {
    expect(readEnv({ A: " x " }, "A")).toBe("x");
    expect(readEnv({ A: "" }, "A")).toBeNull();
    expect(readEnv({}, "A")).toBeNull();
  });

  it.runIf(process.platform === "win32")("ignores case on Windows", () => {
    expect(readEnv({ openrouter_api_key: "k" }, "OPENROUTER_API_KEY")).toBe("k");
  });

  it.runIf(posix)("is case-sensitive elsewhere", () => {
    expect(readEnv({ openrouter_api_key: "k" }, "OPENROUTER_API_KEY")).toBeNull();
  });
});
