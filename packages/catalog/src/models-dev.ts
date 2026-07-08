import { CATALOG_PROVIDERS } from "./providers";

const providerByName = new Map(
  CATALOG_PROVIDERS.map((provider) => [provider.name, provider]),
);

/**
 * Resolves a tenant catalog provider name to models.dev provider id(s) for
 * qualified pricing keys (`{id}/{modelId}`).
 */
export function modelsDevProviderIdsForCatalogProvider(
  catalogProviderName: string,
): string[] {
  const spec = providerByName.get(catalogProviderName);
  if (spec?.modelsDevProviderId !== undefined) {
    return [spec.modelsDevProviderId];
  }
  return [];
}
