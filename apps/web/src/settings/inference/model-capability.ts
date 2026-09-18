// Pure, presentation-only inference-catalog helpers the Inference section
// needs and no stock route provides: a provider slug's display name, and
// which offerings are safe to show in a person-facing chat picker.

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "google-genai": "Google",
  xai: "xAI",
  "xai-oauth": "xAI (Grok OAuth)",
  codex: "Codex",
  openrouter: "OpenRouter",
  "opencode-zen": "Opencode Zen",
  groq: "Groq",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  huggingface: "Hugging Face",
  ollama: "Ollama (local)",
};

/**
 * The provider's own display name (e.g. "Ollama (local)", "Opencode Zen")
 * for a catalog row's `providerName`, which is the internal slug the
 * catalog stores it under (e.g. `"ollama"`, `"opencode-zen"`) — never a
 * name a person should read as-is. Falls back to the raw slug for a
 * provider this map doesn't know about (a custom bring-your-own-key
 * provider a workbench minted under a name of its own choosing), so an
 * unrecognized provider still renders something rather than nothing.
 */
export function providerDisplayName(providerName: string): string {
  return PROVIDER_DISPLAY_NAMES[providerName] ?? providerName;
}

// A catalog offering minted from a live Ollama connect carries no
// capability metadata at all, so every pulled model (chat and embedding
// alike) becomes an offering tied at the same priority. This name-based
// fallback recognizes common embedding-model name families by convention
// whenever real, wire-observed capability data is unavailable.
const EMBEDDING_MODEL_NAME_PATTERN =
  /(^|[-_/])embed(ding)?|(^|[-_/])(minilm|bge|gte|e5|arctic-embed)(-|_|:|$)/i;

const HUGGING_FACE_OR_GGUF_NAME_PATTERN = /(^|\/)(hf\.co|huggingface\.co)\//i;

function isEmbeddingModelName(canonicalName: string): boolean {
  return EMBEDDING_MODEL_NAME_PATTERN.test(canonicalName);
}

/** Ollama's Hugging Face Hub pull form (`hf.co/org/repo[:quant]`) or a
 * bare `.gguf` path/tag — never offered in a person-facing chat picker. */
export function isGgufOrHuggingFacePath(canonicalName: string): boolean {
  const lower = canonicalName.toLowerCase();
  return lower.includes(".gguf") || HUGGING_FACE_OR_GGUF_NAME_PATTERN.test(canonicalName);
}

/**
 * Name-only chat-picker gate for catalog rows that carry no offering
 * capability data. Drops embedding-named models, GGUF paths, and Hugging
 * Face URIs. Prefer {@link preferCompletionCapable} when real capability
 * lists are available.
 */
export function isChatPickerModelName(canonicalName: string): boolean {
  return !isGgufOrHuggingFacePath(canonicalName) && !isEmbeddingModelName(canonicalName);
}

function isCompletionCapable(capabilities: readonly string[], canonicalName: string): boolean {
  if (isGgufOrHuggingFacePath(canonicalName)) return false;
  return capabilities.length > 0
    ? capabilities.includes("plain-text")
    : !isEmbeddingModelName(canonicalName);
}

/**
 * Narrows `offerings` to the completion-capable ones: whichever of
 * `capabilitiesOf`'s real, wire-observed data or (when that's empty,
 * uncataloged) `isEmbeddingModelName`'s name check says so. Also drops
 * Hugging Face / GGUF path names. Returns an empty list when every
 * offering is excluded — an embedding model must never win default-model
 * resolution by default.
 */
export function preferCompletionCapable<T>(
  offerings: readonly T[],
  capabilitiesOf: (offering: T) => readonly string[],
  canonicalNameOf: (offering: T) => string,
): readonly T[] {
  return offerings.filter((offering) =>
    isCompletionCapable(capabilitiesOf(offering), canonicalNameOf(offering)),
  );
}
