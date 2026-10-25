// The wire clients: one factory per protocol, and `createChatClient` to pick one by WireKind.
import type { ChatClient, FetchLike, WireEndpoint, WireKind } from "../types.js";
import { createAnthropicClient } from "./anthropic.js";
import { defaultFetch } from "./http.js";
import { createOpenAIChatClient } from "./openai-chat.js";
import { createOpenAIResponsesClient } from "./openai-responses.js";

export { createAnthropicClient } from "./anthropic.js";
export { createOpenAIChatClient } from "./openai-chat.js";
export { createOpenAIResponsesClient } from "./openai-responses.js";
export { parseSSE, type SSEMessage } from "./sse.js";
export { parseToolArguments, repairJson } from "./convert.js";
export { errorFromResponse, joinURL, parseRetryAfter } from "./http.js";

/** The chat client for `wire`, talking to `endpoint` (fetch defaults to `globalThis.fetch`). */
export function createChatClient(wire: WireKind, endpoint: WireEndpoint, fetchImpl: FetchLike = defaultFetch): ChatClient {
  switch (wire) {
    case "openai-chat":
      return createOpenAIChatClient(endpoint, fetchImpl);
    case "openai-responses":
      return createOpenAIResponsesClient(endpoint, fetchImpl);
    case "anthropic":
      return createAnthropicClient(endpoint, fetchImpl);
    default:
      throw new Error(`Unknown wire protocol: ${String(wire)}`);
  }
}
