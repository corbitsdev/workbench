// The grant resource/action vocabulary: no hub route exposes this list (see
// the tenancy inventory's gap list, item 8), so the Grants section carries
// it here as a typed literal, sourced from
// `vendor/intx/hub-api/src/routes/grants.ts`'s own resource set. If the hub
// ever grows a capability-vocabulary endpoint, this constant is the one
// place to delete in favor of it.

export const GRANT_RESOURCES = [
  "principal",
  "role",
  "grant",
  "wallet",
  "provider",
  "credential",
  "oauth_client",
  "offering",
  "model",
  "model-provider",
  "model-offering",
  "model-pricing",
  "asset",
  "git-token",
  "workflow",
  "workflow-run",
  "workflow-definition",
  "approval",
  "agent-data",
  "observability",
] as const;
export type GrantResource = (typeof GRANT_RESOURCES)[number];

export const GRANT_ACTIONS = [
  "read",
  "create",
  "manage",
  "write",
  "use",
] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];
