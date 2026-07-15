import { type } from "arktype";
import { PriceCatalogSchema, type PriceCatalog } from "@workbench/pricing";
import {
  FeedbackListResponse,
  type FeedbackSubjectKind,
  type SavedRating,
  type MemberPreferences,
  MemberPreferences as MemberPreferencesSchema,
  OwnerWorkflowsResponse,
  type OwnerWorkflows,
  OwnerWorkflowState,
  OwnerMembersResponse,
  type OwnerMembersResponse as OwnerMembersState,
  OwnerMemberRoleChangeResult,
  OwnerCredentialsResponse,
  OwnerCredentialStateSchema,
  type OwnerCredentialState,
  OwnerDemosResponse,
  type OwnerDemosResponse as OwnerDemosState,
  OwnerFeaturesResponse,
  type OwnerFeaturesResponse as OwnerFeaturesState,
  OwnerFeatureToggleResult,
  type OwnerFeatureToggleResult as OwnerFeatureToggleResultType,
  OwnerInboxSourcesResponse,
  type OwnerInboxSourcesResponse as OwnerInboxSourcesState,
  OwnerInboxSourceToggleResult,
  type OwnerInboxSourceToggleResult as OwnerInboxSourceToggleResultType,
  type DemoLink,
  DemoLinkSchema,
  WorkflowCatalogSchema,
  type WorkflowCatalog,
  PreferenceSettingsResponseSchema,
  type PreferenceSetting,
  AvailableBriefSourcesResponseSchema,
  type AvailableBriefSource,
  AvailableInboxSourcesResponseSchema,
  type AvailableInboxSource,
  ScheduledTriggerSchema,
  ScheduledTriggerListResponseSchema,
  type ScheduledTrigger,
  type CreateScheduledTriggerBody,
  type UpdateScheduledTriggerBody,
  OwnerCapabilitiesResponse,
  type OwnerCapabilities as OwnerCapabilitiesState,
  OwnerCapabilityToggleResult,
  type OwnerCapabilityToggleResult as OwnerCapabilityToggleResultType,
  MemberConnectionsResponse,
  type MemberConnections,
  ConnectionAuthorizeResponse,
  type ConnectionAuthorize,
} from "@workbench/shared";

// Fetch helper for hub-api routes mounted at /api/ (not /api/v1/).
// These are interchange endpoints — principals, agent instances, sessions.
// Credential and tenant management moved to Interchange admin-ui.

const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? "";

function hubErrorMessage(body: { error?: unknown }, status: number): string {
  const e = body.error;
  if (typeof e === "string" && e.length > 0) return e;
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return `HTTP ${status}`;
}

/** User-facing hint when analytics (or other hub API) calls fail in production. */
export function describeHubApiFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Failed to load analytics data. Check your connection and try again.";
  }
  const status = (error as Error & { status?: number }).status;
  const msg = error.message;

  if (!apiBase && import.meta.env.PROD) {
    return "Web app is not pointed at the hub (VITE_API_BASE_URL). Rebuild and redeploy web with your hub URL.";
  }
  if (status === 404) {
    return "Analytics API was not found on the hub. Redeploy the hub (migrations run on pre-deploy) and try again.";
  }
  if (msg.startsWith("Invalid analytics")) {
    return "Hub returned an unexpected response. Confirm VITE_API_BASE_URL is the hub origin, not the web app URL.";
  }
  if (msg.length > 0 && msg !== "[object Object]") {
    return msg;
  }
  return "Failed to load analytics data. Check your connection and try again.";
}

async function hubFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(
    `/api/${path.replace(/^\//, "")}`,
    apiBase || window.location.origin,
  ).toString();
  const init: RequestInit = { method, credentials: "include" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw Object.assign(new Error(hubErrorMessage(errBody, res.status)), {
      status: res.status,
    });
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export type Principal = {
  principalId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  kind: "user" | "agent";
  status: string;
  roles: { id: string; name: string }[];
};

export type WorkbenchEntry = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
};

export function principalToWorkbenchEntry({
  principalId,
  tenantId,
  tenantSlug,
  tenantName,
}: Principal): WorkbenchEntry {
  return { id: principalId, tenantId, tenantSlug, tenantName };
}

export type MeResponse = {
  userId: string;
  userName: string;
  personalTenantId: string | null;
  rootTenantIds: string[];
  paInstanceId: string | null;
  provisioned: boolean;
  credentialResolved: boolean;
  /** Whether the caller may see the Admin area (holds owner/admin grants,
   * resolved server-side via Interchange's native grant model). The hub admin
   * routes re-check this — the flag only drives nav visibility. */
  isAdmin?: boolean;
  /** Whether the caller may see the Owner area (holds the `owner` role's `*`/`*`
   * grant — ABK Labs staff, a strict superset of admin). Resolved server-side
   * via Interchange's native grant model; the hub owner routes re-check it, so
   * this flag only drives nav visibility. */
  isOwner?: boolean;
  /** When true, call postMe() to provision or push template/grant updates. */
  personalAgentSyncAvailable?: boolean;
  /** Server-persisted UI preferences, folded into the bootstrap to avoid an extra round-trip. */
  preferences?: MemberPreferences;
  /** Demo links for the sidebar's Demos section. Resolved server-side and only
   * populated when demos are enabled (env override or org-wide owner toggle);
   * omitted/empty means the section is hidden. */
  demoLinks?: DemoLink[];
};

