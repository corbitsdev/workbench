// The library entry for `@workbench/hub-client`: the hub's native HTTP
// API as a typed client, plus tenant seeding. Both the CLI's own `seed`
// verb and the first-login provisioning hook consume this so the
// tenant-seeding logic is implemented once.

export type { ApiCall, ApiResult, Session } from "./hub";
export { authenticate, createHubAPI, parseAs } from "./hub";
export { CliError, isCliError } from "./errors";
export type {
  DefaultWorkflow,
  EnsureCredentialArgs,
  EnsureProviderArgs,
  ModelSource,
  PushOutcome,
  SeedCatalogArgs,
  SeedTenant,
  SeedTenantArgs,
  ToolRegistryPublisher,
  WorkflowPusher,
} from "./seed";
export {
  CATALOG_TEST_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  inferenceCredentialName,
  PLACEHOLDER_CATALOG_API_KEY,
  ensureCredential,
  ensureProvider,
  seedCatalog,
  seedTenant,
  isLiveDeploymentStatus,
} from "./seed";
export {
  CATALOG_SEEDS,
  deriveChannelHostInferencePreferences,
} from "./catalog-seed-data";
export type {
  CatalogModelSpec,
  CatalogProviderSeed,
  CatalogProviderSpec,
  ChannelHostInferencePreference,
} from "./catalog-seed-data";
export { createGitWorkflowPusher } from "./workflow-push";
export {
  providerModelSource,
  supportedCredentialProviders,
  testProviderCredential,
} from "./credential-test";
export type {
  AdapterPluginId,
  CredentialTestResult,
  ProviderModelSource,
  ProviderTestConfig,
  SupportedCredentialProvider,
  TestProviderCredentialArgs,
} from "./credential-test";
