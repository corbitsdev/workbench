#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Idempotently seeds tenant credentials for all configured integrations.
 *
 * For each entry: creates the provider if it doesn't exist, then creates the
 * credential. 409 on either step is treated as a no-op. Entries without a key
 * set in the environment are skipped silently.
 *
 * Run after seed.ts (requires an authenticated superadmin).
 */

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

const BASE = env('HUB_URL', 'http://localhost:4000') as string;
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com') as string;
const PASSWORD = env('SUPERADMIN_PASS', 'password123') as string;
const TENANT_SLUG = env('GLOBAL_TENANT_SLUG', 'abklabs') as string;
// SESSION_TOKEN: pass a better-auth session cookie value grabbed from the browser.
// Use in production where email/password auth is disabled (OAuth-only).
// In DevTools: Application → Cookies → copy the value of __Secure-better-auth.session_token.
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

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
  console.log(`[seed-credentials] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[seed-credentials] FAIL ${label}: ${status}`);
  console.error(`[seed-credentials]   ${JSON.stringify(data)}`);
  process.exit(1);
}

type CredentialEntry = {
  providerName: string;
  providerPlugin: string;
  credentialName: string;
  secret: string;
  metadata?: Record<string, unknown>;
};

function buildEntries(): CredentialEntry[] {
  const entries: CredentialEntry[] = [];

  // Unnumbered entry (backwards compat).
  const openaiCompatibleKey = env('OPENAI_COMPATIBLE_API_KEY');
  if (openaiCompatibleKey) {
    entries.push({
      providerName: 'openai-compatible',
      providerPlugin: 'openai-compatible',
      credentialName: env('OPENAI_COMPATIBLE_CREDENTIAL_NAME', 'Myra LLM') as string,
      secret: openaiCompatibleKey,
      metadata: {
        model: env('OPENAI_COMPATIBLE_MODEL', 'gpt-4o'),
        baseURL: env('OPENAI_COMPATIBLE_BASE_URL', 'https://api.openai.com/v1'),
        ...(env('OPENAI_COMPATIBLE_MAX_TOKENS')
          ? { maxTokens: Number(env('OPENAI_COMPATIBLE_MAX_TOKENS')) }
          : {}),
      },
    });
  }

  // Numbered entries: OPENAI_COMPATIBLE_API_KEY_1, _2, … until a gap is hit.
  // Each set uses its own CREDENTIAL_NAME, MODEL, BASE_URL, MAX_TOKENS suffixed with _N.
  for (let i = 1; ; i++) {
    const key = env(`OPENAI_COMPATIBLE_API_KEY_${i}`);
    if (!key) break;
    const name = env(`OPENAI_COMPATIBLE_CREDENTIAL_NAME_${i}`);
    if (!name) {
      console.error(
        `[seed-credentials] OPENAI_COMPATIBLE_API_KEY_${i} is set but OPENAI_COMPATIBLE_CREDENTIAL_NAME_${i} is missing — skipping`
      );
      continue;
    }
    entries.push({
      providerName: 'openai-compatible',
      providerPlugin: 'openai-compatible',
      credentialName: name,
      secret: key,
      metadata: {
        model: env(`OPENAI_COMPATIBLE_MODEL_${i}`, 'gpt-4o'),
        baseURL: env(`OPENAI_COMPATIBLE_BASE_URL_${i}`, 'https://api.openai.com/v1'),
        ...(env(`OPENAI_COMPATIBLE_MAX_TOKENS_${i}`)
          ? { maxTokens: Number(env(`OPENAI_COMPATIBLE_MAX_TOKENS_${i}`)) }
          : {}),
      },
    });
  }

  const openaiKey = env('OPENAI_API_KEY');
  if (openaiKey) {
    entries.push({
      providerName: 'openai',
      providerPlugin: 'openai',
      credentialName: 'OpenAI',
      secret: openaiKey,
    });
  }

  const anthropicKey = env('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    entries.push({
      providerName: 'anthropic',
      providerPlugin: 'anthropic',
      credentialName: 'Anthropic',
      secret: anthropicKey,
    });
  }

  const geminiKey = env('GOOGLE_GEMINI_API_KEY');
  if (geminiKey) {
    entries.push({
      providerName: 'google-genai',
      providerPlugin: 'google-genai',
      credentialName: 'Google Gemini',
      secret: geminiKey,
    });
  }

  const granolaKey = env('GRANOLA_API_KEY');
  if (granolaKey) {
    entries.push({
      providerName: 'granola',
      providerPlugin: 'granola',
      credentialName: 'Granola',
      secret: granolaKey,
      metadata: { baseURL: 'https://public-api.granola.ai/v1' },
    });
  }

  const exaKey = env('EXA_API_KEY');
  if (exaKey) {
    entries.push({
      providerName: 'exa',
      providerPlugin: 'exa',
      credentialName: 'Exa',
      secret: exaKey,
    });
  }

  const firecrawlKey = env('FIRECRAWL_API_KEY');
  if (firecrawlKey) {
    entries.push({
      providerName: 'firecrawl',
      providerPlugin: 'firecrawl',
      credentialName: 'Firecrawl',
      secret: firecrawlKey,
    });
  }

  return entries;
}