const DemoLinksArraySchema = DemoLinkSchema.array();

/**
 * Validates the parts of the `/me` payload that cross the web trust boundary,
 * degrading each to a safe empty value on a malformed shape so a bad server
 * value can never poison the preferences store or the sidebar.
 */
function parseMe(me: MeResponse): MeResponse {
  const next: MeResponse = { ...me };
  if (me.preferences !== undefined) {
    const parsed = MemberPreferencesSchema(me.preferences);
    next.preferences = parsed instanceof type.errors ? {} : parsed;
  }
  if (me.demoLinks !== undefined) {
    const parsed = DemoLinksArraySchema(me.demoLinks);
    next.demoLinks = parsed instanceof type.errors ? [] : parsed;
  }
  return next;
}

export async function getMe(): Promise<MeResponse> {
  return parseMe(await hubFetch<MeResponse>("GET", "v1/me"));
}

/** The org-wide Demos toggle state: the grant-backed `enabled`, plus whether the
 * `SHOW_DEMOS` env override is forcing demos on (making the toggle inert). */
export async function getOwnerDemos(): Promise<OwnerDemosState> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/demos");
  const parsed = OwnerDemosResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed /owner/demos response: ${parsed.summary}`);
  }
  return parsed;
}

/** Enable or disable the Demos sidebar section org-wide (owner-guarded). */
export async function setOwnerDemosEnabled(
  enabled: boolean,
): Promise<OwnerDemosState> {
  const raw = await hubFetch<unknown>("PUT", "v1/owner/demos", { enabled });
  const parsed = OwnerDemosResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner demos response: ${parsed.summary}`);
  }
  return parsed;
}

/** Owner-managed feature grants (scheduler/triage/tasks-reconciler) and their
 * enablement state (owner-guarded). */
export async function getOwnerFeatures(): Promise<OwnerFeaturesState> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/features");
  const parsed = OwnerFeaturesResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed /owner/features response: ${parsed.summary}`);
  }
  return parsed;
}

/** Enable or disable a feature grant org-wide (owner-guarded). */
export async function setOwnerFeatureEnabled(
  name: string,
  enabled: boolean,
): Promise<OwnerFeatureToggleResultType> {
  const raw = await hubFetch<unknown>(
    "PUT",
    `v1/owner/features/${encodeURIComponent(name)}`,
    { enabled },
  );
  const parsed = OwnerFeatureToggleResult(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner feature response: ${parsed.summary}`);
  }
  return parsed;
}

/** Owner-managed inbox source enablement (the tenant ceiling above each
 * member's inbox-source preference) and each source's state (owner-guarded). */
export async function getOwnerInboxSources(): Promise<OwnerInboxSourcesState> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/inbox-sources");
  const parsed = OwnerInboxSourcesResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Malformed /owner/inbox-sources response: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Enable or disable an inbox source org-wide (owner-guarded). */
export async function setOwnerInboxSourceEnabled(
  key: string,
  enabled: boolean,
): Promise<OwnerInboxSourceToggleResultType> {
  const raw = await hubFetch<unknown>(
    "PUT",
    `v1/owner/inbox-sources/${encodeURIComponent(key)}`,
    { enabled },
  );
  const parsed = OwnerInboxSourceToggleResult(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner inbox source response: ${parsed.summary}`);
  }
  return parsed;
}

/** Connectable OAuth providers and whether each is enabled (owner-guarded). */
export async function getOwnerCapabilities(): Promise<OwnerCapabilitiesState> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/capabilities");
  const parsed = OwnerCapabilitiesResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Malformed /owner/capabilities response: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Enable (allow) or hide (deny) a connectable provider org-wide (owner-guarded). */
export async function setOwnerCapabilityEnabled(
  provider: string,
  enabled: boolean,
): Promise<OwnerCapabilityToggleResultType> {
  const raw = await hubFetch<unknown>(
    "PUT",
    `v1/owner/capabilities/${encodeURIComponent(provider)}`,
    { enabled },
  );
  const parsed = OwnerCapabilityToggleResult(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner capability response: ${parsed.summary}`);
  }
  return parsed;
}

/** The caller's connectable providers + connection state (Settings → Connections). */
export async function getMeConnections(): Promise<MemberConnections> {
  const raw = await hubFetch<unknown>("GET", "v1/me/connections");
  const parsed = MemberConnectionsResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed /me/connections response: ${parsed.summary}`);
  }
  return parsed;
}

/** Begin the OAuth connect flow for a provider; returns the authorize URL to redirect to. */
export async function authorizeMeConnection(
  provider: string,
): Promise<ConnectionAuthorize> {
  const raw = await hubFetch<unknown>(
    "POST",
    `v1/me/connections/${encodeURIComponent(provider)}/authorize`,
  );
  const parsed = ConnectionAuthorizeResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Malformed connection authorize response: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Deployed workflow kinds + their run-enablement state (owner-guarded). */
export async function getOwnerWorkflows(): Promise<OwnerWorkflows> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/workflows");
  const parsed = OwnerWorkflowsResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed /owner/workflows response: ${parsed.summary}`);
  }
  return parsed;
}

