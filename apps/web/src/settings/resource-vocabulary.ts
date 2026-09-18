// No hub route exposes this list, so it's carried here as a typed literal
// until a capability-vocabulary endpoint exists to delete this in favor of.

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

// Every consumer of a raw resource slug reads from this one map so the
// copy never drifts between them.
export const GRANT_RESOURCE_LABEL: Record<GrantResource, string> = {
  principal: "accounts on this workbench",
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

export const GRANT_ACTIONS = ["read", "create", "manage", "write", "use"] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];
