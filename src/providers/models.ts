// Types for providers and models: what the catalog (models.dev + lu-minal's own entries) knows and
// what the registry hands the agent runtime once a model is resolved.
import type { WireEndpoint, WireKind } from "./types.js";

/** A model as agents and the UI refer to it: "claude-code/opus", "opencode/big-pickle", ... */
export interface ModelRef {
  provider: string;
  model: string;
}

export const formatModelRef = (ref: ModelRef): string => `${ref.provider}/${ref.model}`;

/** "provider/model" (the model part may itself contain slashes, as on OpenRouter). */
export function parseModelRef(text: string): ModelRef | null {
  const t = text.trim();
  const slash = t.indexOf("/");
  if (slash <= 0 || slash === t.length - 1) return null;
  return { provider: t.slice(0, slash), model: t.slice(slash + 1) };
}

/**
 * How lu-minal talks to a provider:
 * - "claude-code": through the official Claude Code CLI, signed in with the Claude subscription
 *   (no API key, lu-minal never sees a token).
 * - "api": a hosted HTTP API (one of the three wire protocols).
 * - "local": a server on this machine (Ollama, LM Studio), no key needed.
 * - "acp": a coding-agent CLI driven over the Agent Client Protocol (OpenCode, Gemini CLI, custom
 *   ones from config.json); it signs in and talks to its models itself (src/agents/acp/).
 */
export type ProviderKind = "claude-code" | "api" | "local" | "acp";

/**
 * How a provider signs in:
 * - "cli": the provider's own CLI keeps the login (Claude Code).
 * - "api-key": a key from the provider's console (or one of `env`).
 * - "oauth": a browser sign-in that ends in a key (OpenRouter's PKCE flow), API key also accepted.
 * - "optional": works without a key for its free models (OpenCode Zen), more with one.
 * - "none": nothing to sign in to (local servers).
 */
export type ProviderAuth = "cli" | "api-key" | "oauth" | "optional" | "none";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  auth: ProviderAuth;
  /** The default wire for the provider's models (a model may override it). */
  wire: WireKind | null;
  baseURL: string | null;
  /** Environment variables that hold the key, in order of preference. */
  env: string[];
  /** Where to get a key / read the docs. */
  doc: string | null;
  /** False when lu-minal can't speak the provider's protocol (Bedrock, Vertex, ...). */
  supported: boolean;
  /** Shown first in pickers. */
  featured?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  wire: WireKind | null;
  baseURL: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  toolCall: boolean;
  reasoning: boolean;
  /** Takes pictures as input (models.dev's modalities.input has "image"). */
  vision?: boolean;
  /** Costs nothing to use (input and output price 0). */
  free: boolean;
  /** USD per million tokens. */
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
  /** "deprecated" / "beta" / ... from the catalog. */
  status: string | null;
  releaseDate: string | null;
}

/** Everything the runtime needs to talk to one model. */
export interface ResolvedModel {
  ref: ModelRef;
  provider: ProviderInfo;
  model: ModelInfo;
  /** Null for "claude-code" and "acp" models, which run through their CLI. */
  endpoint: WireEndpoint | null;
  wire: WireKind | null;
}
