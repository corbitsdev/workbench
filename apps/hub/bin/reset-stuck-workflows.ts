#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Reset workflows wedged in an in-progress status by a hung inference call
 * (CL-1922). Before the inference timeout, a slow or unreachable LLM provider
 * left `agent.send` pending forever, pinning the run in `analyzing`/`generating`
 * with no recovery.
 *
 * Recovery mirrors the in-app reset (resolveResetStatus): `generating` returns
 * to `running` (pain points already exist, so the user re-selects and
 * regenerates); `analyzing` has no usable partial output, so it goes to
 * `failed`.
 *
 * Only touches runs whose `updated_at` is older than STUCK_MINUTES so a
 * legitimately in-flight step is never interrupted. Idempotent and safe to
 * re-run.
 *
 * Required env vars:
 *   DATABASE_URL — Postgres connection string
 * Optional env vars:
 *   STUCK_MINUTES — minimum age in minutes before a run is considered stuck (default 15)
 *
 * Usage:
 *   DATABASE_URL=... bun apps/hub/bin/reset-stuck-workflows.ts
 *   DATABASE_URL=... STUCK_MINUTES=30 bun apps/hub/bin/reset-stuck-workflows.ts
 */

import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[reset-stuck-workflows] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[reset-stuck-workflows] ${message}`);
}

const stuckMinutesRaw = process.env['STUCK_MINUTES'];
const stuckMinutes = stuckMinutesRaw ? Number(stuckMinutesRaw) : 15;
if (!Number.isFinite(stuckMinutes) || stuckMinutes < 0) {
  console.error(`[reset-stuck-workflows] Invalid STUCK_MINUTES: ${stuckMinutesRaw}`);
  process.exit(1);
}

const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  const cutoff = `${stuckMinutes} minutes`;

  const generating = await sql<{ id: string }[]>`
    update workflow_run
    set status = 'running'
    where status = 'generating' and updated_at < now() - ${cutoff}::interval
    returning id
  `;
  log(`Reset ${generating.length} stuck 'generating' run(s) -> 'running'`);

  const analyzing = await sql<{ id: string }[]>`
    update workflow_run
    set status = 'failed'
    where status = 'analyzing' and updated_at < now() - ${cutoff}::interval
    returning id
  `;
  log(`Reset ${analyzing.length} stuck 'analyzing' run(s) -> 'failed'`);

  log(`Done. Total reset: ${generating.length + analyzing.length}.`);
} finally {
  await sql.end();
}