/** Tenant members with their owner-role status (owner-guarded, CL-3634). */
export async function getOwnerMembers(): Promise<OwnerMembersState> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/members");
  const parsed = OwnerMembersResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed /owner/members response: ${parsed.summary}`);
  }
  return parsed;
}

/** Grant the `owner` role to a tenant member (owner-guarded, CL-3634). */
export async function promoteOwnerMember(principalId: string) {
  const raw = await hubFetch<unknown>(
    "POST",
    `v1/owner/members/${encodeURIComponent(principalId)}/promote`,
  );
  const parsed = OwnerMemberRoleChangeResult(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner promote response: ${parsed.summary}`);
  }
  return parsed;
}

/** Remove the `owner` role from a tenant member (owner-guarded, CL-3634). */
export async function demoteOwnerMember(principalId: string) {
  const raw = await hubFetch<unknown>(
    "POST",
    `v1/owner/members/${encodeURIComponent(principalId)}/demote`,
  );
  const parsed = OwnerMemberRoleChangeResult(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner demote response: ${parsed.summary}`);
  }
  return parsed;
}

/** Enable or disable a workflow kind for the workbench (owner-guarded). */
export async function setOwnerWorkflowEnabled(
  kind: string,
  enabled: boolean,
): Promise<OwnerWorkflowState> {
  const raw = await hubFetch<unknown>(
    "PUT",
    `v1/owner/workflows/${encodeURIComponent(kind)}`,
    { enabled },
  );
  const parsed = OwnerWorkflowState(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner workflow response: ${parsed.summary}`);
  }
  return parsed;
}

/** Masked configured/missing state for every provider credential the workbench
 * manages (owner-guarded). Never carries a secret. Catalog filters this to
 * `kind: "inference"`; Capabilities filters it to `kind: "tool"`. */
export async function getOwnerCredentials(): Promise<OwnerCredentialState[]> {
  const raw = await hubFetch<unknown>("GET", "v1/owner/credentials");
  const parsed = OwnerCredentialsResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed /owner/credentials response: ${parsed.summary}`);
  }
  return parsed.credentials;
}

/** Set or replace a provider's credential secret (write-only; owner-guarded).
 * The response is masked state only — the secret is never echoed back.
 *
 * For gateways (e.g. bifrost), an optional baseURL can be supplied so the
 * owner can configure the endpoint in the same flow. */
export async function setOwnerCredential(
  providerName: string,
  secret: string,
  baseURL?: string,
): Promise<OwnerCredentialState> {
  const body: { secret: string; baseURL?: string } = { secret };
  if (baseURL) body.baseURL = baseURL;
  const raw = await hubFetch<unknown>(
    "PUT",
    `v1/owner/credentials/${encodeURIComponent(providerName)}`,
    body,
  );
  const parsed = OwnerCredentialStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner credential response: ${parsed.summary}`);
  }
  return parsed;
}

/** Clear a provider's credential (owner-guarded). */
export async function clearOwnerCredential(
  providerName: string,
): Promise<OwnerCredentialState> {
  const raw = await hubFetch<unknown>(
    "DELETE",
    `v1/owner/credentials/${encodeURIComponent(providerName)}`,
  );
  const parsed = OwnerCredentialStateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed owner credential response: ${parsed.summary}`);
  }
  return parsed;
}

export type PostMeBody = {
  syncPersonalAgent?: boolean;
};

/** Ensures org membership / Myra and syncs live session grants (safe to repeat). */
export async function postMe(body: PostMeBody = {}): Promise<MeResponse> {
  return parseMe(await hubFetch<MeResponse>("POST", "v1/me", body));
}

/**
 * The whole Workflows-page catalog in one call: every runnable workflow with
 * the member's favorite state and its classified step flow. Parsed at the
 * boundary through the shared schema.
 */
export async function getWorkflowsCatalog(
  tenantId?: string | null,
): Promise<WorkflowCatalog> {
  const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  const raw = await hubFetch<unknown>("GET", `v1/workflows${query}`);
  const parsed = WorkflowCatalogSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected workflows catalog response: ${parsed.summary}`);
  }
  return parsed;
}

/** The caller's own automation schedules, parsed at the boundary. Reads the
 * first page of the keyset-paginated list; nextCursor is ignored for now. */
export async function listMeSchedules(): Promise<ScheduledTrigger[]> {
  const raw = await hubFetch<unknown>("GET", "v1/me/schedules");
  const parsed = ScheduledTriggerListResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected schedules response: ${parsed.summary}`);
  }
  return parsed.items;
}

function parseSchedule(raw: unknown): ScheduledTrigger {
  const parsed = ScheduledTriggerSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected schedule response: ${parsed.summary}`);
  }
  return parsed;
}

/** Create a schedule that fires the given workflow at a UTC hour. */
export async function createMeSchedule(
  body: CreateScheduledTriggerBody,
): Promise<ScheduledTrigger> {
  return parseSchedule(
    await hubFetch<unknown>("POST", "v1/me/schedules", body),
  );
}

/** Update the caller's schedule (enablement and/or fire hour). */
export async function updateMeSchedule(
  id: string,
  body: UpdateScheduledTriggerBody,
): Promise<ScheduledTrigger> {
  return parseSchedule(
    await hubFetch<unknown>(
      "PATCH",
      `v1/me/schedules/${encodeURIComponent(id)}`,
      body,
    ),
  );
}

