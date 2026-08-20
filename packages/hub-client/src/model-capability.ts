// A catalog offering minted from a live Ollama connect carries no
// capability metadata at all — the `/api/tags` probe that seeds it
// (`fetchOllamaModelCatalog` in `credential-test.ts`) returns bare model
// names, so every pulled model (chat and embedding alike) becomes an
// offering tied at the same priority. Default-model resolution
// (`@workbench/inference-settings`'s `defaultModelForProvider`,
// `@corbits/chat`'s `selectDefaultInferencePreferences`) then breaks ties
// alphabetically, so an embedding model whose name sorts first (e.g.
// "all-minilm") wins the tenant default and every chat turn fails with
// "does not support generate" (CL-6351).
//
// `@corbits/inference-catalog`'s `capabilitiesForDeployment` backs every
// offering created from the pinned catalog with its real, wire-observed
// capabilities, and the pinned catalog only ever lists completion models —
// an embedding deployment never earns `"plain-text"` there. This module
// prefers that data when it exists.
//
// Coverage is partial: a deployment the pinned catalog has never probed
// (a local Ollama pull, in particular — never in a pinned, publicly
// reachable catalog) carries no capability data at all, `"plain-text"`
// included, indistinguishable at this layer from a real probed embedding
// deployment (both report an empty capability list). For that uncataloged
// case this falls back to recognizing common embedding-model name
// families by convention — the same signal CL-6351's first pass used
// before the pinned catalog existed — rather than trusting an empty list
// as "no data" and letting an embedding model win anyway.
const EMBEDDING_MODEL_NAME_PATTERN =
  /(^|[-_/])(embed(ding)?|minilm|bge|gte|e5|arctic-embed)(-|_|:|$)/i;

function isEmbeddingModelName(canonicalName: string): boolean {
  return EMBEDDING_MODEL_NAME_PATTERN.test(canonicalName);
}

function isCompletionCapable(
  capabilities: readonly string[],
  canonicalName: string,
): boolean {
  return capabilities.length > 0
    ? capabilities.includes("plain-text")
    : !isEmbeddingModelName(canonicalName);
}

/**
 * Narrows `offerings` to the completion-capable ones: whichever of
 * `capabilitiesOf`'s real, wire-observed data or (when that's empty,
 * uncataloged) `isEmbeddingModelName`'s name check says so. Returns an
 * empty list when every offering is excluded — CL-6351 requires an
 * embedding model never win default-model resolution by default, so
 * there is no "fall back to picking one anyway" case here; a caller with
 * nothing completion-capable to choose from must surface that as its own
 * state (see `hasCompletionCapableModel`), not silently hand back an
 * offering that will fail every chat turn.
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

/** Whether at least one of `offerings` is completion-capable by
 * {@link preferCompletionCapable}'s own rule — the connect-time check
 * behind CL-6351's guided state ("Ollama is connected, but no chat model
 * is installed"). */
export function hasCompletionCapableModel<T>(
  offerings: readonly T[],
  capabilitiesOf: (offering: T) => readonly string[],
  canonicalNameOf: (offering: T) => string,
): boolean {
  return offerings.some((offering) =>
    isCompletionCapable(capabilitiesOf(offering), canonicalNameOf(offering)),
  );
}
