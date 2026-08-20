// A catalog offering minted from a live Ollama connect carries no
// capability metadata at all — the `/api/tags` probe that seeds it
// (`fetchOllamaModelCatalog` in `credential-test.ts`) returns bare model
// names, so every pulled model (chat and embedding alike) becomes an
// offering tied at the same priority. Default-model resolution
// (`@workbench/inference-settings`'s `defaultModelForProvider`,
// `@corbits/chat`'s `listDefaultInferencePreferences`) then breaks ties
// alphabetically, so an embedding model whose name sorts first (e.g.
// "all-minilm") wins the tenant default and every chat turn fails with
// "does not support generate" (CL-6351).
//
// Until offerings carry a real capability tag, this recognizes the
// common embedding-model name families by convention and lets
// resolution route around them.
const EMBEDDING_MODEL_NAME_PATTERN =
  /(^|[-_/])(embed(ding)?|minilm|bge|gte|e5|arctic-embed)(-|_|:|$)/i;

export function isEmbeddingModelName(canonicalName: string): boolean {
  return EMBEDDING_MODEL_NAME_PATTERN.test(canonicalName);
}

/**
 * Narrows `offerings` to the ones {@link isEmbeddingModelName} does not
 * recognize as embedding-only. Falls back to the unfiltered list when
 * every offering would be excluded, so a tenant whose only reachable
 * model really is an embedding model still gets *a* default rather than
 * none — every other case leaves the filter doing real work.
 */
export function preferCompletionCapable<T>(
  offerings: readonly T[],
  canonicalNameOf: (offering: T) => string,
): readonly T[] {
  const completionCapable = offerings.filter(
    (offering) => !isEmbeddingModelName(canonicalNameOf(offering)),
  );
  return completionCapable.length > 0 ? completionCapable : offerings;
}