/** Delete the caller's schedule. */
export async function deleteMeSchedule(id: string): Promise<void> {
  await hubFetch<void>("DELETE", `v1/me/schedules/${encodeURIComponent(id)}`);
}

/** The registry-driven settings with the caller's resolved values, parsed at
 * the boundary through the shared schema. */
export async function getMePreferenceSettings(): Promise<PreferenceSetting[]> {
  const raw = await hubFetch<unknown>("GET", "v1/me/preferences/settings");
  const parsed = PreferenceSettingsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Unexpected preference settings response: ${parsed.summary}`,
    );
  }
  return parsed.settings;
}

/** The morning-brief sources the caller can toggle: every catalog source with
 * a credential configured for their tenant, resolved against their stored
 * enablement. A source without a configured credential is simply absent. */
export async function getMeBriefSources(): Promise<AvailableBriefSource[]> {
  const raw = await hubFetch<unknown>("GET", "v1/me/brief-sources");
  const parsed = AvailableBriefSourcesResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected brief sources response: ${parsed.summary}`);
  }
  return parsed.sources;
}

const BriefRunResponseSchema = type({
  status: "'started'",
  deploymentId: "string",
});

/** Triggers the caller's own morning brief right now, outside its daily
 * schedule. Rate-limited server-side to one manual run per member per 10
 * minutes (429 on a repeat). */
export async function postMeBriefRun(): Promise<{ deploymentId: string }> {
  const raw = await hubFetch<unknown>("POST", "v1/me/brief-run");
  const parsed = BriefRunResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected brief-run response: ${parsed.summary}`);
  }
  return { deploymentId: parsed.deploymentId };
}

/** The inbox sources the caller can toggle: every catalog source with a
 * credential configured for their tenant, resolved against their stored
 * enablement — independent of the caller's brief-source toggles. A source
 * without a configured credential is simply absent. */
export async function getMeInboxSources(): Promise<AvailableInboxSource[]> {
  const raw = await hubFetch<unknown>("GET", "v1/me/inbox-sources");
  const parsed = AvailableInboxSourcesResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected inbox sources response: ${parsed.summary}`);
  }
  return parsed.sources;
}

/** Merge a partial patch into the caller's persisted UI preferences. */
export async function patchMePreferences(
  patch: Record<string, unknown>,
): Promise<MemberPreferences> {
  return hubFetch<MemberPreferences>("PATCH", "v1/me/preferences", patch);
}

/** The caller's raw persisted preferences, parsed at the boundary. Used for
 * keys (like `changelogSeenVersion`) that ride the open jsonb map rather than
 * the registry-driven settings list. */
export async function getMePreferences(): Promise<MemberPreferences> {
  const raw = await hubFetch<unknown>("GET", "v1/me/preferences");
  const parsed = MemberPreferencesSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected preferences response: ${parsed.summary}`);
  }
  return parsed;
}

/** Persist the caller's display name; returns the saved value as `userName`. */
export async function patchMeProfile(
  displayName: string,
): Promise<{ userName: string }> {
  return hubFetch<{ userName: string }>("PATCH", "v1/me/profile", {
    displayName,
  });
}

/** Read-only status; runs postMe when the hub signals an update is available. */
export async function ensureMeSynced(): Promise<MeResponse> {
  const me = await getMe();
  if (me.personalAgentSyncAvailable) {
    return postMe();
  }
  return me;
}

// `firstMessageAt` is optional at the parse boundary so a hub that predates
// the column (deploy skew) still parses; a missing value counts as "used"
// (see isMyraThreadUsed) so nothing is ever hidden by skew.
const MyraThreadSchema = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
  lastActivityAt: "string",
  "firstMessageAt?": "string | null",
});
export type MyraThread = typeof MyraThreadSchema.infer;

export const MyraThreadListItemSchema = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
  lastActivityAt: "string",
  "firstMessageAt?": "string | null",
});
export type MyraThreadListItem = typeof MyraThreadListItemSchema.infer;
export const MyraThreadPageSchema = type({
  threads: MyraThreadListItemSchema.array(),
  total: "number",
});
export type MyraThreadPage = typeof MyraThreadPageSchema.infer;

function myraThreadsBase(tenantId: string): string {
  return `v1/tenants/${encodeURIComponent(tenantId)}/me/myra/threads`;
}

export async function listMyraThreads(
  tenantId: string,
  opts?: { limit?: number },
): Promise<MyraThreadPage> {
  const path =
    opts?.limit !== undefined
      ? `${myraThreadsBase(tenantId)}?limit=${opts.limit}`
      : myraThreadsBase(tenantId);
  const raw = await hubFetch<unknown>("GET", path);
  const parsed = MyraThreadPageSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra threads response: ${parsed.summary}`);
  }
  return parsed;
}

// `created` is false when the hub handed back an existing never-used thread
// instead of minting a new one (CL-3749) — navigation treats both the same,
// but the thread-list cache must not double-count a reused thread.
const MyraThreadCreateSchema = type({
  thread: MyraThreadSchema,
  created: "boolean",
});

