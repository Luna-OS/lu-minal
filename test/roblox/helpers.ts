// Test helpers for the Roblox bridge: raw HTTP requests (node:http, so no fetch adds headers of
// its own) and a fake Studio plugin that speaks the bridge's protocol.
import http from "node:http";
import { PLUGIN_VERSION } from "../../src/roblox/plugin-source.js";

export interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  text: string;
}

/** One request to 127.0.0.1:`port`; carries the plugin header unless `marker` is false. */
export function request(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; marker?: boolean } = {},
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = {
      ...(opts.marker === false ? {} : { "X-LuMinal-Plugin": PLUGIN_VERSION }),
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => {
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export interface PlaceInfo {
  name: string;
  placeId: number;
  gameId: number;
}

/** A Studio plugin as the bridge sees it. */
export class FakePlugin {
  session: string | null = null;

  constructor(readonly port: number) {}

  async hello(place: PlaceInfo = { name: "Moon Obby", placeId: 1818, gameId: 9090 }): Promise<HttpReply> {
    const reply = await request(this.port, "POST", "/hello", {
      body: { place, studioVersion: "0.651.0.6510833", pluginVersion: PLUGIN_VERSION },
    });
    this.session = reply.body?.session ?? null;
    return reply;
  }

  poll(): Promise<HttpReply> {
    return request(this.port, "GET", `/poll?session=${encodeURIComponent(this.session ?? "")}`);
  }

  result(id: string, payload: { ok: boolean; result?: unknown; error?: string }): Promise<HttpReply> {
    return request(this.port, "POST", "/result", { body: { id, ...payload } });
  }

  log(lines: Array<{ type: string; text: string; at?: number }>): Promise<HttpReply> {
    return request(this.port, "POST", "/log", { body: { session: this.session, lines } });
  }

  bye(): Promise<HttpReply> {
    return request(this.port, "POST", "/bye", { body: { session: this.session } });
  }

  /** Polls once and answers the command it gets with `handler`. */
  async serveOnce(
    handler: (command: string, args: any) => { ok: boolean; result?: unknown; error?: string },
  ): Promise<{ command: string; args: any } | null> {
    const reply = await this.poll();
    if (reply.status !== 200) return null;
    await this.result(reply.body.id, handler(reply.body.command, reply.body.args));
    return { command: reply.body.command, args: reply.body.args };
  }
}

/** Resolves once `predicate` holds (checked every few ms), or rejects after `ms`. */
export async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
