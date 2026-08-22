import type { ModelInfo } from "@intx/types";

/**
 * Whether this tenant can actually run inference right now — never
 * "does a `model_provider` row exist," since seeding mints that row
 * regardless of whether a credential was ever attached (CL-6568's root
 * cause). `models` is `getResolvedCatalog`'s read, the same one
 * `resolveModelSources` acts on at launch: a model only carries an
 * offering here once its provider has a credential and passes policy, so
 * "some model has an offering" and "a launch could actually resolve a
 * source" are the same fact.
 */
export function hasUsableModel(models: readonly ModelInfo[]): boolean {
  return models.some((model) => model.offerings.length > 0);
}