export async function createMyraThread(
  tenantId: string,
  label?: string,
): Promise<{ thread: MyraThread; created: boolean }> {
  const raw = await hubFetch<unknown>(
    "POST",
    myraThreadsBase(tenantId),
    label !== undefined ? { label } : {},
  );
  const parsed = MyraThreadCreateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra thread create response: ${parsed.summary}`);
  }
  return parsed;
}

const MyraThreadMutateSchema = type({ thread: MyraThreadSchema });

export async function renameMyraThread(
  tenantId: string,
  id: string,
  label: string,
): Promise<MyraThread> {
  const raw = await hubFetch<unknown>(
    "PATCH",
    `${myraThreadsBase(tenantId)}/${encodeURIComponent(id)}`,
    {
      label,
    },
  );
  const parsed = MyraThreadMutateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra thread rename response: ${parsed.summary}`);
  }
  return parsed.thread;
}

export async function deleteMyraThread(
  tenantId: string,
  id: string,
): Promise<void> {
  await hubFetch<void>(
    "DELETE",
    `${myraThreadsBase(tenantId)}/${encodeURIComponent(id)}`,
  );
}

/**
 * Best-effort: ask the hub to title a thread from its first message. The hub
 * no-ops if the thread already has a custom title. Returns the updated thread,
 * or null on a no-op/failure (titling never blocks chat).
 */
export async function generateMyraThreadTitle(
  tenantId: string,
  id: string,
  firstMessage: string,
): Promise<MyraThread | null> {
  const raw = await hubFetch<unknown>(
    "POST",
    `${myraThreadsBase(tenantId)}/${encodeURIComponent(id)}/title`,
    { firstMessage },
  );
  const parsed = type({ thread: MyraThreadSchema.or("null") })(raw);
  if (parsed instanceof type.errors) return null;
  return parsed.thread;
}

export async function getMyPrincipals(): Promise<Principal[]> {
  const res = await hubFetch<{ data: Principal[] }>("GET", "me/principals");
  return res.data;
}

export function principalsToWorkbenches(
  principals: Principal[],
  excludeTenantIds: (string | null)[],
): WorkbenchEntry[] {
  const excluded = new Set(
    excludeTenantIds.filter((id): id is string => id !== null),
  );
  return principals
    .filter((p) => !excluded.has(p.tenantId))
    .map(principalToWorkbenchEntry);
}

export async function listWorkbenches(): Promise<WorkbenchEntry[]> {
  const [principals, me] = await Promise.all([getMyPrincipals(), getMe()]);
  // The working/global-org tenant (`personalTenantId`) stays selectable as the
  // default "home" workbench: existing Myra threads live in it, and a root-only
  // user needs it to have any active workbench at all. Only OTHER root tenants
  // (legacy Interchange personal tenants) are excluded.
  const workingId = me.personalTenantId;
  const excludeIds = (me.rootTenantIds ?? []).filter((id) => id !== workingId);
  const entries = principalsToWorkbenches(principals, excludeIds);
  if (!workingId) return entries;
  // List the working tenant first so it is the default active workbench.
  return [
    ...entries.filter((e) => e.tenantId === workingId),
    ...entries.filter((e) => e.tenantId !== workingId),
  ];
}

export type CredentialRequirement = {
  providerName: string;
  source: "tenant" | "creator" | "invoker";
  name?: string;
};

export type AgentInstance = {
  id: string;
  agentId: string;
  agentName: string;
  tenantId: string;
  address: string;
  status: string;
  credentialRequirements: CredentialRequirement[];
  capabilities: Record<string, unknown> | null;
  createdAt: string;
};

export async function listAgentInstances(
  tenantId: string,
): Promise<AgentInstance[]> {
  const res = await hubFetch<{ data: AgentInstance[] }>(
    "GET",
    `v1/agents?tenantId=${encodeURIComponent(tenantId)}`,
  );
  return res.data;
}

export async function deleteAgentInstance(
  tenantId: string,
  instanceId: string,
): Promise<void> {
  await hubFetch<void>(
    "DELETE",
    `v1/tenants/${tenantId}/agents/instances/${instanceId}`,
  );
}

const LaunchInstanceSessionSuccessSchema = type({
  launched: "true",
  sessionId: "string | null",
});

const LaunchInstanceSessionFailureSchema = type({
  launched: "false",
  "launchError?": "string",
});

export const LaunchInstanceSessionResponseSchema =
  LaunchInstanceSessionSuccessSchema.or(LaunchInstanceSessionFailureSchema);

export type LaunchInstanceSessionResponse =
  typeof LaunchInstanceSessionResponseSchema.infer;

export type LaunchInstanceSessionOptions = {
  pageContext?: string;
};

