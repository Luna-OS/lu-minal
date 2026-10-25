// The provider-neutral chat types every wire client speaks. The agent loop (src/agents/native/)
// keeps its conversation in these shapes; each wire client (src/providers/wire/) converts them to
// and from its own protocol.

/** A JSON Schema object as tools describe their parameters. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** One function call the model asked for, with its arguments already parsed. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A picture sent with a user message (base64, one of the IMAGE_TYPES in core/attachments). */
export interface ImagePart {
  mediaType: string;
  data: string;
}

export interface UserMessage {
  role: "user";
  content: string;
  /** Pictures for models that can see (each wire puts them in its own block shape). */
  images?: ImagePart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
  /** Readable reasoning text, when the model streamed some. */
  reasoning?: string;
  /**
   * Wire-specific data that has to go back to the same provider on the next request, verbatim:
   * Anthropic's content blocks with thinking signatures, OpenAI-compatible `reasoning_content` /
   * `reasoning_details`, Responses API output items. Only the wire that wrote it reads it.
   */
  raw?: { wire: WireKind; data: unknown };
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** A tool as the model sees it. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** "low" | "medium" | "high" | ... when the model supports reasoning effort. */
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  /** Emitted once a tool call is complete (its arguments fully streamed and parsed). */
  | { type: "tool_call"; call: ToolCall }
  | ({ type: "usage" } & TokenUsage)
  /** The last event: the whole assistant message, ready to append to the conversation. */
  | { type: "done"; stopReason: string; message: AssistantMessage };

/** The three wire protocols lu-minal speaks. */
export type WireKind = "openai-chat" | "openai-responses" | "anthropic";

/** Where and how to reach a model. */
export interface WireEndpoint {
  /** Base URL without a trailing slash, e.g. "https://openrouter.ai/api/v1". */
  baseURL: string;
  apiKey?: string;
  /** Extra headers (OpenRouter's HTTP-Referer / X-Title, ...). */
  headers?: Record<string, string>;
  /** Extra top-level body fields merged into every request. */
  body?: Record<string, unknown>;
}

export interface ChatClient {
  readonly wire: WireKind;
  stream(request: ChatRequest): AsyncGenerator<StreamEvent, void, void>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** An HTTP error from a provider, with the parts the retry logic needs. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
    readonly body: string = "",
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** 408, 409, 429 and 5xx are worth another try. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}
