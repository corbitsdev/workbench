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

/** Interchange's seeded system roles (see `seedSystemRolesAndGrants`). */
export const SYSTEM_ROLE_NAMES = ["owner", "admin", "member"] as const;

// NOTE (CL-2799): individual capability-SHARING (grant `activity:principal`/
// `read` etc. to a principal without full admin) was intentionally NOT shipped
// here. Every `/admin/*` route currently gates on full admin (`admin:*`/
// `manage`), so a per-capability grant would gate nothing in-product — a button
// that does not do what its label says. Real per-capability enforcement (and
// the sharing UI + audit retention that go with it) is deferred to CL-2799. The
// enforced management surface today is role assignment: elevate/demote admin.

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
});
export type PrincipalListResponse = typeof PrincipalListResponse.infer;

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

export const AuditListResponse = type({ records: AuditRecordSchema.array() });
export type AuditListResponse = typeof AuditListResponse.infer;
