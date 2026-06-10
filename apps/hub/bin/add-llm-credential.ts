#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Add a local LLM credential through standard Interchange API routes.
 *
 * Requires the dev user to have owner/admin grants. Run seed:superadmin first.
 */

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
// SESSION_TOKEN: pass a better-auth session cookie value grabbed from the browser.
// Use this in production where email/password auth is disabled (OAuth-only).
// In DevTools: Application → Cookies → copy the value of the `better-auth.session_token` cookie.
const SESSION_TOKEN = process.env['SESSION_TOKEN'];
const TENANT_SLUG = env('GLOBAL_TENANT_SLUG', 'abklabs');
const PROVIDER_NAME = env('LLM_PROVIDER_NAME', 'openai-compatible');
const CREDENTIAL_NAME = env(
  'OPENAI_COMPATIBLE_CREDENTIAL_NAME',
  env('LLM_CREDENTIAL_NAME', 'Myra LLM')
);
const LLM_API_KEY = env(
  'OPENAI_COMPATIBLE_API_KEY',
  env('LLM_API_KEY', 'sk-dummy-key-for-local-dev')
);
const LLM_MODEL = env('OPENAI_COMPATIBLE_MODEL', env('LLM_MODEL', 'gpt-4o'));
const LLM_BASE_URL = env(
  'OPENAI_COMPATIBLE_BASE_URL',
  env('LLM_BASE_URL', 'https://api.openai.com/v1')
);

type CookieJar = string[];

async function api(
  method: string,
  path: string,
  body?: unknown,
  cookies: CookieJar = []
): Promise<{ status: number; data: unknown; cookies: CookieJar }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookies.length > 0) headers['Cookie'] = cookies.join('; ');

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const nextCookies = [...cookies];
  for (const sc of res.headers.getSetCookie()) {
    const name = sc.split('=')[0];
    const value = sc.split(';')[0];
    if (!name || !value) continue;
    const idx = nextCookies.findIndex((c) => c.startsWith(`${name}=`));
    if (idx >= 0) nextCookies[idx] = value;
    else nextCookies.push(value);
  }

  let data: unknown = null;
  if ((res.headers.get('content-type') ?? '').includes('json')) data = await res.json();
  return { status: res.status, data, cookies: nextCookies };
}

function log(message: string) {
  console.log(`[credential] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[credential] FAIL ${label}: ${status}`);
  console.error(`[credential]   ${JSON.stringify(data)}`);
  process.exit(1);
}

let sessionCookies: CookieJar;
if (SESSION_TOKEN) {
  log('Using SESSION_TOKEN for authentication');
  // Production (HTTPS) uses the __Secure- prefix; include both so it works in both environments.
  sessionCookies = [
    `better-auth.session_token=${SESSION_TOKEN}`,
    `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
  ];
} else {
  const signIn = await api('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  if (signIn.cookies.length === 0) fail('sign in', signIn.status, signIn.data);
  sessionCookies = signIn.cookies;
}

const principalsRes = await api('GET', '/api/me/principals', undefined, sessionCookies);
if (principalsRes.status !== 200)
  fail('/api/me/principals', principalsRes.status, principalsRes.data);

const principals =
  (principalsRes.data as { data?: Array<{ tenantId: string; tenantSlug?: string }> }).data ?? [];
const principal = principals.find((p) => p.tenantSlug === TENANT_SLUG) ?? principals[0];
if (!principal) {
  console.error('[credential] No tenant principal found for signed-in user');
  process.exit(1);
}
const tenantId = principal.tenantId;
log(`Tenant ID: ${tenantId}`);

const providersRes = await api(
  'GET',
  `/api/tenants/${tenantId}/providers?inherited=true`,
  undefined,
  sessionCookies
);
if (providersRes.status !== 200) fail('list providers', providersRes.status, providersRes.data);

let provider = (
  (providersRes.data as { data?: Array<{ id: string; name: string }> }).data ?? []
).find((p) => p.name === PROVIDER_NAME);

if (!provider) {
  const createProvider = await api(
    'POST',
    `/api/tenants/${tenantId}/providers`,
    {
      name: PROVIDER_NAME,
      plugin: PROVIDER_NAME,
      metadata: { baseURL: LLM_BASE_URL, model: LLM_MODEL },
    },
    sessionCookies
  );

  if (createProvider.status !== 201 && createProvider.status !== 409) {
    fail('create provider', createProvider.status, createProvider.data);
  }

  if (createProvider.status === 201) {
    provider = createProvider.data as { id: string; name: string };
  } else {
    const refreshed = await api(
      'GET',
      `/api/tenants/${tenantId}/providers?inherited=true`,
      undefined,
      sessionCookies
    );
    provider = ((refreshed.data as { data?: Array<{ id: string; name: string }> }).data ?? []).find(
      (p) => p.name === PROVIDER_NAME
    );
  }
}

if (!provider) {
  console.error(`[credential] Could not resolve provider ${PROVIDER_NAME}`);
  process.exit(1);
}
log(`Provider ID: ${provider.id}`);

const listCredentials = await api(
  'GET',
  `/api/tenants/${tenantId}/credentials`,
  undefined,
  sessionCookies
);
if (listCredentials.status !== 200)
  fail('list credentials', listCredentials.status, listCredentials.data);

const existingCredential = (
  (listCredentials.data as { data?: Array<{ id: string; name: string }> }).data ?? []
).find((c) => c.name === CREDENTIAL_NAME);

if (existingCredential) {
  const patch = await api(
    'PATCH',
    `/api/tenants/${tenantId}/credentials/${existingCredential.id}`,
    { secret: LLM_API_KEY, metadata: { model: LLM_MODEL, baseURL: LLM_BASE_URL } },
    sessionCookies
  );
  if (patch.status !== 200) fail('patch credential', patch.status, patch.data);
  log(`Credential updated: ${existingCredential.id}`);
} else {
  const createCredential = await api(
    'POST',
    `/api/tenants/${tenantId}/credentials`,
    {
      providerId: provider.id,
      name: CREDENTIAL_NAME,
      type: 'api_key',
      secret: LLM_API_KEY,
      scopes: ['chat'],
      metadata: { model: LLM_MODEL, baseURL: LLM_BASE_URL },
    },
    sessionCookies
  );
  if (createCredential.status !== 201)
    fail('create credential', createCredential.status, createCredential.data);
  log(`Credential created: ${(createCredential.data as { id?: string }).id ?? CREDENTIAL_NAME}`);
}

// Patch any agent definitions in this tenant that are missing modelConfig.
log('Patching agent modelConfig...');
const agentsRes = await api(
  'GET',
  `/api/tenants/${tenantId}/agents/definitions`,
  undefined,
  sessionCookies
);
if (agentsRes.status !== 200) fail('list agents', agentsRes.status, agentsRes.data);

const agents =
  (agentsRes.data as { data?: Array<{ id: string; name: string; modelConfig?: unknown }> }).data ??
  [];
for (const a of agents) {
  const patch = await api(
    'PATCH',
    `/api/tenants/${tenantId}/agents/definitions/${a.id}`,
    { modelConfig: { defaultModel: LLM_MODEL } },
    sessionCookies
  );
  if (patch.status !== 200) {
    console.error(`[credential] WARN: failed to patch modelConfig on ${a.name}: ${patch.status}`);
  } else {
    log(`  Patched modelConfig on ${a.name}`);
  }
}
