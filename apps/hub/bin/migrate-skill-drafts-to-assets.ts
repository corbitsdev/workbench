#!/usr/bin/env bun

/**
 * CL-4215: move every in-flight `artifact` row of `kind = 'skill-draft'`
 * onto a `skill-draft` asset (git-backed content, existence-as-state),
 * then delete the migrated artifact row.
 *
 *   bun --env-file=.env.staging apps/hub/bin/migrate-skill-drafts-to-assets.ts [--dry-run] [--yes]
 *
 * Must run BEFORE migration 0079_drop_artifact_status.sql is applied — that
 * migration drops `artifact.status`, and this script still reads it to skip
 * rows that are not `status = 'draft'` (an `approved` or `rejected` row
 * under the old model has no equivalent under existence-as-state: an
 * `approved` row's content already lives on its linked `skill` asset, and a
 * `rejected` row is the old model's now-abolished tombstone — both are
 * left as artifact rows for this run and are dropped, not migrated, when
 * their `status` column disappears in 0079).
 *
 * Requires DATABASE_URL, HUB_DATA_DIR, HUB_SIGNING_KEYS.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  createAgentRepoStore,
  createAssetService,
  skillDraftAuthorize,
  skillDraftKindHandler,
} from "@workbench/hub-sessions";
import { loadConfig } from "../src/config.ts";
import { schema } from "../src/db/index.ts";
import { artifact } from "../src/db/schema.ts";
import { loadSigningKeyRegistry } from "../src/lib/signing-keys.ts";
import { upsertSkillDraft } from "../src/services/skill-library.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipConfirm = args.includes("--yes");

async function main(): Promise<void> {
  const config = loadConfig();
  const sqlClient = postgres(config.databaseUrl);
  const db = drizzle(sqlClient, { schema });
  const registry = loadSigningKeyRegistry(config.hub.signingKeys);
  const agentRepoStore = createAgentRepoStore({
    dataDir: config.hub.dataDir,
    signingKey: registry.active,
    handlers: {
      "skill-draft": {
        handler: skillDraftKindHandler,
        authorize: skillDraftAuthorize,
      },
    },
  });
  const assetService = createAssetService({
    db,
    repoStore: agentRepoStore.repoStore,
    registeredKinds: agentRepoStore.registeredKinds,
  });

  const rows = await db.query.artifact.findMany({
    where: eq(artifact.kind, "skill-draft"),
  });
  const pending = rows.filter((row) => row.status === "draft");

  console.log(
    `[migrate-skill-drafts] ${rows.length} skill-draft artifact row(s), ${pending.length} pending (status='draft') to migrate.`,
  );
  if (rows.length > pending.length) {
    console.log(
      `[migrate-skill-drafts] ${rows.length - pending.length} row(s) with status != 'draft' are NOT migrated — see the script header for why.`,
    );
  }

  if (pending.length === 0) {
    await sqlClient.end();
    return;
  }

  if (!dryRun && !skipConfirm) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      `Migrate ${pending.length} pending skill-draft artifact row(s) to skill-draft assets? [y/N] `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("[migrate-skill-drafts] Aborted.");
      await sqlClient.end();
      return;
    }
  }

  let migrated = 0;
  let failed = 0;
  for (const row of pending) {
    if (row.tenantId === null || row.ownerPrincipalId === null) {
      console.error(
        `[migrate-skill-drafts] SKIPPED artifact ${row.id}: missing tenantId or ownerPrincipalId (cannot migrate without a tenant/owner).`,
      );
      failed += 1;
      continue;
    }
    if (dryRun) {
      console.log(
        `[migrate-skill-drafts] (dry-run) would migrate artifact ${row.id} "${row.title}" (tenant=${row.tenantId})`,
      );
      continue;
    }
    const source = (row.source ?? {}) as Record<string, unknown>;
    const description =
      typeof source.description === "string" ? source.description : null;
    const existingSkillId =
      typeof source.existingSkillId === "string" && source.existingSkillId
        ? source.existingSkillId
        : null;
    const rawFiles = source.files;
    const files = Array.isArray(rawFiles)
      ? rawFiles.filter(
          (f): f is { path: string; content: string } =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as { path?: unknown }).path === "string" &&
            typeof (f as { content?: unknown }).content === "string",
        )
      : undefined;

    try {
      await upsertSkillDraft(assetService, db, agentRepoStore.repoStore, {
        tenantId: row.tenantId,
        ownerPrincipalId: row.ownerPrincipalId,
        title: row.title,
        body: row.content,
        description,
        files,
        existingSkillId,
      });
      await db.delete(artifact).where(eq(artifact.id, row.id));
      migrated += 1;
      console.log(`[migrate-skill-drafts] migrated artifact ${row.id} "${row.title}"`);
    } catch (err) {
      failed += 1;
      console.error(
        `[migrate-skill-drafts] FAILED artifact ${row.id} "${row.title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(
    `[migrate-skill-drafts] done: ${migrated} migrated, ${failed} failed${dryRun ? " (dry-run, no writes)" : ""}.`,
  );
  await sqlClient.end();
  if (failed > 0) process.exitCode = 1;
}

await main();
