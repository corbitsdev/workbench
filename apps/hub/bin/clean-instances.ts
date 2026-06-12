#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Interactive agent instance cleanup tool.
 *
 * Lists tenants, lets you pick one, shows all instances, and lets you stop
 * them one by one or all at once — without re-running the script.
 *
 * Flags (all optional — if omitted the script prompts interactively):
 *   --tenant <id>   skip tenant selection and go straight to instance list
 *   --stop-all      after selecting a tenant, stop all active instances without prompting
 *
 * Env:
 *   DATABASE_URL      — Postgres connection string (required; used to list all tenants)
 *   HUB_URL           (default: http://localhost:4000)
 *   SUPERADMIN_EMAIL  (default: alice@example.com)
 *   SUPERADMIN_PASS   (default: password123)
 *   SESSION_TOKEN     (alternative to email/pass)
 */

import * as readline from 'readline';
import postgres from 'postgres';
import { api, env, makeFail, makeLogger, signIn, type CookieJar } from './_lib';

const BASE = env('HUB_URL', 'http://localhost:4000');
const EMAIL = env('SUPERADMIN_EMAIL', 'alice@example.com');
const PASSWORD = env('SUPERADMIN_PASS', 'password123');
const SESSION_TOKEN = process.env['SESSION_TOKEN'];
const DATABASE_URL = process.env['DATABASE_URL'];

const log = makeLogger('clean-instances');
const fail = makeFail('clean-instances');

const tenantFlagIdx = process.argv.indexOf('--tenant');
const FLAG_TENANT = tenantFlagIdx !== -1 ? process.argv[tenantFlagIdx + 1] : undefined;
const FLAG_STOP_ALL = process.argv.includes('--stop-all');

type Instance = {
  id: string;
  agentName: string;
  tenantId: string;
  address: string;
  status: string;
  createdAt: string;
};

type Tenant = { id: string; name: string };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function statusTag(status: string): string {
  const tags: Record<string, string> = {
    running: 'RUNNING ',
    deployed: 'DEPLOYED',
    error:   'ERROR   ',
    stopped: 'STOPPED ',
  };
  return tags[status] ?? status.slice(0, 8).padEnd(8).toUpperCase();
}

async function listTenants(_cookies: CookieJar): Promise<Tenant[]> {
  if (!DATABASE_URL) {
    fail('listTenants', 0, 'DATABASE_URL is required to list all tenants');
  }
  const sql = postgres(DATABASE_URL as string, { max: 1 });
  try {
    const rows = await sql<Array<{ id: string; name: string; slug: string }>>`
      SELECT id, name, slug FROM tenant ORDER BY created_at ASC
    `;
    return rows.map((r) => ({ id: r.id, name: r.name || r.slug || r.id }));
  } finally {
    await sql.end();
  }
}

async function listInstances(tenantId: string, cookies: CookieJar): Promise<Instance[]> {
  const res = await api(BASE, 'GET', `/api/v1/agents?tenantId=${tenantId}`, undefined, cookies);
  if (res.status !== 200) {
    log(`Could not list instances for ${tenantId}: ${res.status}`);
    return [];
  }
  return (res.data as { data: Instance[] }).data ?? [];
}

async function stopInstance(tenantId: string, instanceId: string, cookies: CookieJar): Promise<boolean> {
  const res = await api(BASE, 'DELETE', `/api/tenants/${tenantId}/agents/instances/${instanceId}`, undefined, cookies);
  const ok = res.status === 200 || res.status === 204;
  console.log(ok ? `  ✓ stopped ${instanceId}` : `  ✗ failed  ${instanceId} (${res.status})`);
  return ok;
}

function printInstances(instances: Instance[]): void {
  if (instances.length === 0) {
    console.log('  (no instances)');
    return;
  }
  instances.forEach((inst, i) => {
    console.log(`  ${String(i + 1).padStart(2)}.  [${statusTag(inst.status)}]  ${inst.agentName.padEnd(14)}  ${inst.id}  ${inst.address}`);
  });
}

async function handleTenant(tenant: Tenant, cookies: CookieJar): Promise<void> {
  console.log(`\nFetching instances for: ${tenant.name}  [${tenant.id}]`);
  const instances = await listInstances(tenant.id, cookies);
  const active = instances.filter((i) => i.status !== 'stopped');

  console.log(`\nAll instances (${instances.length} total, ${active.length} active):`);
  printInstances(instances);

  if (active.length === 0) {
    console.log('\nNothing to stop.');
    return;
  }

  if (FLAG_STOP_ALL) {
    console.log(`\nStopping all ${active.length} active instance(s)...`);
    for (const inst of active) await stopInstance(inst.tenantId, inst.id, cookies);
    return;
  }

  console.log('\nOptions:');
  console.log('  all       — stop all active instances');
  console.log('  1,3,5     — stop by number (comma-separated)');
  console.log('  ins_...   — stop by instance ID');
  console.log('  done      — go back to tenant list');
  console.log('  q         — quit');

  while (true) {
    const input = await ask('\n> ');

    if (input === 'q') { rl.close(); process.exit(0); }
    if (input === 'done' || input === '') break;

    if (input === 'all') {
      console.log(`Stopping ${active.length} instance(s)...`);
      for (const inst of active) await stopInstance(inst.tenantId, inst.id, cookies);
      break;
    }

    // By instance ID
    if (input.startsWith('ins_')) {
      const inst = instances.find((i) => i.id === input);
      if (!inst) { console.log('  Instance not found.'); continue; }
      await stopInstance(inst.tenantId, inst.id, cookies);
      continue;
    }

    // By number(s)
    const nums = input.split(',').map((s) => parseInt(s.trim(), 10));
    if (nums.every((n) => !isNaN(n))) {
      for (const n of nums) {
        const inst = instances[n - 1];
        if (!inst) { console.log(`  No instance at position ${n}.`); continue; }
        if (inst.status === 'stopped') { console.log(`  ${inst.agentName} is already stopped.`); continue; }
        await stopInstance(inst.tenantId, inst.id, cookies);
      }
      continue;
    }

    console.log('  Unrecognised input.');
  }
}

async function main() {
  const cookies = await signIn(BASE, EMAIL, PASSWORD, SESSION_TOKEN, log, fail);
  const tenants = await listTenants(cookies);

  if (FLAG_TENANT) {
    const tenant = tenants.find((t) => t.id === FLAG_TENANT || t.name === FLAG_TENANT);
    if (!tenant) { log(`Tenant not found: ${FLAG_TENANT}`); process.exit(1); }
    await handleTenant(tenant, cookies);
    rl.close();
    return;
  }

  while (true) {
    console.log('\nTenants:');
    tenants.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}.  ${t.id}  ${t.name}`));
    console.log('\n  Enter a number, tenant ID, or q to quit.');

    const input = await ask('\n> ');
    if (input === 'q' || input === '') break;

    let tenant: Tenant | undefined;
    const n = parseInt(input, 10);
    if (!isNaN(n)) {
      tenant = tenants[n - 1];
    } else {
      tenant = tenants.find((t) => t.id === input || t.name === input);
    }

    if (!tenant) { console.log('  Not found.'); continue; }
    await handleTenant(tenant, cookies);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
