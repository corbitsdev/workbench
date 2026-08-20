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
// `@corbits/inference-catalog`'s `capabilitiesForDeployment` now backs every
// offering created from the pinned catalog with its real, wire-observed
// capabilities, and the pinned catalog only ever lists completion models —
// an embedding deployment never earns `"plain-text"` there. This module
// reads that data instead of guessing from the name.
//
// Coverage is partial: a deployment the pinned catalog has never probed
// (a local Ollama pull, an unlisted relay) carries no capability data at
// all, `"plain-text"` included. Filtering those out unconditionally would
// brick every tenant on such a provider, so `preferCompletionCapable` only
// ever narrows the candidate set — never empties it.
// `ModelOfferingRow.capabilities` (the DB row `ResolvedOffering.offering`
// carries) is a plain `text[]` column, looser than the `Capability` enum
// `@intx/types` guards the offerings API with — so this reads capabilities
// as bare strings rather than importing `Capability` and forcing every
// caller to narrow first.
function isCompletionCapable(capabilities: readonly string[]): boolean {
  return capabilities.includes("plain-text");
}

/**
 * Narrows `offerings` to the ones whose capability data marks them
 * completion-capable (`"plain-text"`). Falls back to the unfiltered list
 * when that would exclude every candidate — either because none of them
 * carry capability data yet, or because none of the ones that do are
 * tagged completion-capable — so a tenant whose provider lacks capability
 * rows still gets *a* default rather than none.
 */
export function preferCompletionCapable<T>(
  offerings: readonly T[],
  capabilitiesOf: (offering: T) => readonly string[],
): readonly T[] {
  const completionCapable = offerings.filter((offering) =>
    isCompletionCapable(capabilitiesOf(offering)),
  );
  return completionCapable.length > 0 ? completionCapable : offerings;
}
