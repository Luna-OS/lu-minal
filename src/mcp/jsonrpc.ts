// JSON-RPC 2.0, as far as lu-minal's MCP server needs it: telling requests from notifications and
// responses, and building results and errors.

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** The standard error codes. */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** A JSON-RPC error a handler can throw to answer with a specific code. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const validId = (v: unknown): v is string | number => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** What one incoming message is. */
export type Classified =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  /** A response to a request of ours (we send none, so these are ignored). */
  | { kind: "response" }
  | { kind: "invalid"; id: JsonRpcId };

export function classify(value: unknown): Classified {
  if (!isObj(value) || value.jsonrpc !== "2.0") {
    return { kind: "invalid", id: isObj(value) && validId(value.id) ? value.id : null };
  }
  if (typeof value.method === "string") {
    if (!("id" in value) || value.id === undefined) {
      return { kind: "notification", message: value as unknown as JsonRpcNotification };
    }
    if (!validId(value.id)) return { kind: "invalid", id: null };
    return { kind: "request", message: value as unknown as JsonRpcRequest };
  }
  if ("result" in value || "error" in value) return { kind: "response" };
  return { kind: "invalid", id: validId(value.id) ? value.id : null };
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  const error: JsonRpcFailure["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}
