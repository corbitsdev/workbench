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

/** The Interchange system role that carries the tenant-wide `*`/`*` wildcard
 * grant (see `OWNER_ACTION`). Assigning/removing this role IS how owner
 * authority is granted/revoked (CL-3634) — the same native
 * `principal_role`/`grant` mechanism `ADMIN_ROLE_NAME` uses, no bespoke
 * concept. */
export const OWNER_ROLE_NAME = "owner";

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

// ─── Capability gate (CL-3356 #1) ──────────────────────────────────
//
// Per-user OAuth-backed inbox capabilities (Linear, Attio, …) are governed by
// the SAME native grant model as the workflow-run gate (CL-2885): an
// allow-by-default `capability:<provider>`/`use` gate on the tenant's system
// `member` role. A capability is available unless the owner writes an explicit
// `deny` on it — which HIDES the capability from every member (the provider
// disappears from their Connections surface and neither user-OAuth nor the
// tenant key resolves for it). The per-user `inbox.capability.<provider>`
// preference is a second, independent layer BENEATH this ceiling: the grant is
// the governance ceiling (owner hides), the preference is the user's opt-in.

/** Action probed by the capability gate, paired with a `capability:<provider>`
 * resource. Mirrors the run gate's `run` verb. */
export const CAPABILITY_ACTION = "use";

/** The resource string gating one connectable provider's capability. Like the
 * run gate this is allow-by-default: available unless an explicit `member`-role
 * `deny` exists (which the owner area writes to hide the capability). Prefer a
 * per-provider deny over a `capability:*` wildcard for the same specificity
 * reasons documented on `workflowRunResource`. */
export function capabilityResource(provider: string): string {
  return `capability:${provider}`;
}

// ─── Owner-level inbox source enablement (CL-3577 / CL-3584) ───────
//
// Every inbox intake source — workspace-scope (a tenant-wide poller that runs
// once per tick for the whole tenant) AND member-scope (per-member pollers
// gated by the member's `inboxSource:*` preference) — is gated by an
// OWNER-level enablement. The owner grant is the tenant ceiling: a source the
// owner has not enabled is skipped for EVERY member regardless of their
// preference (CL-3584 cascade). Member preferences persist untouched while the
// owner keeps a source disabled, so re-enabling restores each member's prior
// choice. Modeled like the feature grants above: deny-by-default (absent any
// grant the source stays OFF), an `allow` on the tenant's system `member` role
// for `inbox-source:<key>`/`enable` turns it on for the tenant.

/** Action probed by the owner-level inbox source gate. */
export const WORKSPACE_INBOX_SOURCE_ACTION = "enable";

/** The resource string gating one inbox source (either scope), keyed by its
 * `InboxSourceRegistryEntry.key` / `INBOX_SOURCE_CATALOG` key. Deny-by-default:
 * enabled only by an explicit `member`-role allow (owner-written). */
export function workspaceInboxSourceResource(sourceKey: string): string {
  return `inbox-source:${sourceKey}`;
}

/** Owner-area read/toggle for one inbox source's tenant enablement. `enabled`
 * reflects the member-role `inbox-source:<key>`/`enable` grant. Mirrors
 * `OwnerFeatureStateSchema`; catalog copy (label/description) is supplied by the
 * route from `INBOX_SOURCE_CATALOG`. */
export const OwnerInboxSourceStateSchema = type({
  key: "string",
  label: "string",
  description: "string",
  enabled: "boolean",
});
export type OwnerInboxSourceState = typeof OwnerInboxSourceStateSchema.infer;

export const OwnerInboxSourcesResponse = type({
  sources: OwnerInboxSourceStateSchema.array(),
});
export type OwnerInboxSourcesResponse = typeof OwnerInboxSourcesResponse.infer;

export const OwnerInboxSourceToggle = type({
  enabled: "boolean",
});
export type OwnerInboxSourceToggle = typeof OwnerInboxSourceToggle.infer;

