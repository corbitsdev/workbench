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
};

export async function getMe(): Promise<MeResponse> {
  return hubFetch<MeResponse>('GET', 'v1/me');
}

export async function getMyPrincipals(): Promise<Principal[]> {
  const res = await hubFetch<{ data: Principal[] }>('GET', 'me/principals');
  return res.data;
}

export type WorkbenchResponse = {
  id: string;
  name: string;
  slug: string;
  tenantId: string;
};

export async function createWorkbench(name: string): Promise<WorkbenchResponse> {
  return hubFetch<WorkbenchResponse>('POST', 'v1/workbenches', { name });
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
};

export async function listAgentTemplates(): Promise<AgentCatalogEntry[]> {
  const res = await hubFetch<{ data: AgentCatalogEntry[] }>('GET', 'v1/agents/templates');
  return res.data;
}

export async function deployAgentFromTemplate(
  tenantId: string,
  templateKey: string
): Promise<DeployAgentResponse> {
  return hubFetch<DeployAgentResponse>('POST', `v1/tenants/${tenantId}/agents/instances`, {
    templateKey,
  });
}
