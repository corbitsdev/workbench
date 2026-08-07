// Declarative dev catalog seed data — pure data, no HTTP. Mirrors
// Interchange's own bin/lib/catalog-seed-data.ts idiom: a plain data
// module `seedCatalog` (see seed.ts) drives through the catalog HTTP
// API, kept importable on its own so nothing here ever grows a network
// dependency.
//
// The workbench dev catalog is intentionally small: one provider
// (anthropic), one model (claude-sonnet-5), and the offering linking
// them — enough for the default workflow set and every chat channel
// host to resolve an inference source once a credential exists.

export type CatalogModelSpec = {
  readonly canonicalName: string;
  readonly displayName: string;
};

export type CatalogProviderSpec = {
  readonly name: string;
  readonly plugin: string;
  readonly baseURL: string;
};

export type CatalogOfferingSpec = {
  // References CatalogModelSpec.canonicalName.
  readonly model: string;
  // References CatalogProviderSpec.name.
  readonly provider: string;
};

export const catalogModel: CatalogModelSpec = {
  canonicalName: "claude-sonnet-5",
  displayName: "Claude Sonnet 5",
};

export const catalogProvider: CatalogProviderSpec = {
  name: "anthropic",
  plugin: "anthropic",
  baseURL: "https://api.anthropic.com",
};

export const catalogOffering: CatalogOfferingSpec = {
  model: catalogModel.canonicalName,
  provider: catalogProvider.name,
};
