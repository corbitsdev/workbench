// The library entry for `@workbench/cli`. The CLI's own `index.ts`
// stays the executable; this file is what a consumer inside the
// workspace (the first-login provisioning hook, in particular) imports
// to reuse the same tenant-seeding logic the `workbench seed` verb
// runs, instead of duplicating it.

export type { ApiCall, ApiResult, Session } from "./hub";
export { authenticate, createHubAPI, parseAs } from "./hub";
export { CliError, isCliError } from "./errors";
export type { ModelSource, SeedConfig, SetupConfig } from "./config";
export {
  MODEL_CREDENTIAL_VARIABLES,
  readSeedConfig,
  readSetupConfig,
} from "./config";
export type {
  DefaultWorkflow,
  PushOutcome,
  SeedDeps,
  SeedTenant,
  SeedTenantArgs,
  WorkflowPusher,
} from "./seed";
export { DEFAULT_WORKFLOWS, runSeed, seedTenant } from "./seed";
export { createGitWorkflowPusher } from "./workflow-push";
