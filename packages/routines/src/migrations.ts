// Package-owned migrations for @corbits/routines' two tables, following
// the same pattern as @corbits/chat's `migrations.ts`: the platform's
// own schema is authored and applied by @intx/db, and this module is
// this package's half of the "mount + migrations is the entire install
// story" install contract. Bookkeeping is its own ledger table, never
// the platform's drizzle journal, so this package's migration history
// stays extractable on its own. Mechanics (schema/ledger bootstrap,
// transactional apply, the advisory lock across concurrent hub
// replicas) live in @corbits/migration-runner — this file owns only
// the domain SQL.
import {
  applyPackageMigrations,
  type ApplyPackageMigrationsReport,
  type PackageMigration,
} from "@corbits/migration-runner";

export type RoutineMigration = PackageMigration;

export const routineMigrations: readonly RoutineMigration[] = [
  {
    name: "0001_routine",
    sql: `
      CREATE TABLE IF NOT EXISTS "routines"."routine" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "name" text NOT NULL,
        "definition_id" text NOT NULL,
        "trigger" jsonb,
        "scope" text NOT NULL,
        "input" jsonb NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "delivery_channel_id" text,
        "created_by" text NOT NULL,
        "next_fire_at" timestamptz,
        "last_fire_at" timestamptz,
        "deleted_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "routine_next_fire_at_idx" ON "routines"."routine" ("next_fire_at") WHERE "enabled" AND "next_fire_at" IS NOT NULL;

      CREATE TABLE IF NOT EXISTS "routines"."routine_run" (
        "tenant_id" text NOT NULL,
        "routine_id" text NOT NULL,
        "run_id" text NOT NULL,
        "triggered_by" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenant_id", "run_id")
      );
    `,
  },
  {
    name: "0002_failure_tracking",
    sql: `
      ALTER TABLE "routines"."routine"
        ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0;
      ALTER TABLE "routines"."routine"
        ADD COLUMN IF NOT EXISTS "dead_lettered_at" timestamptz;
      ALTER TABLE "routines"."routine_run"
        ADD COLUMN IF NOT EXISTS "error" text;
    `,
  },
  {
    name: "0003_routine_draft",
    sql: `
      CREATE TABLE IF NOT EXISTS "routines"."routine_draft" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "prompt" text NOT NULL,
        "status" text NOT NULL,
        "proposed_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "proposed_trigger" jsonb,
        "proposed_name" text,
        "definition_id" text,
        "delivery_channel_id" text NOT NULL,
        "scope" text NOT NULL,
        "autonomy" jsonb,
        "created_by" text NOT NULL,
        "approved_routine_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS "routine_draft_tenant_idx"
        ON "routines"."routine_draft" ("tenant_id", "status");
    `,
  },
  // Product rename (CL-6260): follows @corbits/chat's own
  // 0018_rename_channel_to_workbench — a routine's delivery target is
  // the same workbench, so the column that names it is renamed the
  // same way.
  {
    name: "0004_rename_delivery_channel_id_to_delivery_workbench_id",
    sql: `
      ALTER TABLE "routines"."routine" RENAME COLUMN "delivery_channel_id" TO "delivery_workbench_id";
      ALTER TABLE "routines"."routine_draft" RENAME COLUMN "delivery_channel_id" TO "delivery_workbench_id";
    `,
  },
  // CL-6375: a template-minted routine (e.g. a `DEFAULT_ROUTINE_PRESETS`
  // entry) carries a stable `preset_key`, unique per tenant while the
  // row is live. This is what makes re-seeding a genuine create-if-absent
  // rather than the app-level "list, then create if missing" race that
  // let two overlapping seed calls each insert their own "Daily digest"
  // routine (and each provision its own delivery workbench) — the
  // partial index below is what a concurrent `INSERT ... ON CONFLICT DO
  // NOTHING` targets.
  {
    name: "0005_routine_preset_key",
    sql: `
      ALTER TABLE "routines"."routine"
        ADD COLUMN IF NOT EXISTS "preset_key" text;
      CREATE UNIQUE INDEX IF NOT EXISTS "routine_tenant_preset_key_idx"
        ON "routines"."routine" ("tenant_id", "preset_key")
        WHERE "preset_key" IS NOT NULL AND "deleted_at" IS NULL;
    `,
  },
  // CL-7350: a routine targets a workflow ASSET, not a definition row.
  // The platform keys `workflow_definition` on `(asset_id, wire_hash)`,
  // so a redeploy mints a new definition; the asset is the only identity
  // stable across redeploys (docs/workflow-model.md). Hard cutover: the
  // asset id is backfilled from the platform's `workflow_definition`
  // row the old `definition_id` named, a routine whose definition no
  // longer resolves to an asset is deleted (and counted in a WARNING
  // the migration raises — its `routine_run` history stays), and the
  // old column is dropped. A draft's pinned definition follows the same
  // rename; an unresolvable draft pin becomes null (a draft with no
  // target is already a valid, reviewable state).
  {
    name: "0006_routine_definition_asset_id",
    sql: `
      ALTER TABLE "routines"."routine"
        ADD COLUMN IF NOT EXISTS "definition_asset_id" text;
      UPDATE "routines"."routine" r
        SET "definition_asset_id" = d."asset_id"
        FROM "public"."workflow_definition" d
        WHERE d."id" = r."definition_id" AND d."asset_id" IS NOT NULL;
      DO $$
      DECLARE dropped integer;
      BEGIN
        WITH gone AS (
          DELETE FROM "routines"."routine"
            WHERE "definition_asset_id" IS NULL
            RETURNING "id"
        )
        SELECT count(*) INTO dropped FROM gone;
        UPDATE "routines"."routine_draft"
          SET "approved_routine_id" = NULL
          WHERE "approved_routine_id" IS NOT NULL
            AND "approved_routine_id" NOT IN (SELECT "id" FROM "routines"."routine");
        IF dropped > 0 THEN
          RAISE WARNING '@corbits/routines 0006: deleted % routine row(s) whose definition_id no longer resolves to a workflow asset', dropped;
        END IF;
      END $$;
      ALTER TABLE "routines"."routine"
        ALTER COLUMN "definition_asset_id" SET NOT NULL;
      ALTER TABLE "routines"."routine" DROP COLUMN "definition_id";

      ALTER TABLE "routines"."routine_draft"
        ADD COLUMN IF NOT EXISTS "definition_asset_id" text;
      UPDATE "routines"."routine_draft" r
        SET "definition_asset_id" = d."asset_id"
        FROM "public"."workflow_definition" d
        WHERE d."id" = r."definition_id" AND d."asset_id" IS NOT NULL;
      ALTER TABLE "routines"."routine_draft" DROP COLUMN "definition_id";
    `,
  },
];

// Named distinctly from the platform's setup ledger and from any
// drizzle journal, so extracting @corbits/routines out of this repo
// never has to disentangle its history from the platform's or from
// @corbits/chat's own `chat_migrations` ledger. Lives in the package's
// own `routines` schema, like every other table it owns.
const SCHEMA = "routines";
const LEDGER_TABLE = "routine_migrations";

export type ApplyRoutineMigrationsReport = ApplyPackageMigrationsReport;

/**
 * Apply `routineMigrations` against `databaseUrl`, idempotently: a
 * migration already recorded in the ledger is skipped, never re-run.
 * Failures are loud — the migration name and the underlying error are
 * both surfaced.
 */
export async function applyRoutineMigrations(
  databaseUrl: string,
): Promise<ApplyRoutineMigrationsReport> {
  return applyPackageMigrations({
    databaseUrl,
    schema: SCHEMA,
    ledgerTable: LEDGER_TABLE,
    migrations: routineMigrations,
    packageLabel: "@corbits/routines",
  });
}
