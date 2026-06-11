#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Backfill `ended_at` on orphaned agent sessions (CL-1651).
 *
 * Before the relaunch fix, `launchAgentSession` ended superseded sessions by
 * setting `status = 'ended'` but never stamping `ended_at`, leaving hundreds of
 * rows with `status = 'ended'` and `ended_at IS NULL`. This one-time migration
 * stamps `ended_at` from the best timestamp available (`updated_at`) so those
 * rows carry an end time.
 *
 * Idempotent: only touches rows where `status = 'ended' AND ended_at IS NULL`,
 * so it is safe to re-run.
 *
 * Required env vars:
 *   DATABASE_URL — Postgres connection string
 *
 * Usage:
 *   DATABASE_URL=... bun apps/hub/bin/backfill-session-ended-at.ts
 */

import postgres from 'postgres';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[backfill-session-ended-at] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function log(message: string) {
  console.log(`[backfill-session-ended-at] ${message}`);
}

const sql = postgres(requireEnv('DATABASE_URL'), { max: 1 });

try {
  const [before] = await sql<{ count: string }[]>`
    select count(*) as count
    from agent_session
    where status = 'ended' and ended_at is null
  `;
  log(`Found ${before?.count ?? '0'} ended session(s) missing ended_at`);

  const updated = await sql<{ id: string }[]>`
    update agent_session
    set ended_at = updated_at
    where status = 'ended' and ended_at is null
    returning id
  `;

  log(`Stamped ended_at on ${updated.length} session(s). Done.`);
} finally {
  await sql.end();
}
