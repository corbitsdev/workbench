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
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
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
  credentialResolved: boolean;
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
  createdAt: string;
};

export async function assignCredentialToAgent(
  tenantId: string,
  agentId: string,
  credentialId: string | null
): Promise<void> {
  await hubFetch<unknown>('PATCH', `v1/tenants/${tenantId}/agents/${agentId}/credential`, {
    credentialId,
  });
}

export async function listAgentInstances(tenantId: string): Promise<AgentInstance[]> {
  const res = await hubFetch<{ data: AgentInstance[] }>(
    'GET',
    `v1/agents?tenantId=${encodeURIComponent(tenantId)}`
  );
  return res.data;
}

export type LLMProviderType = 'anthropic' | 'openai' | 'google-genai' | 'openai-compatible';

export type CreateTenantCredentialInput = {
  provider: string;
  name: string;
  apiKey: string;
  model?: string;
  baseURL?: string;
};

export type CreateTenantCredentialResponse = {
  credentialId: string;
  providerId: string;
};

export async function createTenantCredential(
  tenantId: string,
  input: CreateTenantCredentialInput
): Promise<CreateTenantCredentialResponse> {
  return hubFetch<CreateTenantCredentialResponse>(
    'POST',
    `v1/tenants/${tenantId}/credentials`,
    input
  );
}

export async function deleteTenantCredential(
  tenantId: string,
  credentialId: string
): Promise<void> {
  await hubFetch<void>('DELETE', `tenants/${tenantId}/credentials/${credentialId}`);
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

export type ProvisionAgentInput = {
  tenantId: string;
  name: string;
  systemPrompt: string;
};

export type ProvisionAgentResponse = {
  instanceId: string;
  agentId: string;
  agentName: string;
  tenantId: string;
  launched: boolean;
  launchError?: string;
};

export async function provisionAgent(input: ProvisionAgentInput): Promise<ProvisionAgentResponse> {
  return hubFetch<ProvisionAgentResponse>('POST', 'v1/agents', input);
}

export type EnrichedCredential = {
  id: string;
  name: string;
  tenantId: string;
  providerPlugin: string;
  providerName: string;
  providerId: string;
  status: string;
  baseURL: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type UpdateTenantCredentialInput = {
  name?: string;
  apiKey?: string;
  model?: string;
  baseURL?: string;
};

export async function updateTenantCredential(
  tenantId: string,
  credentialId: string,
  input: UpdateTenantCredentialInput
): Promise<void> {
  await hubFetch<{ credentialId: string }>(
    'PATCH',
    `v1/tenants/${tenantId}/credentials/${credentialId}`,
    input
  );
}

export async function listEnrichedCredentials(tenantId: string): Promise<EnrichedCredential[]> {
  const res = await hubFetch<{ data: EnrichedCredential[] }>(
    'GET',
    `v1/tenants/${tenantId}/credentials`
  );
  return res.data;
}
