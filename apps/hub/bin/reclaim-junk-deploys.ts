#!/usr/bin/env bun

/**
 * Reclaim orphaned "junk" workflow deployments (CL-2811).
 *
 * Every `workflow_run` deployment-index row is written with `kind:
 * definition.id` by `publishWorkflowDefinition` (the only writer). Redeploy
 * supersede only supersedes the SAME `(kind, tenant)`, so a deploy whose kind is
 * not a real catalog workflow (a bare step like `skipWriteBack`/`source`, a
 * per-run supervisor `supervisor-ses_…`) is never superseded, never
 * soft-deleted, and stays in `/deployments/live` — which forbids the sidecar
 * boot-reconciler from pruning its on-disk isogit repos AND keeps its supervisor
 * resident in the sidecar. That is the sidecar-OOM + hub-disk root cause.
 *
 * This soft-deletes (`deletedAt`) every non-catalog `workflow_run` row so they
 * drop out of `/deployments/live`. It does NOT touch conversation/analytics data
 * (`turn_part`, `analytics_event`, `inference_turn`) — only the junk deployment
 * index rows.
 *
 * A catalog kind is NEVER selected, so real workflows are never affected.
 *
 *   bun run apps/hub/bin/reclaim-junk-deploys.ts            # dry-run (default)
 *   bun run apps/hub/bin/reclaim-junk-deploys.ts --apply    # execute
 *
 * Requires DATABASE_URL. After --apply, restart/redeploy the sidecar so its
 * boot-reconciler reclaims the now-non-live repos and the resident junk
 * supervisors are not re-registered (that is what actually frees disk + memory).
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { inArray, isNull } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { workflowRun } from "../src/db/schema";
import { loadWorkflowCatalogKinds } from "../src/lib/workflow-catalog";

const log = getLogger(["bin", "reclaim-junk-deploys"]);

const apply = process.argv.slice(2).includes("--apply");

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  log.error("DATABASE_URL is required");
  process.exit(1);
}

const sqlClient = postgres(databaseUrl);
const db = drizzle(sqlClient, { schema: { workflowRun } });

async function main(): Promise<void> {
  const catalogKinds = await loadWorkflowCatalogKinds();
  if (catalogKinds.size === 0) {
    // Fail loud rather than treat every kind as junk on a missing catalog.
    log.error(
      "embedded workflow catalog resolved to 0 kinds — refusing to run " +
        "(a missing catalog would misclassify every deploy as junk)",
    );
    await sqlClient.end();
    process.exit(1);
  }

  const live = await db
    .select({
      id: workflowRun.id,
      kind: workflowRun.kind,
      deploymentId: workflowRun.deploymentId,
      tenantId: workflowRun.tenantId,
    })
    .from(workflowRun)
    .where(isNull(workflowRun.deletedAt));

  const junk = live.filter((r) => !catalogKinds.has(r.kind));

  const byKind = new Map<string, number>();
  for (const r of junk) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);

  log.info(
    `catalog kinds: ${[...catalogKinds].sort().join(", ")} (${catalogKinds.size})`,
  );
  log.info(
    `${live.length} live deployment row(s); ${junk.length} are junk (non-catalog kind)`,
  );
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    log.info(`  ${String(count).padStart(5)} × ${kind}`);
  }

  if (junk.length === 0) {
    log.info("nothing to reclaim");
    await sqlClient.end();
    return;
  }

  if (!apply) {
    log.info(
      `DRY RUN — no rows changed. Re-run with --apply to soft-delete these ${junk.length} row(s).`,
    );
    await sqlClient.end();
    return;
  }

  const now = new Date();
  const ids = junk.map((r) => r.id);
  // Chunk the id list so a huge junk set doesn't overflow the bind-param limit.
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await db
      .update(workflowRun)
      .set({ deletedAt: now })
      .where(inArray(workflowRun.id, chunk))
      .returning({ id: workflowRun.id });
    updated += res.length;
  }
  log.info(
    `soft-deleted ${updated} junk deployment row(s). Restart/redeploy the ` +
      `sidecar to reclaim their repos + resident supervisors.`,
  );
  await sqlClient.end();
}

await main();
