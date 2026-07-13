#!/usr/bin/env bun

/**
 * CL-3483: Seed missing `workflow_run_record` rows from on-disk run event logs on
 * shared registry deployments, then fold projection for that repo.
 *
 *   bun --env-file=.env.staging apps/hub/bin/backfill-orphan-workflow-run-records.ts \
 *     [--deployment <id>] [--dry-run] [--yes]
 *
 * Without --deployment, processes every row in `workflow_run` with a deployment_id.
 * Requires DATABASE_URL, HUB_DATA_DIR, HUB_SIGNING_KEYS, GLOBAL_TENANT_DOMAIN.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createAgentRepoStore } from "@intx/storage-isogit";
import { loadConfig } from "../src/config.ts";
import { schema } from "../src/db/index.ts";
import { workflowRun } from "../src/db/schema.ts";
import { loadSigningKeyRegistry } from "../src/lib/signing-keys.ts";
import { deriveWorkflowRunRepoId } from "../src/routes/workflow-runs.ts";
import {
  projectWorkflowRunRepo,
  seedMissingRunRecordsFromRepo,
} from "../src/workflow-executor/projection-bridge.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipConfirm = args.includes("--yes");
const deploymentIdx = args.indexOf("--deployment");
const deploymentFilter =
  deploymentIdx >= 0 ? args[deploymentIdx + 1] : undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  const sqlClient = postgres(config.databaseUrl);
  const db = drizzle(sqlClient, { schema });
  const registry = loadSigningKeyRegistry(config.hub.signingKeys);
  const repoStore = createAgentRepoStore({
    dataDir: config.hub.dataDir,
    registry,
  });
  const domain = config.rootTenant.domain;

  const where = and(
    isNotNull(workflowRun.deploymentId),
    isNull(workflowRun.deletedAt),
    deploymentFilter
      ? eq(workflowRun.deploymentId, deploymentFilter)
      : undefined,
  );
  const deployments = await db.query.workflowRun.findMany({ where });

  if (deployments.length === 0) {
    console.log(
      "[backfill-orphan-run-records] No matching workflow_run deployments.",
    );
    await sqlClient.end();
    return;
  }

  console.log(
    `[backfill-orphan-run-records] ${deployments.length} deployment(s) to scan`,
  );

  if (!dryRun && !skipConfirm) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      "Seed missing records and project run logs? [y/N] ",
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("[backfill-orphan-run-records] Aborted.");
      await sqlClient.end();
      return;
    }
  }

  for (const row of deployments) {
    const deploymentId = row.deploymentId;
    if (!deploymentId) continue;
    const repoId = deriveWorkflowRunRepoId(deploymentId, domain);
    console.log(
      `[backfill-orphan-run-records] ${row.kind} @ ${deploymentId} repo=${repoId.id}`,
    );
    if (dryRun) continue;

    const seeded = await seedMissingRunRecordsFromRepo(repoStore, db, repoId, {
      kind: row.kind,
      tenantId: row.tenantId,
      principalId: row.principalId,
      deploymentId,
    });
    if (seeded.length > 0) {
      console.log(`  seeded ${seeded.length} run(s): ${seeded.join(", ")}`);
    }
    await projectWorkflowRunRepo(repoStore, db, repoId);
    console.log("  projection fold complete");
  }

  await sqlClient.end();
}

await main();