export async function launchInstanceSession(
  instanceId: string,
  options?: LaunchInstanceSessionOptions,
): Promise<LaunchInstanceSessionResponse> {
  const body: { pageContext?: string } = {};
  if (options?.pageContext !== undefined) {
    body.pageContext = options.pageContext;
  }
  const raw = await hubFetch<unknown>(
    "POST",
    `v1/instances/${instanceId}/sessions`,
    body,
  );
  const parsed = LaunchInstanceSessionResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Invalid launch instance session response: ${parsed.summary}`,
    );
  }
  return parsed;
}

/**
 * Stops the instance's in-flight chat turn without ending the conversation.
 * 409 (no turn running) is treated as success — the desired end state
 * ("nothing running") already holds, e.g. the turn finished as the user
 * clicked stop.
 */
export async function abortInstanceTurn(instanceId: string): Promise<void> {
  try {
    await hubFetch<void>("POST", `v1/instances/${instanceId}/abort-turn`);
  } catch (err) {
    if (err instanceof Error && hasStatus(err) && err.status === 409) {
      return;
    }
    throw err;
  }
}

function hasStatus(err: Error): err is Error & { status: number } {
  return typeof (err as { status?: unknown }).status === "number";
}

export async function stopAgentInstance(
  tenantId: string,
  instanceId: string,
): Promise<void> {
  await hubFetch<void>(
    "DELETE",
    `v1/tenants/${tenantId}/agents/instances/${instanceId}`,
  );
}

export type DeployAgentResponse = {
  instanceId: string;
  created: boolean;
};

export type AgentCatalogEntry = {
  key: string;
  name: string;
  description: string;
  tools: string[];
};

export async function listAgentTemplates(): Promise<AgentCatalogEntry[]> {
  const res = await hubFetch<{ data: AgentCatalogEntry[] }>(
    "GET",
    "v1/agents/templates",
  );
  return res.data;
}

export type { FeedbackSubjectKind, SavedRating };

/**
 * Returns a new ratings list with `next` upserted by (subjectId, subjectKind).
 * Used to keep the feedback query cache consistent with a just-saved rating
 * while the invalidate-driven refetch is in flight, so the displayed pressed
 * state never regresses to a stale value between save and refetch.
 */
export function upsertRating(
  prev: SavedRating[] | undefined,
  next: SavedRating,
): SavedRating[] {
  const without = (prev ?? []).filter(
    (r) =>
      !(r.subjectId === next.subjectId && r.subjectKind === next.subjectKind),
  );
  return [...without, next];
}

export async function getOutputFeedback(
  instanceId: string,
): Promise<SavedRating[]> {
  const res = await hubFetch<unknown>(
    "GET",
    `v1/instances/${instanceId}/feedback`,
  );
  const parsed = FeedbackListResponse(res);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed feedback response: ${parsed.summary}`);
  }
  return parsed.ratings;
}

export async function saveOutputFeedback(
  instanceId: string,
  subjectId: string,
  subjectKind: FeedbackSubjectKind,
  rating: 1 | -1,
): Promise<void> {
  await hubFetch<void>("POST", `v1/instances/${instanceId}/feedback`, {
    subjectId,
    subjectKind,
    rating,
  });
}

export async function deployAgentFromTemplate(
  tenantId: string,
  templateKey: string,
): Promise<DeployAgentResponse> {
  return hubFetch<DeployAgentResponse>(
    "POST",
    `v1/tenants/${tenantId}/agents/instances`,
    {
      templateKey,
    },
  );
}

const AnalyticsSummarySchema = type({
  tenantId: "string",
  turnCount: "number",
  failedTurnCount: "number",
  toolCallCount: "number",
  toolErrorCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
});

export type AnalyticsSummary = typeof AnalyticsSummarySchema.infer;

export async function getAnalyticsSummary(
  tenantId: string,
  opts?: { startDate?: string; endDate?: string },
): Promise<AnalyticsSummary> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set("startDate", opts.startDate);
  if (opts?.endDate) params.set("endDate", opts.endDate);
  const qs = params.toString();
  const path = `tenants/${encodeURIComponent(tenantId)}/analytics/summary${qs ? `?${qs}` : ""}`;
  const raw = await hubFetch<unknown>("GET", path);
  const result = AnalyticsSummarySchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid analytics summary response: ${result.summary}`);
  }
  return result;
}

const AnalyticsAgentRowSchema = type({
  agentId: "string",
  agentName: "string | null",
  turnCount: "number",
  failedTurnCount: "number",
  toolCallCount: "number",
  toolErrorCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
});

const AnalyticsByAgentResponseSchema = type({
  tenantId: "string",
  agents: AnalyticsAgentRowSchema.array(),
});

export type AnalyticsAgentRow = typeof AnalyticsAgentRowSchema.infer;

export async function getAnalyticsSummaryByAgent(
  tenantId: string,
  opts?: { startDate?: string; endDate?: string },
): Promise<AnalyticsAgentRow[]> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set("startDate", opts.startDate);
  if (opts?.endDate) params.set("endDate", opts.endDate);
  const qs = params.toString();
  const path = `tenants/${encodeURIComponent(tenantId)}/analytics/summary/by-agent${qs ? `?${qs}` : ""}`;
  const raw = await hubFetch<unknown>("GET", path);
  const result = AnalyticsByAgentResponseSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid analytics by-agent response: ${result.summary}`);
  }
  return result.agents;
}

const ActivityCountRowSchema = type({
  key: "string",
  count: "number",
});

/**
 * One bucket of the Insights daily-metrics series — the source for
 * the CSV export. `bucketStart` is the row's date label (`YYYY-MM-DD`).
 */
export const MetricsPointSchema = type({
  bucketStart: "string",
  agentsDeployed: "number",
  agentsActive: "number",
  tokensSpent: "number",
  artifactsCreated: "number",
});
export type MetricsPoint = typeof MetricsPointSchema.infer;

