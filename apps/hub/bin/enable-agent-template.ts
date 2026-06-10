#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Adds one or more agent template keys to the global tenant's
 * `enabledAgentTemplates` config, making them visible in the "Add Agent"
 * catalog. Idempotent — safe to run multiple times.
 *
 * Required env vars:
 *   DATABASE_URL        — Postgres connection string
 *   GLOBAL_TENANT_SLUG  — slug of the global org tenant (e.g. "corbits")
 *
 * Usage:
 *   DATABASE_URL=... GLOBAL_TENANT_SLUG=... bun run apps/hub/bin/enable-agent-template.ts hammy
 *   DATABASE_URL=... GLOBAL_TENANT_SLUG=... bun run apps/hub/bin/enable-agent-template.ts hammy walter freddy
 */

import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[enable-agent-template] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[enable-agent-template] ${message}`);
}

const keysToAdd = process.argv.slice(2);
if (keysToAdd.length === 0) {
  console.error('[enable-agent-template] Usage: bun run enable-agent-template.ts <key> [key ...]');
  process.exit(1);
}

const globalTenantSlug = requireEnv('GLOBAL_TENANT_SLUG');
const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  const [row] = await sql<{ id: string; config: unknown }[]>`
    select id, config from tenant
    where slug = ${globalTenantSlug}
    limit 1
  `;
  if (!row) {
    console.error(`[enable-agent-template] Global tenant (slug=${globalTenantSlug}) not found.`);
    process.exit(1);
  }

  const existing: unknown = row.config;
  const currentKeys: string[] =
    existing &&
    typeof existing === 'object' &&
    Array.isArray((existing as Record<string, unknown>)['enabledAgentTemplates'])
      ? ((existing as Record<string, unknown>)['enabledAgentTemplates'] as string[])
      : ['myra'];

  log(`Current enabledAgentTemplates: [${currentKeys.join(', ')}]`);

  const merged = [...new Set([...currentKeys, ...keysToAdd])];
  log(`Updated enabledAgentTemplates: [${merged.join(', ')}]`);

  const updatedConfig = {
    ...(existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {}),
    enabledAgentTemplates: merged,
  };

  await sql`
    update tenant
    set config = ${sql.json(updatedConfig)}
    where id = ${row.id}
  `;

  log('Done.');
} finally {
  await sql.end();
}
