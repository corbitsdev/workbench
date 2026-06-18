#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Diagnostic + cross-tenant repair for LLM provider baseURLs.
 *
 * Lists every openai-compatible and anthropic provider across all tenants,
 * its stored baseURL, and the credentials bound to it. This is the
 * cross-tenant correction the per-tenant seed cannot make: an agent resolves
 * its provider from its own tenant, so a stale provider on any tenant breaks
 * inference even when the global tenant is seeded correctly.
 *
 * Pass --fix to rewrite baseURLs:
 *   - openai-compatible: from OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_MODEL.
 *   - anthropic: normalized to the bare host. The Anthropic adapter posts to the
 *     full path /v1/messages, so the baseURL must NOT carry a trailing /v1 — a
 *     stale 'https://api.anthropic.com/v1' yields '/v1/v1/messages' and a 404.
 *
 * Required env: DATABASE_URL (plus OPENAI_COMPATIBLE_BASE_URL only when --fix
 * finds openai-compatible rows to rewrite).
 */

import postgres from 'postgres';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Normalize an anthropic provider baseURL to the bare host the adapter
 * expects. Strips a trailing /v1 (and any trailing slashes) and fills a
 * missing value with the canonical host.
 */
export function normalizeAnthropicBaseURL(current?: string | null): string {
  if (!current) return ANTHROPIC_BASE_URL;
  let value = current.trim();
  while (value.endsWith('/')) value = value.slice(0, -1);
  if (value.endsWith('/v1')) value = value.slice(0, -'/v1'.length);
  return value.length > 0 ? value : ANTHROPIC_BASE_URL;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[diagnose-providers] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

type ProviderRow = {
  id: string;
  tenant_id: string;
  name: string;
  plugin: string;
  metadata: unknown;
};

async function printProvider(sql: postgres.Sql, p: ProviderRow): Promise<void> {
  const md = (p.metadata ?? {}) as Record<string, unknown>;
  console.log(`provider ${p.id}`);
  console.log(`  tenant:  ${p.tenant_id}`);
  console.log(`  plugin:  ${p.plugin}`);
  console.log(`  baseURL: ${md['baseURL'] ?? '(none)'}`);
  if (md['model']) console.log(`  model:   ${md['model']}`);

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

if (import.meta.main) {
  const fix = process.argv.includes('--fix');
  const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

  try {
    const openaiProviders = await sql<ProviderRow[]>`
      select id, tenant_id, name, plugin, metadata
      from provider
      where name = 'openai-compatible' or plugin = 'openai-compatible'
      order by tenant_id
    `;
    const anthropicProviders = await sql<ProviderRow[]>`
      select id, tenant_id, name, plugin, metadata
      from provider
      where name = 'anthropic' or plugin = 'anthropic'
      order by tenant_id
    `;

    console.log(`Found ${openaiProviders.length} openai-compatible provider row(s):\n`);
    for (const p of openaiProviders) await printProvider(sql, p);

    console.log(`Found ${anthropicProviders.length} anthropic provider row(s):\n`);
    for (const p of anthropicProviders) await printProvider(sql, p);

    if (fix) {
      if (openaiProviders.length > 0) {
        const baseURL = requireEnv('OPENAI_COMPATIBLE_BASE_URL');
        const model = process.env['OPENAI_COMPATIBLE_MODEL'];
        console.log(
          `\nFixing openai-compatible baseURL -> ${baseURL}${model ? `, model -> ${model}` : ''}`
        );
        for (const p of openaiProviders) {
          const md = (p.metadata ?? {}) as Record<string, unknown>;
          const next = { ...md, baseURL, ...(model ? { model } : {}) };
          await sql`update provider set metadata = ${sql.json(next)} where id = ${p.id}`;
          console.log(`  Updated provider ${p.id} (tenant ${p.tenant_id})`);
        }
      }

      console.log(`\nNormalizing anthropic baseURL -> ${ANTHROPIC_BASE_URL}`);
      for (const p of anthropicProviders) {
        const md = (p.metadata ?? {}) as Record<string, unknown>;
        const current = typeof md['baseURL'] === 'string' ? (md['baseURL'] as string) : undefined;
        const baseURL = normalizeAnthropicBaseURL(current);
        if (current === baseURL) {
          console.log(`  Skipped provider ${p.id} (already ${baseURL})`);
          continue;
        }
        const next = { ...md, baseURL };
        await sql`update provider set metadata = ${sql.json(next)} where id = ${p.id}`;
        console.log(
          `  Updated provider ${p.id} (tenant ${p.tenant_id}): ${current ?? '(none)'} -> ${baseURL}`
        );
      }

      console.log('\nDone. Re-launch affected agent sessions to pick up the new baseURL.');
    }
  } finally {
    await sql.end();
  }
}
