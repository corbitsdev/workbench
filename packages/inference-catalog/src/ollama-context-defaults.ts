// Per-model context-window and output-token defaults for locally served
// Ollama models, needed because neither the OpenAI-shaped adapter nor
// Ollama's own endpoint errors when truncating a real conversation to a
// small built-in default. See docs/ollama-context-defaults.md.
import type { OllamaAdapterConfig, OllamaAdapterOverride } from "@corbits/ollama-adapter";

export type OllamaModelDefaults = Readonly<Record<string, OllamaAdapterOverride>>;

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

/** The `quirks` value to store on a newly created Ollama offering; undefined
 * for a non-Ollama provider or an unvetted model. See
 * docs/ollama-context-defaults.md#default-vs-permodel. */
export function quirksForDeployment(
  deployment: OllamaDeploymentIdentity,
  overrides: OllamaModelDefaults = {},
): OllamaAdapterConfig | undefined {
  if (deployment.providerName !== "ollama") return undefined;
  const resolved =
    overrides[deployment.canonicalName] ?? OLLAMA_MODEL_DEFAULTS[deployment.canonicalName];
  if (resolved === undefined) return undefined;
  return { default: resolved };
}
