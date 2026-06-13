#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Repair `baseURL` on the firecrawl provider metadata (CL-1654 follow-up).
 *
 * Interchange resolves a provider's baseURL from the `provider` row's `metadata`
 * jsonb (see @intx/db credential-resolution), and the firecrawl tools validate
 * it with `new URL(...)` at init (packages/tools-firecrawl resolveConfig). Two
 * bad states break firecrawl tools:
 *
 *   1. baseURL absent — the UI marks the field optional, so the row is created
 *      without one and resolution defaults/fails depending on the path.
 *   2. baseURL present but malformed — a user typed a scheme-less host like
 *      `api.firecrawl.dev/v2` in the UI. `new URL()` throws and every firecrawl
 *      tool dies with "Firecrawl baseUrl must be a valid URL". The earlier
 *      null-only backfill skipped these because the value is not missing.
 *
 * This stamps the default Firecrawl API base URL onto any firecrawl provider
 * row whose baseURL is absent OR not a parseable URL, leaving valid rows
 * untouched. Provider metadata is plaintext config (not the encrypted
 * credential secret), so this is a safe jsonb merge.
 *
 * Idempotent: a valid baseURL is never rewritten, so it is safe to re-run.
 *
 * Required env vars:
 *   DATABASE_URL — Postgres connection string
 *
 * Optional env vars:
 *   FIRECRAWL_BASE_URL — override the default (https://api.firecrawl.dev/v2)
 *
 * Usage:
 *   DATABASE_URL=... bun apps/hub/bin/backfill-firecrawl-baseurl.ts
 */

import postgres from 'postgres';

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev/v2';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[backfill-firecrawl-baseurl] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[backfill-firecrawl-baseurl] ${message}`);
}

function isValidUrl(value: string | null): boolean {
  if (value === null) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const baseURL = process.env['FIRECRAWL_BASE_URL'] ?? DEFAULT_BASE_URL;
const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  const rows = await sql<{ id: string; tenant_id: string; base_url: string | null }[]>`
    select id, tenant_id, metadata ->> 'baseURL' as base_url
    from provider
    where name = 'firecrawl'
  `;
  log(`Found ${rows.length} firecrawl provider row(s)`);

  const broken = rows.filter((row) => !isValidUrl(row.base_url));
  log(`${broken.length} row(s) have a missing or invalid baseURL`);

  for (const row of broken) {
    await sql`
      update provider
      set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{baseURL}', ${JSON.stringify(baseURL)}::jsonb, true)
      where id = ${row.id}
    `;
    log(
      `Set baseURL=${baseURL} on provider ${row.id} (tenant ${row.tenant_id}, was ${JSON.stringify(row.base_url)})`
    );
  }
  log(`Repaired ${broken.length} firecrawl provider row(s). Done.`);
} finally {
  await sql.end();
}
