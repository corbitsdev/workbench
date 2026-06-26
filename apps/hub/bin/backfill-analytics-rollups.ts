#!/usr/bin/env bun

/**
 * Rebuild `analytics_rollup_daily` from authoritative sources.
 *
 * The analytics subscriber only began recording live `agent.event`s once it was
 * deployed; every turn before that produced `inference_turn` / `turn_part` rows
 * but no rollup, so the Insights dashboard (which reads only
 * `analytics_rollup_daily`) shows nothing for that history.
 *
 * Each daily bucket is rebuilt from its authoritative source:
 *
 *   - LIVE buckets (an `analytics_event` row exists for the key): recomputed
 *     straight from `analytics_event` — identical to what the subscriber
 *     incrementally maintains, including real token counts. This is the source
 *     of truth and is never approximated.
 *   - HISTORY buckets (no `analytics_event` for the key): reconstructed from
 *     `inference_turn` (+ `turn_part` for tool calls). NOTE the unit differs:
 *     the live `turn_count` is message runs (`message.run.ended`, one per user
 *     message), while `inference_turn` is one row per inference step — a
 *     tool-use loop yields several. Historical `turn_count` is therefore an
 *     activity proxy that can exceed the live definition. Token counts and
 *     tool_error_count were never persisted historically and are 0 for these
 *     buckets.
 *
 * The two never mix within a bucket, and the rebuild SETs absolute values, so it
 * is fully deterministic and idempotent. Future live events continue to
 * increment on top of the recomputed base consistently.
 *
 *   bun run apps/hub/bin/backfill-analytics-rollups.ts [--tenant <slug>] [--apply]
 *
 * Defaults to a dry-run preview. Requires DATABASE_URL.
 */

import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, sql as dsql } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { analyticsRollupDaily } from "@workbench/analytics";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const tenantSlugIdx = args.indexOf("--tenant");
const tenantSlug = tenantSlugIdx >= 0 ? args[tenantSlugIdx + 1] : undefined;

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("[backfill-analytics-rollups] DATABASE_URL is required");
  process.exit(1);
}

const sqlClient = postgres(databaseUrl);
const db = drizzle(sqlClient, { schema: intxSchema });

type RollupRow = {
  tenant_id: string;
  agent_id: string;
  instance_id: string;
  model: string | null;
  bucket_date: string;
  source: "live" | "history";
  turn_count: number;
  failed_turn_count: number;
  tool_call_count: number;
  tool_error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  thinking_tokens: number;
};

function rollupId(): string {
  return `ard_${randomBytes(16).toString("hex")}`;
}

// Mirrors the subscriber's rollupKey: tenant:agent:instance:model:bucketDate.
function rollupKey(row: RollupRow): string {
  return [
    row.tenant_id,
    row.agent_id,
    row.instance_id,
    row.model ?? "",
    row.bucket_date,
  ].join(":");
}

