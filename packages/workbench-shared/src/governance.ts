import { type } from "arktype";

// ─── Governance vocabulary ─────────────────────────────────────────
//
// The workbench Admin area is gated on Interchange's NATIVE grant model — there
// is no custom permission system. "Admin" is not a magic string: the `admin`
// system role bears `resource="*"` grants for actions `read`/`create`/`manage`,
// and the `owner` role bears `*`/`*`. So an admin gate is a native `authorize`
// against a broad resource with the `manage` action — only owner (`*:*`) and
// admin (`*:manage`) satisfy it; a plain member (no role grants) is denied.
//
// This module is the single source of truth for that vocabulary (the AGENTS
// rule: product rules live in packages, not apps) and the wire schemas shared
// by the hub routes (emit + OpenAPI) and the web boundary parsers (validate).

/** Resource probed by the admin gate. The `*` wildcard on owner/admin roles
 * matches it; nothing a plain member holds does. Any resource string works
 * here (the wildcard is what grants access) — a dedicated `admin:*` string
 * keeps the intent legible in logs and the evaluate debugger. */
export const ADMIN_RESOURCE = "admin:*";
/** Action probed by the admin gate. `manage` is held by owner (`*:*`) and
 * admin (`*`/`manage`) but not member — so it cleanly separates admins. */
export const ADMIN_ACTION = "manage";

/** The Interchange system role that, when assigned, elevates a principal to
 * admin. Its `*`/{read,create,manage} grants make admin a superset of every
 * lesser capability (activity read, grant/role manage, workflow deploy) via
 * wildcard match — "admins inherit other grants" with no per-grant copying. */
export const ADMIN_ROLE_NAME = "admin";

/** The Interchange system role every tenant seeds as its baseline. It carries no
 * grants by default; the owner area expresses per-tenant workflow-run policy as
 * grants on this role (see the workflow run gate, CL-2885). */
export const MEMBER_ROLE_NAME = "member";

/** The actions the `admin` system role is seeded with (`*`/{read,create,manage},
 * see `seedSystemRolesAndGrants`). Exported so the seed AND the owner-gate probe
 * test consume ONE definition and cannot silently diverge — the owner gate's
 * correctness depends on the relationship between this set and `OWNER_ACTION`
 * (below). */
export const ADMIN_GRANT_ACTIONS = ["read", "create", "manage"] as const;

/** Resource probed by the OWNER gate. As with the admin gate, any string works
 * (the owner role's wildcard is what grants access); a dedicated `owner:*`
 * keeps the intent legible in logs and the evaluate debugger. */
export const OWNER_RESOURCE = "owner:*";
/** Action probed by the OWNER gate — the crux of owner-vs-admin. `admin` bears
 * `*` for the specific actions in `ADMIN_GRANT_ACTIONS`, while `owner` bears
 * `*`/`*`. The gate is safe as long as NO non-owner principal holds an action
 * *pattern* that globs to `OWNER_ACTION` on a resource globbing to
 * `OWNER_RESOURCE`. The authz matcher globs on the grant (pattern) side, so this
 * is broader than "a literal outside `ADMIN_GRANT_ACTIONS`": an action pattern
 * like `o*` would also match. Today only the owner role's `*`/`*` does — the
 * seeded admin literals (`read`/`create`/`manage`) do not, and no operator path
 * mints a wildcard/`o*` action grant to a non-owner. `owner-grant-probe.test.ts`
 * pins this against the real authz engine using `ADMIN_GRANT_ACTIONS`; do NOT
 * add a wildcard or `o*`-shaped action to a non-owner grant without revisiting
 * it. */
export const OWNER_ACTION = "own";

// ─── Workflow run gate (CL-2885) ───────────────────────────────────

/** Action probed by the workflow-run gate, paired with a `workflow:<kind>`
 * resource. Mirrors the deploy gate's shape (`workflow:*`/`create`). */
export const WORKFLOW_RUN_ACTION = "run";

/** The resource string for running a specific workflow kind. The run gate is
 * allow-by-default (workflows already ran for everyone before the gate): a run
 * is blocked only by an explicit tenant-level `deny` on this resource/action,
 * which the owner area adds to disable a workflow.
 *
 * Constraints on the owner writer (CL-2877):
 * - Denies MUST be unconditional. The gate evaluates with no condition registry,
 *   so a deny carrying `conditions` is skipped by the matcher — i.e. a
 *   conditional deny fails OPEN (the run proceeds). Write plain denies.
 * - A `workflow:*` deny disables all kinds ONLY while no more-specific member
 *   allow exists — the matcher is specificity-first, so a `workflow:<kind>`
 *   allow (member role holds none today) would override a `workflow:*` deny for
 *   that kind. Prefer per-kind denies over relying on a wildcard-vs-allow race. */
