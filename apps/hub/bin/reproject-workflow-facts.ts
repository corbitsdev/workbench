#!/usr/bin/env bun

/**
 * Rebuild `workflow_run_fact` + `workflow_step_fact` from the run event logs
 * (CL-2670). The fact store is a PURE DERIVED CACHE — the native git event log
 * is the source of truth — so this reproject re-derives every terminal run's
 * facts from scratch and upserts them idempotently (each run's facts are
 * replaced, never duplicated). Use it to backfill after the feature ships or to
 * repair drift.
 *
 *   bun run apps/hub/bin/reproject-workflow-facts.ts [--tenant <tenantId>]
 *
 * Requires DATABASE_URL and the hub's signing keys / data dir (same env the hub
 * boots with) so the workflow-run repos are readable.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createAgentRepoStore } from "@intx/hub-sessions";

import { schema } from "../src/db";
import type { HubDb } from "../src/db";
import { loadConfig } from "../src/config";
import { loadSigningKeyRegistry } from "../src/lib/signing-keys";
import { reprojectWorkflowFacts } from "../src/workflow-executor/workflow-run-facts";

const argv = process.argv.slice(2);
const tenantIdx = argv.indexOf("--tenant");
const tenantId = tenantIdx >= 0 ? argv[tenantIdx + 1] : undefined;

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("[reproject-workflow-facts] DATABASE_URL is required");
    process.exit(1);
  }

  const config = loadConfig();
  const { hub } = config;
  const sql = postgres(databaseUrl);
  const db = drizzle(sql, { schema }) as unknown as HubDb;

  const registry = await loadSigningKeyRegistry(hub.signingKeys);
  const repoStore = createAgentRepoStore({
    dataDir: hub.dataDir,
    signingKey: registry.active,
    gc: { ...hub.agentGc, retention: "keep-history" },
  });

  console.log(
    `[reproject-workflow-facts] Reprojecting facts${
      tenantId ? ` for tenant ${tenantId}` : " for all tenants"
    }`,
  );
  const result = await reprojectWorkflowFacts(
    { db, repoStore, deploymentDomain: config.rootTenant.domain },
    tenantId !== undefined ? { tenantId } : {},
  );
  console.log(
    `[reproject-workflow-facts] Done: projected ${result.projected}, skipped ${result.skipped}`,
  );
  await sql.end();
}

main().catch((err) => {
  console.error("[reproject-workflow-facts] Fatal:", err);
  process.exit(1);
});