/**
 * Priced usage — mirrors `@workbench/pricing`'s `PricedUsage`.
 * `null` means the hub had no price catalog warm when it computed this row
 * (never a fabricated `$0`); a non-null value with `hasUnpriced: true` means
 * some of the underlying models had no models.dev rate.
 */
export const PricedUsageSchema = type({
  cost: {
    input: "number",
    output: "number",
    cacheRead: "number",
    cacheWrite: "number",
    thinking: "number",
    total: "number",
  },
  unpricedModels: "string[]",
  hasUnpriced: "boolean",
}).or("null");

export type PricedUsageValue = typeof PricedUsageSchema.infer;

export const UsageByPersonRowSchema = type({
  principalId: "string",
  name: "string | null",
  isSelf: "boolean",
  turnCount: "number",
  toolCallCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
  cost: PricedUsageSchema,
});

export type UsageByPersonRow = typeof UsageByPersonRowSchema.infer;

/** Per-model usage with every token class separated, for cost-by-model. */
export const UsageByModelRowSchema = type({
  model: "string",
  turnCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWriteTokens: "number",
  thinkingTokens: "number",
});

export type UsageByModelRow = typeof UsageByModelRowSchema.infer;

export const UsageByWorkflowTypeRowSchema = type({
  kind: "string",
  turnCount: "number",
  toolCallCount: "number",
  inputTokens: "number",
  outputTokens: "number",
  "cacheReadTokens?": "number",
  "cacheWriteTokens?": "number",
  "thinkingTokens?": "number",
  cost: PricedUsageSchema,
});

type ParsedUsageByWorkflowTypeRow = typeof UsageByWorkflowTypeRowSchema.infer;

/** Normalized workflow usage row (all five token classes required). */
export type UsageByWorkflowTypeRow = Omit<
  ParsedUsageByWorkflowTypeRow,
  "cacheReadTokens" | "cacheWriteTokens" | "thinkingTokens"
> & {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

const ActivityOverviewSchema = type({
  tenantId: "string",
  range: {
    "startDate?": "string",
    "endDate?": "string",
  },
  artifacts: {
    total: "number",
    createdInRange: "number",
    byStatus: ActivityCountRowSchema.array(),
    byKind: ActivityCountRowSchema.array(),
  },
  workflowRuns: {
    executionRecords: "number",
    executionsStartedInRange: "number",
    activeExecutions: "number",
    byStatus: ActivityCountRowSchema.array(),
    byKind: ActivityCountRowSchema.array(),
    deploymentsIndexed: "number",
  },
  agentInstances: {
    active: "number",
    startedInRange: "number",
    endedInRange: "number",
    total: "number",
  },
  agentActivity: {
    active: "number",
    idle: "number",
  },
  conversations: {
    total: "number",
    createdInRange: "number",
  },
  messages: {
    total: "number",
    createdInRange: "number",
  },
  dailySeries: type({
    date: "string",
    turnCount: "number",
    failedTurnCount: "number",
    toolCallCount: "number",
    toolErrorCount: "number",
    inputTokens: "number",
    outputTokens: "number",
    cacheReadTokens: "number",
    cacheWriteTokens: "number",
    thinkingTokens: "number",
  }).array(),
  metricsBucket: "'day' | 'week' | 'month'",
  metricsSeries: MetricsPointSchema.array(),
  models: ActivityCountRowSchema.array(),
  byModel: UsageByModelRowSchema.array(),
  "pricedByModel?": PricedUsageSchema,
  tokensRecordedFrom: "string.date | null",
  byPerson: UsageByPersonRowSchema.array(),
  byWorkflowType: UsageByWorkflowTypeRowSchema.array(),
  inference: {
    summary: AnalyticsSummarySchema,
    previousSummary: AnalyticsSummarySchema.or("null"),
    byAgent: AnalyticsAgentRowSchema.array(),
    byInstance: type({
      instanceId: "string",
      agentId: "string",
      agentName: "string | null",
      turnCount: "number",
      failedTurnCount: "number",
      toolCallCount: "number",
      toolErrorCount: "number",
      inputTokens: "number",
      outputTokens: "number",
      cacheReadTokens: "number",
      cacheWriteTokens: "number",
      thinkingTokens: "number",
    }).array(),
  },
});

type ParsedActivityOverview = typeof ActivityOverviewSchema.infer;

function normalizeWorkflowTypeRow(
  row: ParsedUsageByWorkflowTypeRow,
): UsageByWorkflowTypeRow {
  return {
    kind: row.kind,
    turnCount: row.turnCount,
    toolCallCount: row.toolCallCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
    thinkingTokens: row.thinkingTokens ?? 0,
    cost: row.cost,
  };
}

function normalizeActivityOverview(
  parsed: ParsedActivityOverview,
): ActivityOverview {
  return {
    ...parsed,
    pricedByModel: parsed.pricedByModel ?? null,
    byWorkflowType: parsed.byWorkflowType.map(normalizeWorkflowTypeRow),
  };
}

export type ActivityOverview = Omit<
  ParsedActivityOverview,
  "pricedByModel" | "byWorkflowType"
> & {
  pricedByModel: PricedUsageValue | null;
  byWorkflowType: UsageByWorkflowTypeRow[];
};

/**
 * Parse an activity overview API payload.
 * Rolling-deploy back-compat: optional `pricedByModel` and optional cache/thinking
 * fields on `byWorkflowType` only (other overview sections stay strict).
 */
export function parseActivityOverview(raw: unknown): ActivityOverview {
  const result = ActivityOverviewSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid activity overview response: ${result.summary}`);
  }
  return normalizeActivityOverview(result);
}

/**
 * Fetches the hub-cached models.dev pricing catalog. The browser
 * never hits models.dev directly (CSP); the hub proxies + caches it. Parsed at
 * the boundary through the shared `PriceCatalogSchema`.
 */
export async function getModelPricing(tenantId: string): Promise<PriceCatalog> {
  const path = `tenants/${encodeURIComponent(tenantId)}/pricing`;
  const raw = await hubFetch<unknown>("GET", path);
  const result = PriceCatalogSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid pricing catalog response: ${result.summary}`);
  }
  return result;
}

