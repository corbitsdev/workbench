// Per-model context-window and output-token defaults for locally served
// Ollama models, resolved the same way `capabilitiesForDeployment` resolves
// capabilities: from the deployment's identity, at the moment an offering
// is created.
//
// `@intx/inference`'s built-in OpenAI-shaped adapter defaults output tokens
// to `options.maxTokens ?? 4096` when a caller sets none, and Ollama's own
// openai-compatible endpoint silently defaults `options.num_ctx` (its real
// context window) to a small built-in size when nothing sets it either --
// truncating real conversations for every locally served chat agent, with
// no error to say so. `@corbits/ollama-adapter`'s `OllamaAdapterConfig` is
// where that override actually lands on the built request body (see its
// `resolveOverride` and `createOllamaAdapter`); this module supplies the
// real per-model values it should carry, stored as a `model_offering`'s
// `quirks` column so it reaches `InferenceSource.quirks` -- and from there
// the adapter -- through the platform's existing resolution, no parallel
// override path of its own.
//
// Each table entry is the model's advertised *native* context window, not a
// YaRN/rope-extended ceiling: requesting a `num_ctx` past what a model (and
// the host's memory) can actually back can fail allocation or force heavy
// swap on the inference host, a real operational risk rather than a
// convention to enforce. A model absent from this table gets no override at
// all -- Ollama's own model-specific default stands, rather than this
// module guessing at a ceiling it cannot back up.
import type {
  OllamaAdapterConfig,
  OllamaAdapterOverride,
} from "@corbits/ollama-adapter";

export type OllamaModelDefaults = Readonly<
  Record<string, OllamaAdapterOverride>
>;

export const OLLAMA_MODEL_DEFAULTS: OllamaModelDefaults = {
  // OpenAI gpt-oss: 128K native context window.
  "gpt-oss:20b": { numCtx: 131_072, maxOutputTokens: 32_768 },
  // Qwen3's 27B/30B-class models: 32K native context window. Reaching 128K
  // on this family requires YaRN rope scaling, which this table does not
  // treat as "genuinely" supported per-model context.
  "qwen3.8:27b": { numCtx: 32_768, maxOutputTokens: 8192 },
  "qwen3.5:9b-mlx": { numCtx: 32_768, maxOutputTokens: 8192 },
  // Meta Llama 3.1: 128K native context window.
  "llama3.1:8b": { numCtx: 131_072, maxOutputTokens: 8192 },
};

export type OllamaDeploymentIdentity = {
  readonly providerName: string;
  readonly canonicalName: string;
};

/**
 * The `quirks` value to store on a newly created Ollama offering. Each
 * offering is already scoped to one exact model, so the resolved override
 * is wrapped in `default` -- the field `resolveOverride` applies whenever
 * no `perModel` entry is present -- rather than `perModel`, which exists
 * for a single shared connection serving several models through one quirks
 * bag.
 *
 * `overrides` lets a caller's own probed or operator-configured ceilings
 * win over this table (the "maximum flexibility, sane by default" seam);
 * unset resolves to this module's built-in table alone.
 *
 * Returns `undefined` for any provider other than `ollama` (this
 * mechanism's whole scope -- other providers' built-in adapters handle
 * their own request shape unmodified) and for any model neither `overrides`
 * nor the built-in table names, so an unvetted model is left exactly as
 * the built-in adapter already handles it rather than getting a guessed
 * ceiling.
 */
export function quirksForDeployment(
  deployment: OllamaDeploymentIdentity,
  overrides: OllamaModelDefaults = {},
): OllamaAdapterConfig | undefined {
  if (deployment.providerName !== "ollama") return undefined;
  const resolved =
    overrides[deployment.canonicalName] ??
    OLLAMA_MODEL_DEFAULTS[deployment.canonicalName];
  if (resolved === undefined) return undefined;
  return { default: resolved };
}
