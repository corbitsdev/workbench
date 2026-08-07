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
  SeedInferenceSourceArgs,
  SeedTenant,
  SeedTenantArgs,
  WorkflowPusher,
} from "./seed";
export { DEFAULT_WORKFLOWS, seedInferenceSource, seedTenant } from "./seed";
export { createGitWorkflowPusher } from "./workflow-push";