export const OwnerInboxSourceToggleResult = type({
  key: "string",
  enabled: "boolean",
});
export type OwnerInboxSourceToggleResult =
  typeof OwnerInboxSourceToggleResult.infer;

// ─── Connectable (per-user OAuth) providers (CL-3356 #2) ───────────
//
// The provider-agnostic OAuth flow engine is parameterized entirely by this
// catalog: authorize/token endpoints, requested scopes, and whether PKCE is
// used. This is pure, serializable domain data (endpoints + scopes) and belongs
// in the package; the per-tenant `client_id`/`client_secret`/redirect URI are
// operator secrets resolved from the hub env at flow time (never here). A
// provider is "connectable" (surfaces a per-user Connect button + capability
// gate) iff it appears here.

export const OAuthProviderConfigSchema = type({
  /** Matches the Interchange `provider.name` and the credential catalog's
   * `providerName`, so the token this flow mints resolves through the same
   * `resolveCredentialRequirement` path the tools already use. */
  providerName: "string",
  /** Human-readable label shown on the Connections + owner Capabilities rows. */
  label: "string",
  /** The provider's OAuth2 authorization endpoint (where the user is sent). */
  authorizationUrl: "string",
  /** The provider's OAuth2 token endpoint (code-for-token exchange). */
  tokenUrl: "string",
  /** Scopes requested at authorize time and matched on the stored credential.
   * Minimized per provider (see the design's security analysis). */
  scopes: "string[]",
  /** Plain-language label for each raw scope string, so the owner setup panel
   * renders "Read and edit your issues" rather than `record_permission:...`.
   * Every entry in `scopes` MUST have a description here (asserted by test). */
  scopeDescriptions: {
    "[string]": "string",
  },
  /** Whether to drive the flow with PKCE (code_verifier/code_challenge). Every
   * v1 provider uses it; kept explicit so a provider that cannot is honest. */
  usePkce: "boolean",
  /** Whether the provider issues (and rotates) a refresh token. Linear tokens
   * are effectively non-expiring (no refresh); Attio rotates a refresh token.
   * Drives whether the refresh subsystem (ticket #5) engages for this row. */
  hasRefresh: "boolean",
  /** The `CREDENTIAL_PROVIDER_CATALOG` providerName under which the OWNER sets
   * this provider's OAuth *app* client_id + client_secret on the Capabilities
   * page. The flow resolves that tenant credential (source: tenant) at connect
   * time — the app secret is owner-managed, NOT an env var. */
  appCredentialProviderName: "string",
  /** Semi-guided owner setup metadata for the Capabilities page. Drives the
   * guided panel that tells the owner exactly what to register where, so they
   * are not guessing what to paste. Pure, read-only domain data. */
  setup: {
    /** The provider's OFFICIAL OAuth-app creation / developer docs page (opened
     * in a new tab). A documented URL, never a guessed deep link. */
    registerUrl: "string",
    /** The hub callback path the owner must register as the app's redirect URI.
     * The owner-facing full URL is `<hubBase><callbackPath>`, computed in the
     * UI from the hub origin (the callback is a hub route, not the web app). */
    callbackPath: "string",
    /** Ordered, human-readable setup steps shown as a numbered list. */
    steps: "string[]",
    /** Per-field hints shown beneath the Client ID / Client secret inputs. */
    fieldHints: {
      clientId: "string",
      clientSecret: "string",
    },
  },
});
export type OAuthProviderConfig = typeof OAuthProviderConfigSchema.infer;

/** The v1 connectable-provider catalog. GitHub is intentionally absent — it is
 * a GitHub App (installation + PR-review inbox source), scoped to CL-3356 #8,
 * not this OAuth-user-token engine. */
