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

/**
 * Plain-language labels for `GRANT_RESOURCES`, written to read in a
 * sentence ("Billing may read on {label}.") and in a table cell. Every
 * consumer of a raw resource slug — the create-grant preview sentence,
 * the grants table, the resource filter, the resource picker — reads
 * from this one map so the copy never drifts between them. The raw slug
 * still survives as a title/tooltip; it is never the visible text.
 */
export const GRANT_RESOURCE_LABEL: Record<GrantResource, string> = {
  principal: "accounts on this bench",
  role: "roles",
  grant: "grants",
  wallet: "wallets",
  provider: "providers",
  credential: "credentials",
  oauth_client: "app connections",
  offering: "offerings",
  model: "models",
  "model-provider": "model providers",
  "model-offering": "model offerings",
  "model-pricing": "model pricing",
  asset: "assets",
  "git-token": "repository access",
  workflow: "workflows",
  "workflow-run": "workflow runs",
  "workflow-definition": "agent workflows",
  approval: "approvals",
  "agent-data": "agent data",
  observability: "observability data",
};

export const GRANT_ACTIONS = [
  "read",
  "create",
  "manage",
  "write",
  "use",
] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];