async function resolveOrCreateProvider(
  tenantId: string,
  entry: CredentialEntry,
  cookies: CookieJar
): Promise<string> {
  // List only tenant-owned providers (inherited=false). Inherited rows belong
  // to ancestor tenants: PATCH rejects them, and a credential created in this
  // tenant binds to this tenant's own provider — so an inherited row that
  // happens to look correct must not mask a stale owned row. Resolution reads
  // baseURL from the provider the credential is bound to, so the owned row is
  // the one that matters.
  const listRes = await api(
    'GET',
    `/api/tenants/${tenantId}/providers?inherited=false`,
    undefined,
    cookies
  );
  if (listRes.status !== 200) fail('list providers', listRes.status, listRes.data);

  const existing = (
    (
      listRes.data as {
        data?: Array<{ id: string; name: string; metadata?: Record<string, unknown> }>;
      }
    ).data ?? []
  ).find((p) => p.name === entry.providerName);

  if (existing) {
    // Always reconcile metadata. Skipping when a row "looks correct" is what let
    // a stale baseURL (api.openai.com) survive and route inference to the wrong
    // endpoint. Merge so unrelated keys are preserved.
    if (entry.metadata) {
      const merged = { ...existing.metadata, ...entry.metadata };
      const changed = Object.entries(merged).some(([k, v]) => existing.metadata?.[k] !== v);
      if (changed) {
        const patch = await api(
          'PATCH',
          `/api/tenants/${tenantId}/providers/${existing.id}`,
          { metadata: merged },
          cookies
        );
        if (patch.status !== 200) {
          fail(`patch provider (${entry.providerName})`, patch.status, patch.data);
        }
        log(`  Updated provider metadata: ${entry.providerName}`);
      }
    }
    return existing.id;
  }

  const createRes = await api(
    'POST',
    `/api/tenants/${tenantId}/providers`,
    { name: entry.providerName, plugin: entry.providerPlugin, metadata: entry.metadata ?? {} },
    cookies
  );

  if (createRes.status === 201) {
    return (createRes.data as { id: string }).id;
  }

  if (createRes.status === 409) {
    const refreshed = await api(
      'GET',
      `/api/tenants/${tenantId}/providers?inherited=false`,
      undefined,
      cookies
    );
    const found = (
      (refreshed.data as { data?: Array<{ id: string; name: string }> }).data ?? []
    ).find((p) => p.name === entry.providerName);
    if (!found) fail(`resolve provider after 409 (${entry.providerName})`, 409, refreshed.data);
    return found.id;
  }

  fail(`create provider (${entry.providerName})`, createRes.status, createRes.data);
}

let cookies: CookieJar;
if (SESSION_TOKEN) {
  log('Using SESSION_TOKEN for authentication');
  cookies = [
    `better-auth.session_token=${SESSION_TOKEN}`,
    `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
  ];
} else {
  const signIn = await api('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
  if (signIn.cookies.length === 0) fail('sign in', signIn.status, signIn.data);
  cookies = signIn.cookies;
  log(`Signed in as ${EMAIL}`);
}

const principalsRes = await api('GET', '/api/me/principals', undefined, cookies);
if (principalsRes.status !== 200)
  fail('/api/me/principals', principalsRes.status, principalsRes.data);

const principals =
  (principalsRes.data as { data?: Array<{ tenantId: string; tenantSlug?: string }> }).data ?? [];
const principal = principals.find((p) => p.tenantSlug === TENANT_SLUG) ?? principals[0];
if (!principal) {
  console.error('[seed-credentials] No tenant principal found');
  process.exit(1);
}
const tenantId = principal.tenantId;
log(`Tenant: ${TENANT_SLUG} (${tenantId})`);

const entries = buildEntries();
if (entries.length === 0) {
  log('No credentials configured — set LLM_API_KEY, GRANOLA_API_KEY, etc. to seed credentials.');
  process.exit(0);
}

const listRes = await api('GET', `/api/tenants/${tenantId}/credentials`, undefined, cookies);
if (listRes.status !== 200) fail('list credentials', listRes.status, listRes.data);
const existingCredentials =
  (listRes.data as { data?: Array<{ id: string; name: string }> }).data ?? [];

for (const entry of entries) {
  const providerId = await resolveOrCreateProvider(tenantId, entry, cookies);
  log(`Provider ${entry.providerName}: ${providerId}`);

  const existing = existingCredentials.find((c) => c.name === entry.credentialName);

  if (existing) {
    const patch = await api(
      'PATCH',
      `/api/tenants/${tenantId}/credentials/${existing.id}`,
      { secret: entry.secret, ...(entry.metadata ? { metadata: entry.metadata } : {}) },
      cookies
    );
    if (patch.status !== 200)
      fail(`patch credential (${entry.credentialName})`, patch.status, patch.data);
    log(`  Updated credential: ${entry.credentialName}`);
  } else {
    const credRes = await api(
      'POST',
      `/api/tenants/${tenantId}/credentials`,
      {
        providerId,
        name: entry.credentialName,
        type: 'api_key',
        secret: entry.secret,
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      },
      cookies
    );
    if (credRes.status !== 201)
      fail(`create credential (${entry.credentialName})`, credRes.status, credRes.data);
    log(`  Created credential: ${entry.credentialName}`);
  }
}

log('Done.');