export const OAUTH_PROVIDER_CATALOG: readonly OAuthProviderConfig[] = [
  {
    providerName: "linear",
    label: "Linear",
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    scopeDescriptions: {
      read: "Read your issues, projects, and comments",
      write: "Create and update issues and comments on your behalf",
    },
    usePkce: true,
    hasRefresh: false,
    appCredentialProviderName: "linear-oauth-app",
    setup: {
      registerUrl: "https://developers.linear.app/docs/oauth/authentication",
      callbackPath: "/oauth/callback/linear",
      steps: [
        "Open Linear's OAuth documentation and create a new OAuth application in your workspace settings (Settings → API → OAuth applications).",
        "Set the application's redirect / callback URL to the Redirect URL shown below.",
        "Enable the scopes listed below (read and write).",
        "Copy the application's Client ID and Client secret into the fields below and save.",
      ],
      fieldHints: {
        clientId: "From your Linear OAuth application's settings page.",
        clientSecret:
          "Shown once when you create the Linear OAuth application — copy it now.",
      },
    },
  },
  {
    providerName: "attio",
    label: "Attio",
    authorizationUrl: "https://app.attio.com/authorize",
    tokenUrl: "https://app.attio.com/oauth/token",
    scopes: ["record_permission:read-write", "user_management:read"],
    scopeDescriptions: {
      "record_permission:read-write":
        "Read and update CRM records (people, companies, deals)",
      "user_management:read": "Read your workspace's members and teams",
    },
    usePkce: true,
    hasRefresh: true,
    appCredentialProviderName: "attio-oauth-app",
    setup: {
      registerUrl: "https://developers.attio.com/docs/oauth",
      callbackPath: "/oauth/callback/attio",
      steps: [
        "Open Attio's OAuth documentation and create a new integration / OAuth app in your Attio developer settings.",
        "Set the integration's redirect URI to the Redirect URL shown below.",
        "Request the scopes listed below.",
        "Copy the integration's Client ID and Client secret into the fields below and save.",
      ],
      fieldHints: {
        clientId: "From your Attio integration's OAuth settings.",
        clientSecret:
          "Shown once when you create the Attio integration — copy it now.",
      },
    },
  },
] as const;

export function findOAuthProviderConfig(
  providerName: string,
): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDER_CATALOG.find((p) => p.providerName === providerName);
}

/** Find the connectable provider whose OAuth *app* credential is set under
 * `appCredentialProviderName` (e.g. "linear-oauth-app" → the Linear config).
 * The owner Capabilities page uses this to render the guided setup panel on the
 * app-credential row. */
export function findOAuthProviderByAppCredential(
  appCredentialProviderName: string,
): OAuthProviderConfig | undefined {
  return OAUTH_PROVIDER_CATALOG.find(
    (p) => p.appCredentialProviderName === appCredentialProviderName,
  );
}

/** The `inbox.capability.<provider>` per-member preference key — the user's
 * opt-in toggle beneath the owner capability grant. */
export function inboxCapabilityPreferenceKey(provider: string): string {
  return `inbox.capability.${provider}`;
}

// ─── Owner capability wire schemas (CL-3356 #1) ────────────────────

/** `GET /owner/capabilities` — one connectable provider with its owner-gate
 * state. `enabled` is the effective capability-gate state: false when the org
 * member role holds a `deny` for that provider. The owner toggle writes/removes
 * that deny (mirror of `OwnerWorkflowState`). */
export const OwnerCapabilityState = type({
  provider: "string",
  label: "string",
  enabled: "boolean",
});
export type OwnerCapabilityState = typeof OwnerCapabilityState.infer;

export const OwnerCapabilitiesResponse = type({
  capabilities: OwnerCapabilityState.array(),
});
export type OwnerCapabilities = typeof OwnerCapabilitiesResponse.infer;

export const OwnerCapabilityToggle = type({ enabled: "boolean" });
export type OwnerCapabilityToggle = typeof OwnerCapabilityToggle.infer;

