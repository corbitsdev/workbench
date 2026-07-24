#!/usr/bin/env bun

/**
 * CL-4432: move every in-flight `artifact` row of `kind = 'skill-draft'`
 * onto a `skill-draft` asset (git-backed content, existence-as-state), then
 * delete the migrated artifact row.
 *
 *   bun --env-file=.env.staging apps/hub/bin/migrate-skill-drafts-to-assets.ts [--dry-run] [--yes]
 *
 * The Drizzle `artifact` model in `apps/hub/src/db/schema.ts` no longer maps
 * the `status` column (it is being dropped by migration 0079), so pending
 * rows are read with raw SQL against the physical column, not the ORM. A
 * column-existence guard makes this a clean no-op once `status` has actually
 * been dropped (staging already has it dropped; prod will after this script
 * runs there and 0079 applies). Any per-row failure is NOT swallowed — it
 * propagates and exits non-zero, so a chained `&&` deploy command aborts
 * before 0079 can drop the column out from under undrained rows.
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
  type AssetService,
  type RepoStore,
} from "@workbench/hub-sessions";
import { loadConfig } from "../src/config.ts";
import { schema } from "../src/db/index.ts";
import type { HubDb } from "../src/db/index.ts";
import { artifact } from "../src/db/schema.ts";
import { loadSigningKeyRegistry } from "../src/lib/signing-keys.ts";
import { upsertSkillDraft } from "../src/services/skill-library.ts";

export interface RawSql {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

interface PendingRow {
  id: string;
  title: string;
  content: string;
  source: unknown;
  tenant_id: string | null;
  owner_principal_id: string | null;
  status: string;
}

export async function statusColumnExists(rawSql: RawSql): Promise<boolean> {
  const rows = await rawSql.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'artifact' AND column_name = 'status'
     ) AS exists`,
  );
  return rows[0]?.exists === true;
}

async function fetchPendingSkillDraftRows(
  rawSql: RawSql,
): Promise<PendingRow[]> {
  return rawSql.query<PendingRow>(
    `SELECT id, title, content, source, tenant_id, owner_principal_id, status
     FROM artifact
     WHERE kind = 'skill-draft' AND status = 'draft'`,
  );
}

export interface RunMigrationOptions {
  dryRun: boolean;
  skipConfirm: boolean;
  confirm?: (message: string) => Promise<boolean>;
}

export interface RunMigrationResult {
  columnPresent: boolean;
  found: number;
  migrated: number;
}

async function defaultConfirm(message: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(message);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

export async function runMigration(
  rawSql: RawSql,
  db: HubDb,
  assetService: AssetService,
  repoStore: RepoStore,
  options: RunMigrationOptions,
): Promise<RunMigrationResult> {
  const columnPresent = await statusColumnExists(rawSql);
  if (!columnPresent) {
    console.log(
      "[migrate-skill-drafts] artifact.status already absent — nothing to migrate.",
    );
    return { columnPresent: false, found: 0, migrated: 0 };
  }

  const rows = await fetchPendingSkillDraftRows(rawSql);
  console.log(
    `[migrate-skill-drafts] found ${rows.length} skill-draft artifact row(s) with status='draft'.`,
  );

  if (rows.length === 0) {
    return { columnPresent: true, found: 0, migrated: 0 };
  }

  if (options.dryRun) {
    for (const row of rows) {
      console.log(
        `[migrate-skill-drafts] (dry-run) would migrate artifact ${row.id} "${row.title}" (tenant=${row.tenant_id})`,
      );
    }
    console.log(
      `[migrate-skill-drafts] done: 0 migrated (dry-run, no writes), ${rows.length} found.`,
    );
    return { columnPresent: true, found: rows.length, migrated: 0 };
  }

  if (!options.skipConfirm) {
    const confirm = options.confirm ?? defaultConfirm;
    const proceed = await confirm(
      `Migrate ${rows.length} pending skill-draft artifact row(s) to skill-draft assets? [y/N] `,
    );
    if (!proceed) {
      console.log("[migrate-skill-drafts] Aborted.");
      return { columnPresent: true, found: rows.length, migrated: 0 };
    }
  }

  let migrated = 0;
  for (const row of rows) {
    if (row.tenant_id === null || row.owner_principal_id === null) {
      // Fail loud: a row we cannot migrate here would silently lose its
      // status once 0079 drops the column. Abort the whole run rather than
      // skip past it.
      throw new Error(
        `[migrate-skill-drafts] artifact ${row.id} "${row.title}" has no tenant_id/owner_principal_id — cannot migrate without a tenant/owner.`,
      );
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

    // Deliberately unguarded: an upsert failure must propagate so the
    // deploy's `&&` chain aborts before 0079 runs, not swallow the row.
    await upsertSkillDraft(assetService, db, repoStore, {
      tenantId: row.tenant_id,
      ownerPrincipalId: row.owner_principal_id,
      title: row.title,
      body: row.content,
      description,
      files,
      existingSkillId,
    });
    await db.delete(artifact).where(eq(artifact.id, row.id));
    migrated += 1;
    console.log(
      `[migrate-skill-drafts] migrated artifact ${row.id} "${row.title}"`,
    );
  }

  console.log(
    `[migrate-skill-drafts] done: ${migrated} migrated, ${rows.length} found.`,
  );
  return { columnPresent: true, found: rows.length, migrated };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipConfirm = args.includes("--yes");

  const config = loadConfig();
  const sqlClient = postgres(config.databaseUrl);
  const db = drizzle(sqlClient, { schema }) as HubDb;
  const registry = await loadSigningKeyRegistry(config.hub.signingKeys);
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
  const rawSql: RawSql = {
    query: async <T>(text: string, params?: unknown[]): Promise<T[]> => {
      const rows = await sqlClient.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
  };

  try {
    await runMigration(rawSql, db, assetService, agentRepoStore.repoStore, {
      dryRun,
      skipConfirm,
    });
  } finally {
    await sqlClient.end();
  }
}

if (import.meta.main) {
  await main();
}