export function workflowRunResource(kind: string): string {
  return `workflow:${kind}`;
}

// ─── Owner area wire schemas (CL-2874) ─────────────────────────────

/** `GET /owner/context` — owner identity + the root tenant the owner governs.
 * The `/owner` web shell parses the response through this schema (never casts). */
export const OwnerContextResponse = type({
  tenantId: "string",
  ownerPrincipalId: "string",
});
export type OwnerContext = typeof OwnerContextResponse.infer;

/** `GET /owner/workflows` — deployed workflow kinds with run-enablement state.
 * `enabled` is the effective run-gate state (CL-2885): false when the org member
 * role holds a `deny` for that kind. The owner toggle writes/removes that deny. */
export const OwnerWorkflowState = type({ kind: "string", enabled: "boolean" });
export type OwnerWorkflowState = typeof OwnerWorkflowState.infer;

export const OwnerWorkflowsResponse = type({
  workflows: OwnerWorkflowState.array(),
});
export type OwnerWorkflows = typeof OwnerWorkflowsResponse.infer;

/** Body for the owner workflow toggle: the desired enablement state. */
export const OwnerWorkflowToggle = type({ enabled: "boolean" });
export type OwnerWorkflowToggle = typeof OwnerWorkflowToggle.infer;

/** Runnable workflow kind surfaced in the member catalog and Myra list tool. */
export const RunnableWorkflowKindSchema = type({
  kind: "string",
  "label?": "string",
  "description?": "string",
});
export type RunnableWorkflowKind = typeof RunnableWorkflowKindSchema.infer;

export const RunnableWorkflowKindsResponse = type({
  kinds: RunnableWorkflowKindSchema.array(),
});
export type RunnableWorkflowKindsResponse =
  typeof RunnableWorkflowKindsResponse.infer;

/** Interchange's seeded system roles (see `seedSystemRolesAndGrants`). */
export const SYSTEM_ROLE_NAMES = ["owner", "admin", "member"] as const;

// NOTE (CL-2799): individual capability-SHARING (grant `activity:principal`/
// `read` etc. to a principal without full admin) was intentionally NOT shipped
// here. Every `/admin/*` route currently gates on full admin (`admin:*`/
// `manage`), so a per-capability grant would gate nothing in-product — a button
// that does not do what its label says. Real per-capability enforcement (and
// the sharing UI + audit retention that go with it) is deferred to CL-2799. The
// enforced management surface today is role assignment: elevate/demote admin.

// ─── Pagination (CL-2807) ──────────────────────────────────────────
//
// Every Admin list is server-side paginated: raw ephemeral/per-run data was
// unusable at volume (dozens-to-hundreds of rows dumped with no way to narrow
// them). `PageInfoSchema` is the uniform envelope every paginated admin list
// response carries alongside its rows.

export const PageInfoSchema = type({
  page: "number",
  limit: "number",
  total: "number",
  totalPages: "number",
});
export type PageInfo = typeof PageInfoSchema.infer;

