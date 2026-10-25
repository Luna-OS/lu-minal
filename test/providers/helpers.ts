// Shared helpers for the provider tests: the trimmed models.dev fixture, temp dirs and fake fetches.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../../src/providers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A fresh copy of test/fixtures/models-dev.json (a real models.dev excerpt). */
export function loadFixture(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(here, "..", "fixtures", "models-dev.json"), "utf8"));
}

/** A new empty temp dir, removed by the returned cleanup. */
export function tempDir(prefix = "lu-minal-providers-"): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that answers every call with `respond` and records the calls. */
export function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchLike & {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as FetchLike & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
