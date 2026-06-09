#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Diagnostic: lists every openai-compatible provider across all tenants, its
 * stored baseURL, and the credentials bound to it. Reveals stale providers
 * pointing at api.openai.com that resolution would use instead of the zen
 * endpoint.
 *
 * Pass --fix to rewrite every openai-compatible provider's baseURL (and model)
 * from OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_MODEL in the environment.
 * This is the cross-tenant correction the per-tenant seed cannot make: an
 * agent resolves its provider from its own tenant, so a stale provider on any
 * tenant breaks inference even when the global tenant is seeded correctly.
 *
 * Required env: DATABASE_URL (plus OPENAI_COMPATIBLE_BASE_URL when --fix)
 */

import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[diagnose-providers] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const fix = process.argv.includes('--fix');
const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  const providers = await sql<
    { id: string; tenant_id: string; name: string; plugin: string; metadata: unknown }[]
  >`
    select id, tenant_id, name, plugin, metadata
    from provider
    where name = 'openai-compatible' or plugin = 'openai-compatible'
    order by tenant_id
  `;

  console.log(`Found ${providers.length} openai-compatible provider row(s):\n`);

  for (const p of providers) {
    const md = (p.metadata ?? {}) as Record<string, unknown>;
    console.log(`provider ${p.id}`);
    console.log(`  tenant:  ${p.tenant_id}`);
    console.log(`  baseURL: ${md['baseURL'] ?? '(none)'}`);
    console.log(`  model:   ${md['model'] ?? '(none)'}`);

    const creds = await sql<{ id: string; name: string; tenant_id: string; status: string }[]>`
      select id, name, tenant_id, status
      from credential
      where provider_id = ${p.id}
    `;
    if (creds.length === 0) {
      console.log('  credentials: (none bound)');
    } else {
      for (const c of creds) {
        console.log(`  credential ${c.id} name="${c.name}" status=${c.status} tenant=${c.tenant_id}`);
      }
    }
    console.log('');
  }

  if (fix) {
    const baseURL = requireEnv('OPENAI_COMPATIBLE_BASE_URL');
    const model = process.env['OPENAI_COMPATIBLE_MODEL'];
    console.log(`Fixing baseURL -> ${baseURL}${model ? `, model -> ${model}` : ''}\n`);

    for (const p of providers) {
      const md = (p.metadata ?? {}) as Record<string, unknown>;
      const next = { ...md, baseURL, ...(model ? { model } : {}) };
      await sql`
        update provider
        set metadata = ${sql.json(next)}
        where id = ${p.id}
      `;
      console.log(`  Updated provider ${p.id} (tenant ${p.tenant_id})`);
    }
    console.log('\nDone. Re-launch affected agent sessions to pick up the new baseURL.');
  }
} finally {
  await sql.end();
}
