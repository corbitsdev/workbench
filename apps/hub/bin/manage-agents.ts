#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Browse agents across tenants and stop them.
 *
 * Shows all tenants the signed-in admin belongs to, lists every agent instance
 * in each tenant, and lets you stop specific instances.
 *
 * Usage:
 *   bun manage-agents.ts                          # browse + interactive stop
 *   bun manage-agents.ts --stop ins_xxx           # stop a specific instance (dry-run off)
 *   bun manage-agents.ts --tenant tnt_xxx         # scope to one tenant
 *   bun manage-agents.ts --all-statuses           # include stopped/error instances
 *
 * Auth:
 *   HUB_URL            (default: http://localhost:4000)
 *   SUPERADMIN_EMAIL   (default: alice@example.com)
 *   SUPERADMIN_PASS    (default: password123)
 *   SESSION_TOKEN      (alternative to email/pass)
 */

import { api, env, makeFail, makeLogger, signIn, type CookieJar } from './_lib';

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];

const log = makeLogger('manage-agents');
const fail = makeFail('manage-agents');

const stopFlagIndex = process.argv.indexOf('--stop');
const STOP_INSTANCE_ID = stopFlagIndex !== -1 ? process.argv[stopFlagIndex + 1] : undefined;
const tenantFlagIndex = process.argv.indexOf('--tenant');
const SCOPE_TENANT_ID = tenantFlagIndex !== -1 ? process.argv[tenantFlagIndex + 1] : undefined;
const ALL_STATUSES = process.argv.includes('--all-statuses');

type AgentInstanceRow = {
  id: string;
  agentId: string;
  agentName: string;
  tenantId: string;
  address: string;
  status: string;
  createdAt: string;
};

type PrincipalRow = {
  id: string;
  kind: string;
  tenantId: string;
  displayName?: string;
};

type TenantRow = {
  id: string;
  slug: string;
  name: string;
};

async function getMe(cookies: CookieJar): Promise<{ tenants: TenantRow[] }> {
  const meRes = await api(BASE, 'GET', '/api/v1/me', undefined, cookies);
  if (meRes.status !== 200) fail('/api/v1/me', meRes.status, meRes.data);
  const me = meRes.data as { personalTenantId: string | null };
  if (!me.personalTenantId) fail('/api/v1/me', 200, 'no personalTenantId');

  const globalTenantId = me.personalTenantId as string;

  // List the admin's own principals in the global org tenant to discover workbench tenants.
  const prinRes = await api(
    BASE,
    'GET',
    `/api/tenants/${globalTenantId}/principals`,
    undefined,
    cookies
  );
  if (prinRes.status !== 200) fail('list principals', prinRes.status, prinRes.data);
  const principals = (prinRes.data as { data: PrincipalRow[] }).data ?? [];

  // Collect all distinct tenantIds: global first, then workbench child tenants.
  const workbenchTenantIds = [
    ...new Set(
      principals
        .filter((p) => p.kind === 'user' && p.tenantId !== globalTenantId)
        .map((p) => p.tenantId)
    ),
  ];

  const tenants: TenantRow[] = [
    { id: globalTenantId, slug: 'global', name: 'Global org' },
    ...workbenchTenantIds.map((id) => ({ id, slug: id, name: id })),
  ];

  return { tenants };
}

async function listInstances(tenantId: string, cookies: CookieJar): Promise<AgentInstanceRow[]> {
  const res = await api(BASE, 'GET', `/api/v1/agents?tenantId=${tenantId}`, undefined, cookies);
  if (res.status !== 200) {
    log(`  Could not list agents for tenant ${tenantId}: ${res.status}`);
    return [];
  }
  const rows = (res.data as { data: AgentInstanceRow[] }).data ?? [];
  if (ALL_STATUSES) return rows;
  return rows.filter((r) => r.status !== 'stopped');
}

async function stopInstance(
  tenantId: string,
  instanceId: string,
  cookies: CookieJar
): Promise<void> {
  const res = await api(
    BASE,
    'DELETE',
    `/api/tenants/${tenantId}/agents/instances/${instanceId}`,
    undefined,
    cookies
  );
  if (res.status === 200 || res.status === 204) {
    log(`  Stopped ${instanceId}`);
  } else {
    log(`  Failed to stop ${instanceId}: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: '● running ',
    deployed: '○ deployed',
    updating: '↻ updating',
    error: '✗ error   ',
    stopped: '■ stopped ',
  };
  return map[status] ?? status.padEnd(9);
}

async function main() {
  const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);

  // If --stop is passed, stop that instance directly (requires --tenant or we scan for it)
  if (STOP_INSTANCE_ID) {
    if (!SCOPE_TENANT_ID) {
      log('--stop requires --tenant <tenantId>');
      process.exit(1);
    }
    await stopInstance(SCOPE_TENANT_ID, STOP_INSTANCE_ID, cookies);
    return;
  }

  const { tenants } = await getMe(cookies);

  const scoped = SCOPE_TENANT_ID
    ? tenants.filter((t) => t.id === SCOPE_TENANT_ID || t.slug === SCOPE_TENANT_ID)
    : tenants;

  if (scoped.length === 0) {
    log('No tenants found (or --tenant value did not match).');
    return;
  }

  const allInstances: Array<AgentInstanceRow & { tenantSlug: string; tenantName: string }> = [];

  for (const tenant of scoped) {
    const instances = await listInstances(tenant.id, cookies);
    console.log(`\nTenant: ${tenant.name} (${tenant.slug})  [${tenant.id}]`);
    if (instances.length === 0) {
      console.log('  (no instances)');
      continue;
    }
    for (const inst of instances) {
      allInstances.push({ ...inst, tenantSlug: tenant.slug, tenantName: tenant.name });
      console.log(
        `  [${statusLabel(inst.status)}]  ${inst.agentName.padEnd(12)}  ${inst.id}  ${inst.address}`
      );
    }
  }

  if (allInstances.length === 0) {
    log('No instances found.');
    return;
  }

  // Interactive stop prompt
  console.log('\n---');
  console.log(
    'To stop an instance, re-run with:\n  bun manage-agents.ts --tenant <tenantId> --stop <instanceId>'
  );
  console.log('\nRunning instances by tenant:');
  const running = allInstances.filter((i) => i.status === 'running' || i.status === 'deployed');
  for (const inst of running) {
    console.log(
      `  --tenant ${inst.tenantId} --stop ${inst.id}  # ${inst.agentName} @ ${inst.tenantSlug}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