/** Compute the `PageInfoSchema` envelope for a page of `total` rows. */
export function buildPageInfo(
  page: number,
  limit: number,
  total: number,
): PageInfo {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

// ─── Shared wire schemas ───────────────────────────────────────────

/** One principal in the admin roster (humans + agent-instance synthetics). */
export const PrincipalSummarySchema = type({
  id: "string",
  kind: "'user' | 'agent'",
  refId: "string",
  status: "string",
  displayName: "string",
  roles: type({ id: "string", name: "string" }).array(),
  isAdmin: "boolean",
});
export type PrincipalSummary = typeof PrincipalSummarySchema.infer;

export const PrincipalListResponse = type({
  principals: PrincipalSummarySchema.array(),
  pageInfo: PageInfoSchema,
});
export type PrincipalListResponse = typeof PrincipalListResponse.infer;

export const PrincipalDetailResponse = type({
  principal: PrincipalSummarySchema,
});
export type PrincipalDetailResponse = typeof PrincipalDetailResponse.infer;

/** A single resolved grant (direct or role-expanded) from `collectGrants`. */
export const ResolvedGrantSchema = type({
  id: "string",
  resource: "string",
  action: "string",
  effect: "'allow' | 'deny' | 'ask'",
  origin: "string",
  roleId: "string | null",
  roleName: "string | null",
  principalId: "string | null",
  expiresAt: "string | null",
});
export type ResolvedGrant = typeof ResolvedGrantSchema.infer;

export const RoleSummarySchema = type({
  id: "string",
  name: "string",
  description: "string | null",
  isSystem: "boolean",
});
export type RoleSummary = typeof RoleSummarySchema.infer;

/** The resolved-grants view for one principal: its role assignments plus every
 * grant `collectGrants` returns (union of direct + role grants). */
export const PrincipalGrantsResponse = type({
  principalId: "string",
  isAdmin: "boolean",
  roles: RoleSummarySchema.array(),
  grants: ResolvedGrantSchema.array(),
});
export type PrincipalGrantsResponse = typeof PrincipalGrantsResponse.infer;

export const RoleListResponse = type({ roles: RoleSummarySchema.array() });
export type RoleListResponse = typeof RoleListResponse.infer;

// Definition browsers (read-only).

export const WorkflowDefinitionSummarySchema = type({
  deploymentId: "string | null",
  kind: "string",
  tenantId: "string",
  status: "string",
  version: "string | null",
  sha: "string | null",
  label: "string | null",
  createdAt: "string",
});
export type WorkflowDefinitionSummary =
  typeof WorkflowDefinitionSummarySchema.infer;

export const AgentDefinitionSummarySchema = type({
  id: "string",
  name: "string",
  tenantId: "string",
  version: "string",
  status: "string",
  description: "string | null",
  createdAt: "string",
});
export type AgentDefinitionSummary = typeof AgentDefinitionSummarySchema.infer;

export const ToolDefinitionSummarySchema = type({
  name: "string",
  providerName: "string",
  description: "string",
  version: "string | null",
});
export type ToolDefinitionSummary = typeof ToolDefinitionSummarySchema.infer;

export const WorkflowDefinitionsResponse = type({
  definitions: WorkflowDefinitionSummarySchema.array(),
});
export const AgentDefinitionsResponse = type({
  definitions: AgentDefinitionSummarySchema.array(),
});
export const ToolDefinitionsResponse = type({
  definitions: ToolDefinitionSummarySchema.array(),
});

// ─── Combined definitions browser (CL-2807) ────────────────────────
//
// The Definitions tab surfaces the actual distinct workflow/agent/tool
// DEFINITIONS the workbench can run — never per-run ephemeral deploy-per-run
// artifacts (a workflow step, a per-run supervisor). A workflow definition row
// carries `deploymentCount`: how many live+superseded deployments exist for
// that (kind, tenant) — the raw per-run dump is grouped under its parent
// definition rather than listed as its own row.

export const definitionKinds = ["workflow", "agent", "tool"] as const;
export type DefinitionKind = (typeof definitionKinds)[number];

// The real status vocabulary a `DefinitionSummary.status` can take, by source:
//   workflow — the `workflow_run` deployment index (`running` on deploy,
//     `superseded` on redeploy, `deleted` on delete)
//   agent    — Interchange's `agentVersionStatuses` (active/inactive/failed)
//   tool     — always `available` (a tool is not a versioned deployment)
// This is the source of truth the admin Definitions status filter enumerates —
// never a free-text guess.
export const definitionStatuses = [
  "running",
  "superseded",
  "deleted",
  "active",
  "inactive",
  "failed",
  "available",
] as const;
export type DefinitionStatus = (typeof definitionStatuses)[number];

export const DefinitionSummarySchema = type({
  kind: "'workflow' | 'agent' | 'tool'",
  key: "string",
  name: "string",
  version: "string | null",
  status: "string",
  description: "string | null",
  deploymentCount: "number",
  createdAt: "string | null",
});
export type DefinitionSummary = typeof DefinitionSummarySchema.infer;

export const DefinitionListResponse = type({
  definitions: DefinitionSummarySchema.array(),
  pageInfo: PageInfoSchema,
});
export type DefinitionListResponse = typeof DefinitionListResponse.infer;

/** One workflow definition's deployment history — the per-run/redeploy rows
 * grouped under it, newest first. Detail-page-only; the list view only needs
 * the count. */
export const WorkflowDeploymentHistoryEntrySchema = type({
  deploymentId: "string | null",
  status: "string",
  version: "string | null",
  sha: "string | null",
  label: "string | null",
  createdAt: "string",
});
export type WorkflowDeploymentHistoryEntry =
  typeof WorkflowDeploymentHistoryEntrySchema.infer;

export const DefinitionDetailResponse = type({
  definition: DefinitionSummarySchema,
  deployments: WorkflowDeploymentHistoryEntrySchema.array(),
});
export type DefinitionDetailResponse = typeof DefinitionDetailResponse.infer;

// ─── Audit (CL-2735) ───────────────────────────────────────────────
//
// Cross-principal activity reads and every grant/role mutation are recorded in
// a workbench-owned `admin_audit` table (NOT analytics_event — that pipeline is
// sidecar-only and hub-side one-shots are invisible there; compliance needs a
// hub-owned durable record). `activity_read` rows are the CL-2735 compliance
// surface: who read whose timeline.

export const adminAuditActions = [
  "activity_read",
  "grant_created",
  "grant_revoked",
  "role_assigned",
  "role_removed",
] as const;
export type AdminAuditAction = (typeof adminAuditActions)[number];

export const AuditRecordSchema = type({
  id: "string",
  action:
    "'activity_read' | 'grant_created' | 'grant_revoked' | 'role_assigned' | 'role_removed'",
  actorPrincipalId: "string",
  actorName: "string | null",
  targetPrincipalId: "string | null",
  targetName: "string | null",
  resource: "string | null",
  detail: "string | null",
  createdAt: "string",
});
export type AuditRecord = typeof AuditRecordSchema.infer;

export const AuditListResponse = type({
  records: AuditRecordSchema.array(),
  pageInfo: PageInfoSchema,
});
export type AuditListResponse = typeof AuditListResponse.infer;

// ─── Owner credentials (CL-2879, split by kind CL-2879/CL-2883) ────
//
// Owner-managed provider credentials are split across two tabs by what the
// provider is FOR: `kind: "inference"` providers (LLM sources an agent's
// `credentialRequirements` resolve against) surface in Catalog next to the
// model/provider browser; `kind: "tool"` providers (Granola, Exa, Firecrawl,
// Gamma, Linear, GitHub, Attio — resolved at tool-execution time via
// `resolveCredentialRequirement`, never via `credentialRequirements`) surface
// in Capabilities next to the other integrations. Secrets are WRITE-ONLY end
// to end: the owner types a key in, the hub stores it, and every read path
// (this schema) carries only masked metadata — never the secret itself. This
// is the single source of truth for which providers the two tabs manage; it
// mirrors `buildEntries()` in `apps/hub/bin/seed-credentials.ts` (the
// credential-seeding catalog) so the two never silently diverge on provider
// naming.
//
// `defaultMetadata` seeds a brand-new provider row's `metadata` (e.g. the
// well-known API base URL) so an owner-created credential resolves correctly
// on the first save; it is never applied to an existing provider row.
export interface CredentialProviderCatalogEntry {
  /** Matches `credentialRequirements[].providerName` / `credentialProviderNames`. */
  providerName: string;
  /** The Interchange provider `plugin` field. */
  providerPlugin: string;
  /** Human-readable label shown in the owning tab. */
  label: string;
  /** `inference` providers are wired into an agent's `credentialRequirements`
   * (LLM sources); `tool` providers are resolved at tool-execution time and
   * must never appear in `credentialRequirements` (see the apps/hub/AGENTS.md
   * "Agent credentials vs tool credentials" rule). Drives which owner tab
   * (Catalog vs Capabilities) renders the row. */
  kind: "inference" | "tool";
  /** Seeded onto a newly-created provider row only (never patches an existing one). */
  defaultMetadata?: Record<string, unknown>;
  /** Label for the secret input. Defaults to "API key"; override where the
   * secret is not an API key (e.g. Bluesky's app password). */
  secretLabel?: string;
  /** When set, the owner form shows a second text input alongside the secret
   * whose value is stored on the provider's `metadata.baseURL`. Used by
   * providers that need an endpoint (Bifrost) or an identity handle (Bluesky)
   * in addition to the secret. `required` blocks saving until it is filled —
   * true where the provider cannot resolve without it (Bluesky's handle, and
   * Bifrost's per-env base URL, which has no universal default). */
  secondaryField?: { label: string; placeholder: string; required?: boolean };
  /** Display names of the platforms a single credential powers, shown as a
   * sub-label in the owner row. One credential can back several platforms
   * (e.g. ScrapeCreators → Reddit, TikTok, …); the user-facing tool surface
   * still names the individual platform, not the provider. */
  platforms?: readonly string[];
}

/** Provider name for the default Bifrost /v1 (openai-compatible) surface.
 * Owner-prefixed so a customer workbench can shadow with its own
 * <customer>-bifrost* rows. Central constant so UI conditionals and tests do
 * not duplicate the string literal. */
export const BIFROST_PROVIDER_NAME = "corbits-default-bifrost" as const;

export const CREDENTIAL_PROVIDER_CATALOG: readonly CredentialProviderCatalogEntry[] =
  [
    {
      providerName: "openai-compatible",
      providerPlugin: "openai-compatible",
      label: "OpenAI-compatible LLM",
      kind: "inference",
      defaultMetadata: { baseURL: "https://api.openai.com/v1" },
    },
    {
      providerName: BIFROST_PROVIDER_NAME,
      providerPlugin: "openai-compatible",
      label: "Bifrost (/v1)",
      kind: "inference",
      secondaryField: {
        label: "Base URL",
        placeholder: "https://corbits-ai-gateway.up.railway.app/v1",
        required: true,
      },
    },
    {
      providerName: "corbits-default-bifrost-anthropic",
      providerPlugin: "anthropic",
      label: "Bifrost (/anthropic)",
      kind: "inference",
      secondaryField: {
        label: "Base URL",
        placeholder: "https://corbits-ai-gateway.up.railway.app/anthropic",
        required: true,
      },
    },
    {
      providerName: "corbits-default-bifrost-genai",
      providerPlugin: "google-genai",
      label: "Bifrost (/genai)",
      kind: "inference",
      secondaryField: {
        label: "Base URL",
        placeholder: "https://corbits-ai-gateway.up.railway.app/genai",
        required: true,
      },
    },
    {
      providerName: "anthropic",
      providerPlugin: "anthropic",
      label: "Anthropic",
      kind: "inference",
      defaultMetadata: { baseURL: "https://api.anthropic.com" },
    },
    {
      providerName: "xai",
      providerPlugin: "xai",
      label: "xAI",
      kind: "inference",
    },
    {
      providerName: "granola",
      providerPlugin: "granola",
      label: "Granola",
      kind: "tool",
      defaultMetadata: { baseURL: "https://public-api.granola.ai/v1" },
    },
    { providerName: "exa", providerPlugin: "exa", label: "Exa", kind: "tool" },
    {
      providerName: "firecrawl",
      providerPlugin: "firecrawl",
      label: "Firecrawl",
      kind: "tool",
      defaultMetadata: { baseURL: "https://api.firecrawl.dev/v2" },
    },
    {
      providerName: "gamma",
      providerPlugin: "gamma",
      label: "Gamma",
      kind: "tool",
    },
    {
      providerName: "linear",
      providerPlugin: "linear",
      label: "Linear",
      kind: "tool",
      defaultMetadata: { baseURL: "https://api.linear.app/graphql" },
    },
    {
      providerName: "github",
      providerPlugin: "github",
      label: "GitHub",
      kind: "tool",
    },
    {
      providerName: "attio",
      providerPlugin: "attio",
      label: "Attio",
      kind: "tool",
      defaultMetadata: { baseURL: "https://api.attio.com" },
    },
    {
      providerName: "vercel",
      providerPlugin: "vercel",
      label: "Vercel",
      kind: "tool",
      defaultMetadata: { baseURL: "https://api.vercel.com" },
    },
    {
      providerName: "youtube",
      providerPlugin: "youtube",
      label: "YouTube",
      kind: "tool",
    },
    {
      providerName: "scrapecreators",
      providerPlugin: "scrapecreators",
      label: "ScrapeCreators",
      kind: "tool",
      platforms: ["Reddit", "TikTok", "Instagram", "Threads", "Pinterest"],
    },
    {
      providerName: "bluesky",
      providerPlugin: "bluesky",
      label: "Bluesky",
      kind: "tool",
      secretLabel: "App password",
      secondaryField: {
        label: "Handle",
        placeholder: "you.bsky.social",
        required: true,
      },
    },
  ] as const;

/** One provider row in the Catalog/Capabilities credentials sections —
 * configured/missing state only. NEVER carries the secret; `configured` and
 * `updatedAt` are the only signals of whether/when a key was set.
 *
 * For inference gateways (e.g. bifrost) the current baseURL (if any) is
 * included so the owner form can pre-fill it when replacing the key. */
export const OwnerCredentialStateSchema = type({
  providerName: "string",
  label: "string",
  kind: "'inference' | 'tool'",
  configured: "boolean",
  updatedAt: "string | null",
  "baseURL?": "string",
});
export type OwnerCredentialState = typeof OwnerCredentialStateSchema.infer;

export const OwnerCredentialsResponse = type({
  credentials: OwnerCredentialStateSchema.array(),
});
export type OwnerCredentialsResponse = typeof OwnerCredentialsResponse.infer;

/** Body for setting/replacing a provider's key. Write-only: this shape is
 * never echoed back by any response.
 *
 * For openai-compatible gateways like Bifrost, owners can also supply a baseURL
 * so they can self-configure the endpoint without admin intervention. */
export const OwnerCredentialSetBody = type({
  secret: "string > 0",
  "baseURL?": "string",
});
export type OwnerCredentialSetBody = typeof OwnerCredentialSetBody.infer;
