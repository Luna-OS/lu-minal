// A local Ollama server: which models are pulled (GET /api/tags). Agents talk to it through its
// OpenAI-compatible endpoint at <base>/v1.
import type { ModelInfo } from "./models.js";
import type { FetchLike } from "./types.js";

export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
const TAGS_TIMEOUT_MS = 1500;

interface OllamaTag {
  name?: unknown;
  model?: unknown;
  modified_at?: unknown;
  details?: { parameter_size?: unknown; family?: unknown; families?: unknown } | null;
}

/** "http://host:11434" from "http://host:11434", ".../", ".../v1" or ".../api". */
export function ollamaRoot(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "").replace(/\/(v1|api)$/i, "");
}

const isEmbedding = (tag: OllamaTag, id: string) => {
  if (/embed/i.test(id)) return true;
  const families = [tag.details?.family, ...(Array.isArray(tag.details?.families) ? tag.details.families : [])];
  return families.some((f) => typeof f === "string" && /bert/i.test(f));
};

/**
 * The models pulled on an Ollama server, as "ollama" models (OpenAI chat wire at <root>/v1, free,
 * tool calling assumed). Embedding models are left out. The release date is when the model was
 * pulled, so the newest pull sorts first. Resolves [] when the server isn't running, answers
 * slowly (1.5 s) or sends something unexpected.
 */
export async function listOllamaModels(
  baseURL: string = OLLAMA_DEFAULT_URL,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): Promise<ModelInfo[]> {
  const root = ollamaRoot(baseURL);
  try {
    const res = await fetchImpl(`${root}/api/tags`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: unknown } | null;
    if (!body || !Array.isArray(body.models)) return [];
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const raw of body.models as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const tag = raw as OllamaTag;
      const id = typeof tag.name === "string" && tag.name ? tag.name : typeof tag.model === "string" ? tag.model : "";
      if (!id || seen.has(id) || isEmbedding(tag, id)) continue;
      seen.add(id);
      const size = typeof tag.details?.parameter_size === "string" ? tag.details.parameter_size : null;
      const pulled = typeof tag.modified_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(tag.modified_at)
        ? tag.modified_at.slice(0, 10)
        : null;
      out.push({
        id,
        name: size ? `${id} (${size})` : id,
        provider: "ollama",
        wire: "openai-chat",
        baseURL: `${root}/v1`,
        contextWindow: null,
        maxOutput: null,
        toolCall: true,
        reasoning: false,
        free: true,
        cost: { input: 0, output: 0 },
        status: null,
        releaseDate: pulled,
      });
    }
    return out;
  } catch {
    return [];
  }
}