async function main(): Promise<void> {
  let tenantId: string | undefined;
  if (tenantSlug) {
    const tenant = await db.query.tenant.findFirst({
      where: eq(intxSchema.tenant.slug, tenantSlug),
    });
    if (!tenant) {
      console.error(
        `[backfill-analytics-rollups] Unknown tenant slug: ${tenantSlug}`,
      );
      process.exit(1);
    }
    tenantId = tenant.id;
    console.log(
      `[backfill-analytics-rollups] Scoped to tenant ${tenant.slug} (${tenant.id})`,
    );
  } else {
    console.log("[backfill-analytics-rollups] All tenants");
  }

  // live: authoritative aggregation straight from analytics_event, keyed and
  //       bucketed exactly as the subscriber does.
  // hist: inference_turn proxy, only for keys with no analytics_event row.
  // The COALESCE prefers live; history fills the gaps.
  const rows = await sqlClient<RollupRow[]>`
    WITH live AS (
      SELECT
        tenant_id, agent_id, instance_id, coalesce(model, '') AS model,
        to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket_date,
        count(*) FILTER (WHERE event_type = 'turn_completed')::int AS turn_count,
        count(*) FILTER (WHERE event_type = 'turn_failed')::int    AS failed_turn_count,
        count(*) FILTER (WHERE event_type = 'tool_call')::int       AS tool_call_count,
        count(*) FILTER (WHERE event_type = 'tool_call' AND status = 'error')::int AS tool_error_count,
        coalesce(sum(input_tokens)  FILTER (WHERE event_type = 'inference_done'), 0)::bigint AS input_tokens,
        coalesce(sum(output_tokens) FILTER (WHERE event_type = 'inference_done'), 0)::bigint AS output_tokens,
        coalesce(sum(cache_read_tokens)  FILTER (WHERE event_type = 'inference_done'), 0)::bigint AS cache_read_tokens,
        coalesce(sum(cache_write_tokens) FILTER (WHERE event_type = 'inference_done'), 0)::bigint AS cache_write_tokens,
        coalesce(sum(thinking_tokens) FILTER (WHERE event_type = 'inference_done'), 0)::bigint AS thinking_tokens
      FROM analytics_event
      WHERE agent_id IS NOT NULL AND instance_id IS NOT NULL
        ${tenantId ? sqlClient`AND tenant_id = ${tenantId}` : sqlClient``}
      GROUP BY tenant_id, agent_id, instance_id, coalesce(model, ''),
               to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    ),
    turn_tools AS (
      SELECT tp.turn_id, count(*)::int AS tool_calls
      FROM turn_part tp
      WHERE tp.type = 'tool' AND tp.metadata->>'kind' = 'call'
      GROUP BY tp.turn_id
    ),
    hist AS (
      SELECT
        it.tenant_id, ai.agent_id, it.instance_id, coalesce(it.model, '') AS model,
        to_char((coalesce(it.ended_at, it.started_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket_date,
        count(*) FILTER (WHERE it.status = 'completed')::int AS turn_count,
        count(*) FILTER (WHERE it.status = 'failed')::int    AS failed_turn_count,
        coalesce(sum(tt.tool_calls), 0)::int                 AS tool_call_count
      FROM inference_turn it
      JOIN agent_instance ai ON ai.id = it.instance_id
      LEFT JOIN turn_tools tt ON tt.turn_id = it.id
      WHERE it.status IN ('completed', 'failed')
        ${tenantId ? sqlClient`AND it.tenant_id = ${tenantId}` : sqlClient``}
      GROUP BY it.tenant_id, ai.agent_id, it.instance_id, coalesce(it.model, ''),
               to_char((coalesce(it.ended_at, it.started_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    )
    SELECT
      coalesce(l.tenant_id, h.tenant_id)     AS tenant_id,
      coalesce(l.agent_id, h.agent_id)       AS agent_id,
      coalesce(l.instance_id, h.instance_id) AS instance_id,
      nullif(coalesce(l.model, h.model), '') AS model,
      coalesce(l.bucket_date, h.bucket_date) AS bucket_date,
      CASE WHEN l.tenant_id IS NOT NULL THEN 'live' ELSE 'history' END AS source,
      coalesce(l.turn_count, h.turn_count)               AS turn_count,
      coalesce(l.failed_turn_count, h.failed_turn_count) AS failed_turn_count,
      coalesce(l.tool_call_count, h.tool_call_count)     AS tool_call_count,
      coalesce(l.tool_error_count, 0)                    AS tool_error_count,
      coalesce(l.input_tokens, 0)        AS input_tokens,
      coalesce(l.output_tokens, 0)       AS output_tokens,
      coalesce(l.cache_read_tokens, 0)   AS cache_read_tokens,
      coalesce(l.cache_write_tokens, 0)  AS cache_write_tokens,
      coalesce(l.thinking_tokens, 0)     AS thinking_tokens
    FROM live l
    FULL OUTER JOIN hist h
      ON l.tenant_id = h.tenant_id AND l.agent_id = h.agent_id
     AND l.instance_id = h.instance_id AND l.model = h.model
     AND l.bucket_date = h.bucket_date
    ORDER BY bucket_date
  `;

  if (rows.length === 0) {
    console.log("[backfill-analytics-rollups] No turns or events found.");
    await sqlClient.end();
    return;
  }

  const live = rows.filter((r) => r.source === "live");
  const hist = rows.filter((r) => r.source === "history");
  const sumTurns = (rs: RollupRow[]) =>
    rs.reduce((a, r) => a + r.turn_count, 0);

  console.log(
    `[backfill-analytics-rollups] ${rows.length} bucket(s): ` +
      `${live.length} live (${sumTurns(live)} turns, authoritative from analytics_event), ` +
      `${hist.length} history (${sumTurns(hist)} turns, inference_turn proxy).`,
  );
  console.log(
    "[backfill-analytics-rollups] History buckets: tokens & tool_error_count are 0 " +
      "(never persisted); turn_count is an inference-step proxy, not message runs.",
  );

  if (!apply) {
    for (const r of hist.slice(0, 10)) {
      console.log(
        `  [history] ${r.bucket_date} agent=${r.agent_id} inst=${r.instance_id} ` +
          `turns=${r.turn_count} failed=${r.failed_turn_count} tools=${r.tool_call_count}`,
      );
    }
    if (hist.length > 10)
      console.log(`  … ${hist.length - 10} more history buckets`);
    console.log(
      "[backfill-analytics-rollups] Dry run. Re-run with --apply to write.",
    );
    await sqlClient.end();
    return;
  }

  const values = rows.map((r) => ({
    id: rollupId(),
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    instanceId: r.instance_id,
    model: r.model,
    bucketDate: r.bucket_date,
    rollupKey: rollupKey(r),
    turnCount: r.turn_count,
    failedTurnCount: r.failed_turn_count,
    toolCallCount: r.tool_call_count,
    toolErrorCount: r.tool_error_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    thinkingTokens: r.thinking_tokens,
  }));

  // SET absolute values: the rebuild is the source of truth for every bucket it
  // computes. updatedAt bumped so the write is observable.
  const written = await db
    .insert(analyticsRollupDaily)
    .values(values)
    .onConflictDoUpdate({
      target: analyticsRollupDaily.rollupKey,
      set: {
        turnCount: dsql`excluded.turn_count`,
        failedTurnCount: dsql`excluded.failed_turn_count`,
        toolCallCount: dsql`excluded.tool_call_count`,
        toolErrorCount: dsql`excluded.tool_error_count`,
        inputTokens: dsql`excluded.input_tokens`,
        outputTokens: dsql`excluded.output_tokens`,
        cacheReadTokens: dsql`excluded.cache_read_tokens`,
        cacheWriteTokens: dsql`excluded.cache_write_tokens`,
        thinkingTokens: dsql`excluded.thinking_tokens`,
        updatedAt: dsql`now()`,
      },
    })
    .returning({ id: analyticsRollupDaily.id });

  console.log(
    `[backfill-analytics-rollups] Rebuilt ${written.length} rollup bucket(s).`,
  );
  await sqlClient.end();
}

main().catch((err) => {
  console.error("[backfill-analytics-rollups] Fatal:", err);
  process.exit(1);
});
