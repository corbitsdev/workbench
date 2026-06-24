#!/usr/bin/env bun
/* eslint-disable no-console */

/**
 * Backfill `agent_session` + `agent_instance.session_id` for workflow supervisor
 * rows that were deployed before CL-2301 persistence. Analytics drops events when
 * session_id is NULL.
 *
 *   bun run apps/hub/bin/backfill-analytics-sessions.ts --tenant <slug> [--dry-run] [--yes]
 *
 * Requires DATABASE_URL (or .env loaded by caller).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, isNull, like } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import { generateId } from '@intx/hub-common';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipConfirm = args.includes('--yes');
const tenantSlugIdx = args.indexOf('--tenant');
const tenantSlug = tenantSlugIdx >= 0 ? args[tenantSlugIdx + 1] : process.env['WORKBENCH_SLUG'];

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('[backfill-analytics-sessions] DATABASE_URL is required');
  process.exit(1);
}

const sqlClient = postgres(databaseUrl);
const db = drizzle(sqlClient, { schema: intxSchema });

async function main(): Promise<void> {
  if (!tenantSlug) {
    console.error('[backfill-analytics-sessions] Pass --tenant <slug> or set WORKBENCH_SLUG');
    process.exit(1);
  }
  const tenant = await db.query.tenant.findFirst({
    where: eq(intxSchema.tenant.slug, tenantSlug),
  });
  if (!tenant) {
    console.error(`[backfill-analytics-sessions] Unknown tenant slug: ${tenantSlug}`);
    process.exit(1);
  }
  console.log(`[backfill-analytics-sessions] Tenant ${tenant.slug} (${tenant.id})`);

  const rows = await db
    .select({
      instanceId: intxSchema.agentInstance.id,
      agentId: intxSchema.agentInstance.agentId,
      principalId: intxSchema.agentInstance.principalId,
      address: intxSchema.agentInstance.address,
      agentName: intxSchema.agent.name,
    })
    .from(intxSchema.agentInstance)
    .innerJoin(intxSchema.agent, eq(intxSchema.agentInstance.agentId, intxSchema.agent.id))
    .where(
      and(
        eq(intxSchema.agentInstance.tenantId, tenant.id),
        isNull(intxSchema.agentInstance.sessionId),
        isNull(intxSchema.agentInstance.endedAt),
        like(intxSchema.agent.name, 'supervisor-%')
      )
    );

  if (rows.length === 0) {
    console.log('[backfill-analytics-sessions] No supervisor instances need backfill.');
    await sqlClient.end();
    return;
  }

  console.log(`[backfill-analytics-sessions] Found ${rows.length} supervisor instance(s):`);
  for (const row of rows) {
    console.log(`  - ${row.instanceId} (${row.agentName}) @ ${row.address}`);
  }

  if (dryRun) {
    console.log('[backfill-analytics-sessions] --dry-run: no writes.');
    await sqlClient.end();
    return;
  }

  if (!skipConfirm) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Apply backfill? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('[backfill-analytics-sessions] Aborted.');
      await sqlClient.end();
      return;
    }
  }

  const now = new Date();
  for (const row of rows) {
    const sessionId = generateId('session');
    await db.insert(intxSchema.agentSession).values({
      id: sessionId,
      tenantId: tenant.id,
      agentId: row.agentId,
      principalId: row.principalId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(intxSchema.agentInstance)
      .set({ sessionId, updatedAt: now })
      .where(eq(intxSchema.agentInstance.id, row.instanceId));
    console.log(`[backfill-analytics-sessions] ${row.instanceId} → ${sessionId}`);
  }

  console.log(
    '[backfill-analytics-sessions] Done. Re-deploy or re-establish workflows so sidecar harness sessionId matches if events still drop.'
  );
  await sqlClient.end();
}

main().catch((err) => {
  console.error('[backfill-analytics-sessions] Fatal:', err);
  process.exit(1);
});