export const OwnerCapabilityToggleResult = type({
  provider: "string",
  enabled: "boolean",
});
export type OwnerCapabilityToggleResult =
  typeof OwnerCapabilityToggleResult.infer;

// ─── Member connections wire schemas (CL-3356 #2) ──────────────────

/** One connectable provider in the member's Settings → Connections surface.
 * Write-only/masked like `OwnerCredentialStateSchema`: never carries the token,
 * only whether the member has connected and the toggle state. Omitted entirely
 * when the owner has hidden the capability (deny grant). */
export const MemberConnectionState = type({
  provider: "string",
  label: "string",
  /** Whether the member holds an active principal-owned OAuth credential. */
  connected: "boolean",
  /** The connected external-account label (from `member_identity`), if any. */
  "accountLabel?": "string",
  /** Scopes the stored credential carries (empty when not connected). */
  scopes: "string[]",
  /** The member's `inbox.capability.<provider>` opt-in beneath the owner gate. */
  toggleEnabled: "boolean",
  /** Set when the credential needs re-authorization (refresh failed / revoked). */
  needsReconnect: "boolean",
  /** Whether the owner has registered this provider's OAuth app (client id +
   * secret). When false, `authorize` will 400 — the UI should disable Connect
   * and explain rather than let the member hit that error. */
  configured: "boolean",
});
export type MemberConnectionState = typeof MemberConnectionState.infer;

export const MemberConnectionsResponse = type({
  connections: MemberConnectionState.array(),
});
export type MemberConnections = typeof MemberConnectionsResponse.infer;

/** `POST /me/connections/:provider/authorize` result — the provider authorize
 * URL the client redirects the user to. */
export const ConnectionAuthorizeResponse = type({ redirectUrl: "string" });
export type ConnectionAuthorize = typeof ConnectionAuthorizeResponse.infer;

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

// ─── Owner role delegation (CL-3634) ───────────────────────────────
//
// The owner can grant/revoke the `owner` system role for other tenant
// members through `/owner/members`, `/owner/members/:id/promote`, and
// `/owner/members/:id/demote`. This reuses the exact same native
// `principal_role` assignment mechanism the admin elevate/demote routes use
// (`assignRole`/`removeRole` in `admin-governance.ts`) — no new grant concept.

/** One tenant member (user principal) in the owner's member roster, with its
 * owner-role status. */
export const OwnerMemberSchema = type({
  id: "string",
  refId: "string",
  displayName: "string",
  isOwner: "boolean",
});
export type OwnerMember = typeof OwnerMemberSchema.infer;

export const OwnerMembersResponse = type({
  members: OwnerMemberSchema.array(),
});
export type OwnerMembersResponse = typeof OwnerMembersResponse.infer;

export const OwnerMemberRoleChangeResult = type({ ok: "boolean" });
export type OwnerMemberRoleChangeResult =
  typeof OwnerMemberRoleChangeResult.infer;

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
  isOwner: "boolean",
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
export type { CredentialProviderCatalogEntry } from "./credential-provider-catalog";
export {
  BIFROST_PROVIDER_NAME,
  CREDENTIAL_PROVIDER_CATALOG,
} from "./credential-provider-catalog";

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

// ─── Feature grants (owner-managed automation toggles) ─────────────
//
// The v0.6 automation kill switches (SCHEDULER_ENABLED, TRIAGE_ENABLED,
// TASKS_RECONCILER_ENABLED) were env-only: turning one on required a redeploy.
// This catalog names the equivalent owner-managed grants, one per feature,
// resolved through the native Interchange grant store exactly like the
// workflow-run gate and the demos toggle above: a `feature:<name>`/`enable`
// ALLOW grant on the tenant's system `member` role turns the feature on for
// everyone in the tenant; no row (or a non-allow row) leaves it off. Features
// are deny-by-default (mirrors demos, not the allow-by-default workflow-run
// gate) — absent any grant, a feature stays off. The env vars are kept as an
// emergency global override: when set, the feature is on regardless of grant
// state (see `apps/hub/src/lib/feature-grants.ts`).
export const FEATURE_GRANT_ACTION = "enable";

