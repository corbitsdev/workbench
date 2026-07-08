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

/** `GET /owner/setup` — the workbench's underlying provisioned configuration
 * (read-only, CL-2880): tenant identity, hierarchy position, and the workflow
 * kinds currently deployed (runnable) in it. Parsed at the web boundary. */
export const OwnerSetupResponse = type({
  tenantId: "string",
  tenantName: "string",
  tenantSlug: "string",
  parentTenantId: "string | null",
  deployedWorkflowKinds: "string[]",
});
export type OwnerSetup = typeof OwnerSetupResponse.infer;

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
