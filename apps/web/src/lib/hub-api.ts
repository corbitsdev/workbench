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
  kind: 'user' | 'agent';
  status: string;
  roles: { id: string; name: string }[];
};

export type TenantResponse = {
  id: string;
  name: string;
  slug: string;
  domain: string;
};

export async function getMyPrincipals(): Promise<Principal[]> {
  const res = await hubFetch<{ items: Principal[] }>('GET', 'me/principals');
  return res.items;
}

export async function createTenant(name: string, slug: string): Promise<TenantResponse> {
  return hubFetch<TenantResponse>('POST', 'tenants', { name, slug });
}
