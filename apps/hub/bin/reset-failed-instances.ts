#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Detects agent instances whose stored credentialRequirements contain non-inference
 * providers (e.g. firecrawl) that cause sidecar reconnect failures.
 *
 * Run with --reset to delete the broken instances so they can be redeployed.
 * Without --reset, defaults to dry-run mode.
 *
 * SCOPE LIMITATION: The list endpoint only returns instances that the authenticated
 * user deployed, and excludes personal-template instances (e.g. Myra). To reset a
 * specific known-broken instance regardless of scope, pass --instance-id <id>.
 *
 * Usage:
 *   bun reset-failed-instances.ts                            # dry-run scan
 *   bun reset-failed-instances.ts --reset                    # scan and delete
 *   bun reset-failed-instances.ts --instance-id ins_xxx      # delete specific instance
 *   bun reset-failed-instances.ts --instance-id ins_xxx --reset
 */

// Known inference providers registered in the Interchange sidecar inference registry.
// Source of truth: interchange/apps/sidecar/src/ — update this list when the sidecar
// adds or removes an inference provider plugin.
const INFERENCE_PROVIDERS = new Set([
  'openai',
  'openai-compatible',
  'anthropic',
  'google-genai',
  'xai',
]);

function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

const BASE = env('HUB_URL', 'http://localhost:4000') as string;
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com') as string;
const PASSWORD = env('SUPERADMIN_PASS', 'password123') as string;
const TENANT_SLUG = env('GLOBAL_TENANT_SLUG', 'abklabs') as string;
const SESSION_TOKEN = process.env['SESSION_TOKEN'];
const DRY_RUN = !process.argv.includes('--reset');

const instanceIdFlagIndex = process.argv.indexOf('--instance-id');
const DIRECT_INSTANCE_ID =
  instanceIdFlagIndex !== -1 ? process.argv[instanceIdFlagIndex + 1] : undefined;

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
  console.log(`[reset-failed-instances] ${message}`);
}

function fail(label: string, status: number, data: unknown): never {
  console.error(`[reset-failed-instances] FAIL ${label}: ${status}`);
  console.error(`[reset-failed-instances]   ${JSON.stringify(data)}`);
  process.exit(1);
}

async function deleteInstance(tenantId: string, instanceId: string, cookies: CookieJar) {
  const deleteRes = await api(
    'DELETE',
    `/api/tenants/${tenantId}/agents/instances/${instanceId}`,
    undefined,
    cookies
  );
  if (deleteRes.status !== 200 && deleteRes.status !== 204) {
    console.error(
      `[reset-failed-instances] WARN Failed to delete ${instanceId}: ${deleteRes.status}`
    );
  } else {
    log(`Deleted ${instanceId}`);
  }
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
  if (signIn.status < 200 || signIn.status >= 300 || signIn.cookies.length === 0) {
    fail('sign in', signIn.status, signIn.data);
  }
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
  console.error('[reset-failed-instances] No tenant principal found');
  process.exit(1);
}
const tenantId = principal.tenantId;
log(`Tenant: ${TENANT_SLUG} (${tenantId})`);

if (DIRECT_INSTANCE_ID !== undefined) {
  log(`Direct mode: targeting instance ${DIRECT_INSTANCE_ID}`);
  if (DRY_RUN) {
    log(`(dry-run) Would delete ${DIRECT_INSTANCE_ID}`);
  } else {
    await deleteInstance(tenantId, DIRECT_INSTANCE_ID, cookies);
  }
  log('Done.');
  process.exit(0);
}

log(
  'NOTE: scan only covers instances deployed by the authenticated user (excludes personal agents).'
);
log('To reset a specific instance directly, pass --instance-id <id>.');

const instancesRes = await api(
  'GET',
  `/api/agents?tenantId=${encodeURIComponent(tenantId)}`,
  undefined,
  cookies
);
if (instancesRes.status !== 200) fail('list instances', instancesRes.status, instancesRes.data);

type InstanceRow = {
  id: string;
  address: string;
  credentialRequirements: Array<{ providerName: string; source: string; name?: string }>;
};

const instances = ((instancesRes.data as { data?: InstanceRow[] }).data ?? []) as InstanceRow[];
log(`Checking ${instances.length} instances...`);

let brokenCount = 0;
let healthyCount = 0;

for (const instance of instances) {
  const badProviders = instance.credentialRequirements
    .map((r) => r.providerName)
    .filter((name) => !INFERENCE_PROVIDERS.has(name));

  if (badProviders.length === 0) {
    healthyCount++;
    continue;
  }

  brokenCount++;
  log(`BROKEN ${instance.address} — ${badProviders.join(', ')} in credentialRequirements`);

  if (DRY_RUN) {
    log(`(dry-run) Would delete ${instance.id}`);
  } else {
    await deleteInstance(tenantId, instance.id, cookies);
  }
}

log(`Done. ${brokenCount} broken, ${healthyCount} healthy.`);
