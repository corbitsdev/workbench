// The library entry for `@workbench/hub-client`: the hub's native HTTP
// API as a typed client, plus tenant seeding. Both the CLI's own `seed`
// verb and the first-login provisioning hook consume this so the
// tenant-seeding logic is implemented once.

export type { ApiCall, ApiResult, Session } from "./hub";
export { authenticate, createHubAPI, parseAs } from "./hub";
export { CliError, isCliError } from "./errors";
export type {
  DefaultWorkflow,
  ModelSource,
  PushOutcome,
  SeedCatalogArgs,
  SeedTenant,
  SeedTenantArgs,
  WorkflowPusher,
} from "./seed";
export {
  DEFAULT_WORKFLOWS,
  PLACEHOLDER_CATALOG_API_KEY,
  seedCatalog,
  seedTenant,
} from "./seed";
export {
  catalogModel,
  catalogOffering,
  catalogProvider,
} from "./catalog-seed-data";
export { createGitWorkflowPusher } from "./workflow-push";
export { testAnthropicCredential } from "./credential-test";
export type {
  CredentialTestResult,
  TestAnthropicCredentialArgs,
} from "./credential-test";
