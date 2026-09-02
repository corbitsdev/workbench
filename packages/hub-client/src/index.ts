// The library entry for `@workbench/hub-client`: the hub's native HTTP
// API as a typed client, plus tenant seeding. Both the CLI's own `seed`
// verb and the first-login provisioning hook consume this so the
// tenant-seeding logic is implemented once.

export type { ApiCall, ApiResult, Session } from "./hub";
export { authenticate, createHubAPI, parseAs, signIn } from "./hub";
export {
  CliError,
  isCliError,
  isSidecarUnavailableError,
  SidecarUnavailableError,
} from "./errors";
export { cookiesFromHeader } from "./cookies";
export type {
  DefaultWorkflow,
  EnsureCredentialArgs,
  EnsureProviderArgs,
  ModelSource,
  PushOutcome,
  SeedCatalogArgs,
  SeedCatalogResult,
  SeedTenant,
  SeedTenantArgs,
  ToolRegistryPublisher,
  WorkflowPusher,
} from "./seed";
export {
  CATALOG_TEST_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  SEED_GRANTS,
  inferenceCredentialName,
  PLACEHOLDER_CATALOG_API_KEY,
  ensureCredential,
  ensureProvider,
  reconcileSeedGrants,
  seedCatalog,
  seedTenant,
  isLiveDeploymentStatus,
  SETUP_AGENT_ASSET_NAME,
} from "./seed";
export {
  publishCorbitsToolsRegistry,
  type PublishCorbitsToolsRegistryArgs,
  type PublishSummary,
} from "@corbits/tool-registry-publish";
export {
  CATALOG_SEEDS,
  deriveWorkbenchHostInferencePreferences,
} from "./catalog-seed-data";
export type {
  CatalogModelSpec,
  CatalogProviderSeed,
  CatalogProviderSpec,
  WorkbenchHostInferencePreference,
} from "./catalog-seed-data";
export { createGitWorkflowPusher } from "./workflow-push";
export { ensureDefaultRoutines } from "./default-routines";
export {
  fetchOllamaModelCatalog,
  ollamaApiRoot,
  ollamaOpenAICompatBaseURL,
  OLLAMA_PLACEHOLDER_SECRET,
  PROVIDER_TEST_CONFIG,
  providerModelSource,
  supportedCredentialProviders,
  testProviderCredential,
} from "./credential-test";
export type {
  AdapterPluginId,
  CredentialTestResult,
  OllamaCatalogModel,
  ProviderModelSource,
  ProviderTestConfig,
  SupportedCredentialProvider,
  TestProviderCredentialArgs,
} from "./credential-test";
