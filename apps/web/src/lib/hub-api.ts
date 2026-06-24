import { type } from 'arktype';
import {
  FeedbackListResponse,
  type FeedbackSubjectKind,
  type SavedRating,
} from '@workbench/shared';

// Fetch helper for hub-api routes mounted at /api/ (not /api/v1/).
// These are interchange endpoints — principals, agent instances, sessions.
// Credential and tenant management moved to Interchange admin-ui (CL-1535).

const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? '';

async function hubFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(
    `/api/${path.replace(/^\//, '')}`,
    apiBase || window.location.origin
  ).toString();
  const init: RequestInit = { method, credentials: 'include' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(new Error(err.error || `HTTP ${res.status}`), {
      status: res.status,
    });
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export type Principal = {
  principalId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  kind: 'user' | 'agent';
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
};

export async function getMe(): Promise<MeResponse> {
  return hubFetch<MeResponse>('GET', 'v1/me');
}

export type PostMeBody = {
  syncPersonalAgent?: boolean;
};

/** Ensures org membership / Myra and syncs live session grants (safe to repeat). */
export async function postMe(body: PostMeBody = {}): Promise<MeResponse> {
  return hubFetch<MeResponse>('POST', 'v1/me', body);
}

/** Read-only status; runs postMe when the hub signals an update is available. */
export async function ensureMeSynced(): Promise<MeResponse> {
  const me = await getMe();
  if (me.personalAgentSyncAvailable) {
    return postMe();
  }
  return me;
}

export async function getMyPrincipals(): Promise<Principal[]> {
  const res = await hubFetch<{ data: Principal[] }>('GET', 'me/principals');
  return res.data;
}

export function principalsToWorkbenches(
  principals: Principal[],
  excludeTenantIds: (string | null)[]
): WorkbenchEntry[] {
  const excluded = new Set(excludeTenantIds.filter((id): id is string => id !== null));
  return principals.filter((p) => !excluded.has(p.tenantId)).map(principalToWorkbenchEntry);
}

export async function listWorkbenches(): Promise<WorkbenchEntry[]> {
  const [principals, me] = await Promise.all([getMyPrincipals(), getMe()]);
  const excludeIds = me.rootTenantIds?.length ? me.rootTenantIds : [me.personalTenantId];
  return principalsToWorkbenches(principals, excludeIds);
}

export type CredentialRequirement = {
  providerName: string;
  source: 'tenant' | 'creator' | 'invoker';
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

export async function listAgentInstances(tenantId: string): Promise<AgentInstance[]> {
  const res = await hubFetch<{ data: AgentInstance[] }>(
    'GET',
    `v1/agents?tenantId=${encodeURIComponent(tenantId)}`
  );
  return res.data;
}

export async function deleteAgentInstance(tenantId: string, instanceId: string): Promise<void> {
  await hubFetch<void>('DELETE', `v1/tenants/${tenantId}/agents/instances/${instanceId}`);
}

export type LaunchInstanceSessionResponse = {
  launched: boolean;
  launchError?: string;
};

export async function launchInstanceSession(
  instanceId: string
): Promise<LaunchInstanceSessionResponse> {
  return hubFetch<LaunchInstanceSessionResponse>('POST', `v1/instances/${instanceId}/sessions`, {});
}

export async function stopAgentInstance(tenantId: string, instanceId: string): Promise<void> {
  await hubFetch<void>('DELETE', `v1/tenants/${tenantId}/agents/instances/${instanceId}`);
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
  const res = await hubFetch<{ data: AgentCatalogEntry[] }>('GET', 'v1/agents/templates');
  return res.data;
}

export type { FeedbackSubjectKind, SavedRating };

/**
 * Returns a new ratings list with `next` upserted by (subjectId, subjectKind).
 * Used to keep the feedback query cache consistent with a just-saved rating
 * while the invalidate-driven refetch is in flight, so the displayed pressed
 * state never regresses to a stale value between save and refetch.
 */
export function upsertRating(prev: SavedRating[] | undefined, next: SavedRating): SavedRating[] {
  const without = (prev ?? []).filter(
    (r) => !(r.subjectId === next.subjectId && r.subjectKind === next.subjectKind)
  );
  return [...without, next];
}

export async function getOutputFeedback(instanceId: string): Promise<SavedRating[]> {
  const res = await hubFetch<unknown>('GET', `v1/instances/${instanceId}/feedback`);
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
  rating: 1 | -1
): Promise<void> {
  await hubFetch<void>('POST', `v1/instances/${instanceId}/feedback`, {
    subjectId,
    subjectKind,
    rating,
  });
}

export async function deployAgentFromTemplate(
  tenantId: string,
  templateKey: string
): Promise<DeployAgentResponse> {
  return hubFetch<DeployAgentResponse>('POST', `v1/tenants/${tenantId}/agents/instances`, {
    templateKey,
  });
}

const AnalyticsSummarySchema = type({
  tenantId: 'string',
  turnCount: 'number',
  failedTurnCount: 'number',
  toolCallCount: 'number',
  toolErrorCount: 'number',
  inputTokens: 'number',
  outputTokens: 'number',
  cacheReadTokens: 'number',
  cacheWriteTokens: 'number',
  thinkingTokens: 'number',
});

export type AnalyticsSummary = typeof AnalyticsSummarySchema.infer;

export async function getAnalyticsSummary(
  tenantId: string,
  opts?: { startDate?: string; endDate?: string }
): Promise<AnalyticsSummary> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set('startDate', opts.startDate);
  if (opts?.endDate) params.set('endDate', opts.endDate);
  const qs = params.toString();
  const path = `tenants/${encodeURIComponent(tenantId)}/analytics/summary${qs ? `?${qs}` : ''}`;
  const raw = await hubFetch<unknown>('GET', path);
  const result = AnalyticsSummarySchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid analytics summary response: ${result.summary}`);
  }
  return result;
}

const AnalyticsAgentRowSchema = type({
  agentId: 'string',
  agentName: 'string | null',
  turnCount: 'number',
  failedTurnCount: 'number',
  toolCallCount: 'number',
  toolErrorCount: 'number',
  inputTokens: 'number',
  outputTokens: 'number',
  cacheReadTokens: 'number',
  cacheWriteTokens: 'number',
  thinkingTokens: 'number',
});

const AnalyticsByAgentResponseSchema = type({
  tenantId: 'string',
  agents: AnalyticsAgentRowSchema.array(),
});

export type AnalyticsAgentRow = typeof AnalyticsAgentRowSchema.infer;

export async function getAnalyticsSummaryByAgent(
  tenantId: string,
  opts?: { startDate?: string; endDate?: string }
): Promise<AnalyticsAgentRow[]> {
  const params = new URLSearchParams();
  if (opts?.startDate) params.set('startDate', opts.startDate);
  if (opts?.endDate) params.set('endDate', opts.endDate);
  const qs = params.toString();
  const path = `tenants/${encodeURIComponent(tenantId)}/analytics/summary/by-agent${qs ? `?${qs}` : ''}`;
  const raw = await hubFetch<unknown>('GET', path);
  const result = AnalyticsByAgentResponseSchema(raw);
  if (result instanceof type.errors) {
    throw new Error(`Invalid analytics by-agent response: ${result.summary}`);
  }
  return result.agents;
}