export function featureGrantResource(name: string): string {
  return `feature:${name}`;
}

export const FEATURE_NAMES = [
  "scheduler",
  "triage",
  "tasks-reconciler",
  "voice-input",
  "native-approvals",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FeatureCatalogEntry {
  name: FeatureName;
  label: string;
  description: string;
}

/** Hand-maintained, like `CREDENTIAL_PROVIDER_CATALOG` above: a feature is
 * invisible on the Owner → Capabilities "Features" section until it is added
 * here. */
export const FEATURE_GRANT_CATALOG: readonly FeatureCatalogEntry[] = [
  {
    name: "scheduler",
    label: "Automation scheduler",
    description:
      "Fires durable scheduled triggers (e.g. daily Myra heartbeats) on their configured UTC hour.",
  },
  {
    name: "triage",
    label: "Mailbox triage",
    description:
      "Ephemeral Myra triage of external inbound mail landing in a member's inbox.",
  },
  {
    name: "tasks-reconciler",
    label: "Task sync reconciler",
    description:
      "Retries task pushes left pending by a downstream outage, with a bounded per-task retry budget.",
  },
  {
    name: "voice-input",
    label: "Myra voice input",
    description:
      "Shows the microphone control in the Myra composer so members can dictate messages.",
  },
  {
    name: "native-approvals",
    label: "Native approval suspension",
    description:
      "Routes write-tool human approvals through Interchange's native suspend/resume rail: a write tool parks the run until a member approves it in ReviewGate, instead of the legacy hub approval poll. Off leaves the legacy path exactly as before.",
  },
];

export const FeatureNameSchema = type.enumerated(...FEATURE_NAMES);

/** Owner-area read/toggle for one feature grant. `enabled` reflects the
 * member-role grant only; `forcedByEnv` is true when the feature's emergency
 * env override is on — the feature then runs regardless of the grant, so the
 * toggle has no effect and the UI says so instead of lying (mirrors
 * `OwnerDemosResponse`). Per-principal overrides are out of scope for this
 * catalog (tenant-level only); `principalId: null` here is reserved so a future
 * per-principal row can be added to the same response shape. */
export const OwnerFeatureStateSchema = type({
  name: FeatureNameSchema,
  label: "string",
  description: "string",
  enabled: "boolean",
  forcedByEnv: "boolean",
  principalId: "string | null",
});
export type OwnerFeatureState = typeof OwnerFeatureStateSchema.infer;

export const OwnerFeaturesResponse = type({
  features: OwnerFeatureStateSchema.array(),
});
export type OwnerFeaturesResponse = typeof OwnerFeaturesResponse.infer;

export const OwnerFeatureToggle = type({
  enabled: "boolean",
});
export type OwnerFeatureToggle = typeof OwnerFeatureToggle.infer;

/** The PUT toggle route's response: just the written state, not the full
 * catalog row (mirrors `OwnerWorkflowState`). */
export const OwnerFeatureToggleResult = type({
  name: FeatureNameSchema,
  enabled: "boolean",
});
export type OwnerFeatureToggleResult = typeof OwnerFeatureToggleResult.infer;

/** Member-readable feature enablement (CL-3823): same truth as runtime
 * `isFeatureEnabledForTenant` (grant OR env override). No toggle here —
 * owner writes stay on the owner capabilities route. */
export const MemberFeatureStateSchema = type({
  name: FeatureNameSchema,
  enabled: "boolean",
});
export type MemberFeatureState = typeof MemberFeatureStateSchema.infer;

export const MemberFeaturesResponse = type({
  features: MemberFeatureStateSchema.array(),
});
export type MemberFeaturesResponse = typeof MemberFeaturesResponse.infer;
