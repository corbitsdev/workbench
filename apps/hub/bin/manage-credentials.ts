#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Manage tenant credentials against a running hub.
 *
 * Usage:
 *   bun manage-credentials.ts list
 *   bun manage-credentials.ts delete <credential-name>
 *   bun manage-credentials.ts add-llm
 *
 * Auth:
 *   HUB_URL            (default: http://localhost:4000)
 *   SUPERADMIN_EMAIL   (default: alice@example.com)
 *   SUPERADMIN_PASS    (default: password123)
 *   GLOBAL_TENANT_SLUG (default: abklabs)
 *   SESSION_TOKEN      (alternative to email/pass)
 */

import { createInterface } from 'node:readline/promises';
import { api, env, makeFail, makeLogger, signIn, type CookieJar } from './_lib';

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const TENANT_SLUG = env('GLOBAL_TENANT_SLUG', 'abklabs');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

const log = makeLogger('manage-credentials');
const fail = makeFail('manage-credentials');

const INFERENCE_PLUGINS = new Set(['openai-compatible', 'anthropic', 'google-genai', 'openai']);

type CredentialRow = {
  id: string;
  name: string;
  providerId: string;
  createdAt: string;
};

type ProviderRow = {
  id: string;
  name: string;
  plugin: string;
  metadata?: Record<string, unknown>;
};

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function resolveTenant(cookies: CookieJar): Promise<string> {
  const res = await api(BASE, 'GET', '/api/me/principals', undefined, cookies);
  if (res.status !== 200) fail('/api/me/principals', res.status, res.data);
  const principals =
    (res.data as { data?: Array<{ tenantId: string; tenantSlug?: string }> }).data ?? [];
  const match = principals.find((p) => p.tenantSlug === TENANT_SLUG) ?? principals[0];
  if (!match) {
    console.error('[manage-credentials] No tenant principal found');
    process.exit(1);
  }
  log(`Tenant: ${TENANT_SLUG} (${match.tenantId})`);
  return match.tenantId;
}

async function fetchCredentials(tenantId: string, cookies: CookieJar): Promise<CredentialRow[]> {
  const res = await api(BASE, 'GET', `/api/tenants/${tenantId}/credentials`, undefined, cookies);
  if (res.status !== 200) fail('list credentials', res.status, res.data);
  return (res.data as { data?: CredentialRow[] }).data ?? [];
}

async function fetchProviders(tenantId: string, cookies: CookieJar): Promise<ProviderRow[]> {
  const res = await api(
    BASE,
    'GET',
    `/api/tenants/${tenantId}/providers?inherited=false`,
    undefined,
    cookies
  );
  if (res.status !== 200) fail('list providers', res.status, res.data);
  return (res.data as { data?: ProviderRow[] }).data ?? [];
}

async function resolveOrCreateProvider(
  tenantId: string,
  name: string,
  plugin: string,
  metadata: Record<string, unknown>,
  cookies: CookieJar
): Promise<string> {
  const providers = await fetchProviders(tenantId, cookies);
  const existing = providers.find((p) => p.name === name);

  if (existing) {
    if (Object.keys(metadata).length > 0) {
      const merged = { ...existing.metadata, ...metadata };
      const changed = Object.entries(merged).some(([k, v]) => existing.metadata?.[k] !== v);
      if (changed) {
        const patch = await api(
          BASE,
          'PATCH',
          `/api/tenants/${tenantId}/providers/${existing.id}`,
          { metadata: merged },
          cookies
        );
        if (patch.status !== 200) fail(`patch provider (${name})`, patch.status, patch.data);
        log(`Updated provider metadata: ${name}`);
      }
    }
    return existing.id;
  }

  const res = await api(
    BASE,
    'POST',
    `/api/tenants/${tenantId}/providers`,
    { name, plugin, metadata },
    cookies
  );
  if (res.status === 201) return (res.data as { id: string }).id;
  if (res.status === 409) {
    const refreshed = await fetchProviders(tenantId, cookies);
    const found = refreshed.find((p) => p.name === name);
    if (!found) fail(`resolve provider after 409 (${name})`, 409, res.data);
    return found.id;
  }
  fail(`create provider (${name})`, res.status, res.data);
}

async function cmdList(tenantId: string, cookies: CookieJar): Promise<void> {
  const [credentials, providers] = await Promise.all([
    fetchCredentials(tenantId, cookies),
    fetchProviders(tenantId, cookies),
  ]);

  const providerById = new Map(providers.map((p) => [p.id, p]));

  const llm: Array<{ cred: CredentialRow; provider: ProviderRow }> = [];
  const tools: Array<{ cred: CredentialRow; provider: ProviderRow }> = [];

  for (const cred of credentials) {
    const provider = providerById.get(cred.providerId);
    if (!provider) continue;
    const bucket = INFERENCE_PLUGINS.has(provider.plugin) ? llm : tools;
    bucket.push({ cred, provider });
  }

  const fmt = (rows: Array<{ cred: CredentialRow; provider: ProviderRow }>) => {
    if (rows.length === 0) {
      console.log('  (none)');
      return;
    }
    for (const { cred, provider } of rows) {
      const baseURL = (provider.metadata?.['baseURL'] as string | undefined) ?? '';
      const model = (provider.metadata?.['model'] as string | undefined) ?? '';
      const details = [provider.plugin, baseURL, model].filter(Boolean).join(' · ');
      console.log(`  ${cred.name}  [${cred.id}]`);
      console.log(`    ${details}`);
    }
  };

  console.log('\nLLM Credentials');
  console.log('───────────────');
  fmt(llm);

  console.log('\nTool Credentials');
  console.log('────────────────');
  fmt(tools);
  console.log('');
}

async function cmdDelete(
  credentialName: string,
  tenantId: string,
  cookies: CookieJar
): Promise<void> {
  const credentials = await fetchCredentials(tenantId, cookies);
  const cred = credentials.find((c) => c.name === credentialName);
  if (!cred) {
    console.error(`[manage-credentials] Credential not found: ${credentialName}`);
    process.exit(1);
  }

  const confirm = await prompt(
    `Delete credential "${cred.name}" (${cred.id})? Type "yes" to confirm: `
  );
  if (confirm !== 'yes') {
    log('Aborted.');
    return;
  }

  const res = await api(
    BASE,
    'DELETE',
    `/api/tenants/${tenantId}/credentials/${cred.id}`,
    undefined,
    cookies
  );
  if (res.status !== 200 && res.status !== 204) {
    fail(`delete credential (${credentialName})`, res.status, res.data);
  }
  log(`Deleted: ${cred.name}`);
}

async function cmdAddLlm(tenantId: string, cookies: CookieJar): Promise<void> {
  console.log('\nAdd LLM Credential');
  console.log('──────────────────');

  const name = await prompt('Credential name (e.g. opencode-zen): ');
  if (!name) {
    console.error('[manage-credentials] Name is required');
    process.exit(1);
  }

  const pluginInput = await prompt(
    'Plugin [openai-compatible / anthropic] (default: openai-compatible): '
  );
  const plugin = pluginInput || 'openai-compatible';
  if (plugin !== 'openai-compatible' && plugin !== 'anthropic') {
    console.error(`[manage-credentials] Invalid plugin: ${plugin}`);
    process.exit(1);
  }

  const apiKey = await prompt('API key: ');
  if (!apiKey) {
    console.error('[manage-credentials] API key is required');
    process.exit(1);
  }

  const defaultBaseURL =
    plugin === 'anthropic' ? 'https://api.anthropic.com' : 'https://openrouter.ai/api/v1';
  const baseURLInput = await prompt(`Base URL (default: ${defaultBaseURL}): `);
  const baseURL = baseURLInput || defaultBaseURL;

  const modelInput = await prompt(
    plugin === 'anthropic'
      ? 'Model (e.g. claude-sonnet-4-5, leave blank to skip): '
      : 'Model (e.g. deepseek-v4-flash, leave blank to skip): '
  );

  const metadata: Record<string, unknown> = { baseURL };
  if (modelInput) metadata['model'] = modelInput;

  const providerId = await resolveOrCreateProvider(tenantId, plugin, plugin, metadata, cookies);
  log(`Provider ${plugin}: ${providerId}`);

  const credentials = await fetchCredentials(tenantId, cookies);
  const existing = credentials.find((c) => c.name === name);

  if (existing) {
    const patch = await api(
      BASE,
      'PATCH',
      `/api/tenants/${tenantId}/credentials/${existing.id}`,
      { secret: apiKey, metadata },
      cookies
    );
    if (patch.status !== 200) fail(`patch credential (${name})`, patch.status, patch.data);
    log(`Updated credential: ${name}`);
  } else {
    const res = await api(
      BASE,
      'POST',
      `/api/tenants/${tenantId}/credentials`,
      { providerId, name, type: 'api_key', secret: apiKey, metadata },
      cookies
    );
    if (res.status !== 201) fail(`create credential (${name})`, res.status, res.data);
    log(`Created credential: ${name}`);
  }
}

if (import.meta.main) {
  const subcommand = process.argv[2];

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    console.log('Usage:');
    console.log('  bun manage-credentials.ts list');
    console.log('  bun manage-credentials.ts delete <credential-name>');
    console.log('  bun manage-credentials.ts add-llm');
    process.exit(0);
  }

  const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);
  const tenantId = await resolveTenant(cookies);

  if (subcommand === 'list') {
    await cmdList(tenantId, cookies);
  } else if (subcommand === 'delete') {
    const credName = process.argv[3];
    if (!credName) {
      console.error('[manage-credentials] Usage: delete <credential-name>');
      process.exit(1);
    }
    await cmdDelete(credName, tenantId, cookies);
  } else if (subcommand === 'add-llm') {
    await cmdAddLlm(tenantId, cookies);
  } else {
    console.error(`[manage-credentials] Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}
