import { CATALOG_MODELS } from "./models";

/**
 * Conservative default context window (tokens) for a model id the static
 * catalog does not know about. Chosen as a safe floor below every model
 * currently listed in {@link CATALOG_MODELS} so a caller dividing budget by
 * this window under-allocates rather than over-allocates for an unknown
 * model.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

const contextWindowByModel = new Map(
  CATALOG_MODELS.map((model) => [model.canonicalName, model.contextWindow]),
);

/**
 * Resolves a model id (the provider-facing id as it appears in interchange's
 * `LastCycleSource.model`, matching `canonicalName` in {@link CATALOG_MODELS})
 * to its context window in tokens. Falls back to {@link DEFAULT_CONTEXT_WINDOW}
 * for an id the static catalog does not carry, so callers never divide by
 * `undefined`.
 */
export function contextWindowForModel(modelId: string): number {
  return contextWindowByModel.get(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}
