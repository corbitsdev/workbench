#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Releases stale Browserbase sessions. A backstop beyond the per-session create
 * timeout: if an agent abandons a session (crash, eviction, dropped turn), this
 * closes any RUNNING session older than the max age so paid sessions never leak
 * indefinitely.
 *
 * Run on a schedule (cron / Railway):
 *   BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... \
 *     bun run apps/hub/bin/reap-browser-sessions.ts
 *
 * REAP_MAX_AGE_SECONDS (default 1800) controls the age ceiling.
 */
import { reapStaleSessions, resolveConfig } from '@workbench/tools-browser';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[reap-browser-sessions] missing ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('BROWSERBASE_API_KEY');
  const projectId = requireEnv('BROWSERBASE_PROJECT_ID');
  const maxAgeSeconds = Number(process.env['REAP_MAX_AGE_SECONDS'] ?? '1800');
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    console.error('[reap-browser-sessions] REAP_MAX_AGE_SECONDS must be a positive number');
    process.exit(1);
  }

  const config = resolveConfig({ apiKey, projectId });
  const { reaped, skipped } = await reapStaleSessions(
    config,
    maxAgeSeconds * 1000,
    Date.now(),
    new AbortController().signal
  );
  console.log(
    `[reap-browser-sessions] released ${reaped.length} stale session(s)` +
      (reaped.length > 0 ? `: ${reaped.join(', ')}` : '') +
      (skipped.length > 0 ? ` — skipped ${skipped.length} with no parseable age` : '')
  );
}

await main();