/**
 * Same-origin hub URL for a provider logo SVG (proxied from models.dev). Safe as
 * an `<img src>` — it stays within CSP because it targets the hub, not
 * models.dev. Falls back to the current origin when no API base is configured,
 * so it always returns a usable same-origin URL.
 */
export function providerLogoUrl(tenantId: string, provider: string): string {
  const base = apiBase || window.location.origin;
  return `${base}/api/tenants/${encodeURIComponent(tenantId)}/pricing/logos/${encodeURIComponent(provider)}`;
}

/** A tenant provider definition (owner-guarded native tenant API), including
 * ones inherited from ancestor tenants. Only the fields the Models tab
 * renders are validated; extra fields are ignored rather than rejected. */
export const TenantProviderSchema = type({
  id: "string",
  name: "string",
  plugin: "string",
  "+": "ignore",
});
export type TenantProvider = typeof TenantProviderSchema.infer;

const TenantProvidersResponse = type({
  data: TenantProviderSchema.array(),
  "+": "ignore",
});

/** Lists the tenant's provider catalog, including providers inherited from
 * ancestor tenants (owner holds `provider:*`/`read` via the `*`/`*` grant).
 * Parsed at the boundary rather than cast. */
export async function getTenantProviders(
  tenantId: string,
): Promise<TenantProvider[]> {
  const raw = await hubFetch<unknown>(
    "GET",
    `tenants/${encodeURIComponent(tenantId)}/providers?inherited=true`,
  );
  const parsed = TenantProvidersResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed tenant providers response: ${parsed.summary}`);
  }
  return parsed.data;
}

/** One offering (provider + priority + pricing) of a resolved model, from the
 * tenant's model discovery view. */
export const TenantModelOfferingSchema = type({
  offeringId: "string",
  providerId: "string",
  providerName: "string",
  plugin: "string",
  priority: "number",
  "+": "ignore",
});
export type TenantModelOffering = typeof TenantModelOfferingSchema.infer;

/** A resolved model in the tenant's catalog (inheritance + shadowing already
 * applied), with the providers that offer it. */
export const TenantModelSchema = type({
  id: "string",
  canonicalName: "string",
  displayName: "string | null",
  description: "string | null",
  offerings: TenantModelOfferingSchema.array(),
  "+": "ignore",
});
export type TenantModel = typeof TenantModelSchema.infer;

const TenantModelsResponse = TenantModelSchema.array();

/** Lists the tenant's resolved model catalog (owner-guarded native tenant
 * API): every model visible after inheritance/shadowing, broken down by the
 * providers that offer it. Parsed at the boundary rather than cast. */
export async function getTenantModels(
  tenantId: string,
): Promise<TenantModel[]> {
  const raw = await hubFetch<unknown>(
    "GET",
    `tenants/${encodeURIComponent(tenantId)}/models`,
  );
  const parsed = TenantModelsResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Malformed tenant models response: ${parsed.summary}`);
  }
  return parsed;
}

export type ActivityExportBucket = "day" | "week" | "month";

export async function getActivityOverview(
  tenantId: string,
  opts?: {
    startDate?: string;
    endDate?: string;
    bucket?: ActivityExportBucket;
  },
): Promise<ActivityOverview> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set("startDate", opts.startDate);
  if (opts?.endDate) params.set("endDate", opts.endDate);
  if (opts?.bucket) params.set("bucket", opts.bucket);
  const qs = params.toString();
  const path = `tenants/${encodeURIComponent(tenantId)}/activity/overview${qs ? `?${qs}` : ""}`;
  const raw = await hubFetch<unknown>("GET", path);
  return parseActivityOverview(raw);
}

/** Server-side Insights CSV: metrics series + person/model/workflow breakdowns. */
export async function downloadActivityExportCsv(
  tenantId: string,
  opts?: {
    startDate?: string;
    endDate?: string;
    bucket?: ActivityExportBucket;
  },
): Promise<{ csv: string; filename: string }> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set("startDate", opts.startDate);
  if (opts?.endDate) params.set("endDate", opts.endDate);
  if (opts?.bucket) params.set("bucket", opts.bucket);
  const qs = params.toString();
  const url = new URL(
    `/api/tenants/${encodeURIComponent(tenantId)}/activity/export.csv${qs ? `?${qs}` : ""}`,
    apiBase || window.location.origin,
  );
  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw Object.assign(new Error(hubErrorMessage(errBody, res.status)), {
      status: res.status,
    });
  }
  const csv = await res.text();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? "insights-export.csv";
  return { csv, filename };
}
