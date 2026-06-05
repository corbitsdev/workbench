// Fetch helper for hub-api routes mounted at /api/ (not /api/v1/).
// These are interchange endpoints — tenant management, principals, etc.

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
    throw Object.assign(new Error(err.error || `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

export type Principal = {
  id: string;
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

export type TenantResponse = {
  id: string;
  name: string;
  slug: string;
  domain: string;
};

export type MeResponse = {
  userId: string;
  userName: string;
  personalTenantId: string | null;
  paInstanceId: string | null;
  provisioned: boolean;
};

export async function getMe(): Promise<MeResponse> {
  return hubFetch<MeResponse>('GET', 'v1/me');
}

export async function getMyPrincipals(): Promise<Principal[]> {
  const res = await hubFetch<{ data: Principal[] }>('GET', 'me/principals');
  return res.data;
}

export async function createTenant(name: string, slug: string): Promise<TenantResponse> {
  return hubFetch<TenantResponse>('POST', 'tenants', { name, slug });
}

export type WorkspaceResponse = {
  id: string;
  name: string;
  slug: string;
  tenantId: string;
};

export async function createWorkspace(name: string): Promise<WorkspaceResponse> {
  return hubFetch<WorkspaceResponse>('POST', 'v1/workspaces', { name });
}

export async function listWorkbenches(): Promise<WorkbenchEntry[]> {
  const principals = await getMyPrincipals();
  return principals
    .filter((p) => !p.tenantSlug.startsWith('user-'))
    .map(({ id, tenantId, tenantSlug, tenantName }) => ({ id, tenantId, tenantSlug, tenantName }));
}

export type TenantDetailResponse = {
  id: string;
  name: string;
  slug: string;
  domain: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrincipalDetail = {
  id: string;
  tenantId: string;
  kind: 'user' | 'agent';
  refId: string;
  displayName: string;
  email?: string;
  status: 'active' | 'suspended' | 'invited' | 'deactivated';
  roles: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
};

export type CredentialDetail = {
  id: string;
  tenantId: string;
  providerId: string;
  principalId?: string | null;
  name: string;
  type: 'api_key' | 'oauth_token' | 'certificate' | 'other';
  description?: string | null;
  status: 'active' | 'expired' | 'revoked' | 'error';
  scopes?: string[] | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GrantDetail = {
  id: string;
  tenantId: string;
  roleId?: string | null;
  roleName?: string | null;
  principalId?: string | null;
  principalName?: string | null;
  resource: string;
  action: string;
  effect: 'allow' | 'deny' | 'ask';
  origin: 'system' | 'role' | 'creator' | 'invoker';
  expiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function getTenant(tenantId: string): Promise<TenantDetailResponse> {
  return hubFetch<TenantDetailResponse>('GET', `tenants/${tenantId}`);
}

export async function listTenantPrincipals(tenantId: string): Promise<PrincipalDetail[]> {
  const res = await hubFetch<{ data: PrincipalDetail[] }>(
    'GET',
    `tenants/${tenantId}/principals?limit=100`
  );
  return res.data;
}

export async function getPrincipal(
  tenantId: string,
  principalId: string
): Promise<PrincipalDetail> {
  return hubFetch<PrincipalDetail>('GET', `tenants/${tenantId}/principals/${principalId}`);
}

export async function listTenantCredentials(tenantId: string): Promise<CredentialDetail[]> {
  const res = await hubFetch<{ data: CredentialDetail[] }>(
    'GET',
    `tenants/${tenantId}/credentials?limit=100`
  );
  return res.data;
}

export async function listPrincipalGrants(
  tenantId: string,
  principalId: string
): Promise<GrantDetail[]> {
  const res = await hubFetch<{ data: GrantDetail[] }>(
    'GET',
    `tenants/${tenantId}/grants?limit=100&principalId=${encodeURIComponent(principalId)}`
  );
  return res.data;
}

export type AgentInstance = {
  id: string;
  agentId: string;
  agentName: string;
  tenantId: string;
  address: string;
  status: string;
  createdAt: string;
};

export async function listAgentInstances(tenantId: string): Promise<AgentInstance[]> {
  const res = await hubFetch<{ data: AgentInstance[] }>(
    'GET',
    `v1/agents?tenantId=${encodeURIComponent(tenantId)}`
  );
  return res.data;
}

export type LLMProviderInput = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export type ProvisionOatInput = {
  type: 'oat';
  scope: 'workspace';
  tenantId: string;
  credentialIds: string[];
};

export type ProvisionMyraInput = {
  type: 'myra';
  scope: 'personal';
  tenantId: string;
  llm: LLMProviderInput;
};

export type ProvisionAgentInput = ProvisionOatInput | ProvisionMyraInput;

export type ProvisionAgentResponse = {
  instanceId: string;
  agentId: string;
  agentName: string;
  tenantId: string;
};

export async function provisionAgent(input: ProvisionAgentInput): Promise<ProvisionAgentResponse> {
  return hubFetch<ProvisionAgentResponse>('POST', 'v1/agents', input);
}
