import { type } from "arktype";
import {
  FeedbackListResponse,
  type FeedbackSubjectKind,
  type SavedRating,
  type MemberPreferences,
  MemberPreferences as MemberPreferencesSchema,
} from "@workbench/shared";

// Fetch helper for hub-api routes mounted at /api/ (not /api/v1/).
// These are interchange endpoints — principals, agent instances, sessions.
// Credential and tenant management moved to Interchange admin-ui (CL-1535).

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
  /** When true, call postMe() to provision or push template/grant updates. */
  personalAgentSyncAvailable?: boolean;
  /** Server-persisted UI preferences, folded into the bootstrap to avoid an extra round-trip. */
  preferences?: MemberPreferences;
};

/**
 * Validates the `preferences` blob at the web trust boundary, degrading to an
 * empty map on a malformed payload so a bad server value can never poison the
 * preferences store.
 */
function parseMePreferences(me: MeResponse): MeResponse {
  if (me.preferences === undefined) return me;
  const parsed = MemberPreferencesSchema(me.preferences);
  return { ...me, preferences: parsed instanceof type.errors ? {} : parsed };
}

export async function getMe(): Promise<MeResponse> {
  return parseMePreferences(await hubFetch<MeResponse>("GET", "v1/me"));
}

export type PostMeBody = {
  syncPersonalAgent?: boolean;
};

/** Ensures org membership / Myra and syncs live session grants (safe to repeat). */
export async function postMe(body: PostMeBody = {}): Promise<MeResponse> {
  return parseMePreferences(await hubFetch<MeResponse>("POST", "v1/me", body));
}

/** Merge a partial patch into the caller's persisted UI preferences. */
export async function patchMePreferences(
  patch: Record<string, unknown>,
): Promise<MemberPreferences> {
  return hubFetch<MemberPreferences>("PATCH", "v1/me/preferences", patch);
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

const MyraThreadSchema = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
});
export type MyraThread = typeof MyraThreadSchema.infer;

// List items carry the per-thread `updateAvailable` flag (CL-2518); the
// create/rename/title responses describe a single thread without it.
export const MyraThreadListItemSchema = type({
  id: "string",
  instanceId: "string",
  label: "string",
  createdAt: "string",
  updateAvailable: "boolean",
});
export type MyraThreadListItem = typeof MyraThreadListItemSchema.infer;
const MyraThreadListSchema = type({
  threads: MyraThreadListItemSchema.array(),
});

function myraThreadsBase(tenantId: string): string {
  return `v1/tenants/${encodeURIComponent(tenantId)}/me/myra/threads`;
}

export async function listMyraThreads(
  tenantId: string,
): Promise<MyraThreadListItem[]> {
  const raw = await hubFetch<unknown>("GET", myraThreadsBase(tenantId));
  const parsed = MyraThreadListSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra threads response: ${parsed.summary}`);
  }
  return parsed.threads;
}

const MyraThreadCreateSchema = type({
  thread: MyraThreadSchema,
  created: "true",
});

export async function createMyraThread(
  tenantId: string,
  label?: string,
): Promise<MyraThread> {
  const raw = await hubFetch<unknown>(
    "POST",
    myraThreadsBase(tenantId),
    label !== undefined ? { label } : {},
  );
  const parsed = MyraThreadCreateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra thread create response: ${parsed.summary}`);
  }
  return parsed.thread;
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

const MyraThreadRelaunchSchema = type({
  thread: MyraThreadSchema,
  applied: "boolean",
});

/**
 * Opt-in "Update Myra" for a single old thread (CL-2518): asks the hub to
 * reseed the tenant def if stale and relaunch this thread's session so the
 * latest tools load. `applied` is false when the live session could not be torn
 * down in time — the thread is unchanged and the caller can retry.
 */
export async function relaunchMyraThread(
  tenantId: string,
  id: string,
): Promise<{ thread: MyraThread; applied: boolean }> {
  const raw = await hubFetch<unknown>(
    "POST",
    `${myraThreadsBase(tenantId)}/${encodeURIComponent(id)}/relaunch`,
  );
  const parsed = MyraThreadRelaunchSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra thread relaunch response: ${parsed.summary}`);
  }
  return { thread: parsed.thread, applied: parsed.applied };
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

export type LaunchInstanceSessionResponse = {
  launched: boolean;
  launchError?: string;
};

export async function launchInstanceSession(
  instanceId: string,
): Promise<LaunchInstanceSessionResponse> {
  return hubFetch<LaunchInstanceSessionResponse>(
    "POST",
    `v1/instances/${instanceId}/sessions`,
    {},
  );
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

export const UsageByPersonRowSchema = type({
  principalId: "string",
  name: "string | null",
  isSelf: "boolean",
  turnCount: "number",
  toolCallCount: "number",
  inputTokens: "number",
  outputTokens: "number",
});

export type UsageByPersonRow = typeof UsageByPersonRowSchema.infer;

export const UsageByWorkflowTypeRowSchema = type({
  kind: "string",
  turnCount: "number",
  toolCallCount: "number",
  inputTokens: "number",
  outputTokens: "number",
});

export type UsageByWorkflowTypeRow = typeof UsageByWorkflowTypeRowSchema.infer;

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
  models: ActivityCountRowSchema.array(),
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

export type ActivityOverview = typeof ActivityOverviewSchema.infer;

export async function getActivityOverview(
  tenantId: string,
  opts?: { startDate?: string; endDate?: string },
): Promise<ActivityOverview> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set("startDate", opts.startDate);
  if (opts?.endDate) params.set("endDate", opts.endDate);
  const qs = params.toString();
  const path = `tenants/${encodeURIComponent(tenantId)}/activity/overview${qs ? `?${qs}` : ""}`;
  const raw = await hubFetch<unknown>("GET", path);
  const result = ActivityOverviewSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid activity overview response: ${result.summary}`);
  }
  return result;
}
