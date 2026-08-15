// Package-owned migrations for @corbits/tasks. Bookkeeping uses its
// own ledger table so the package can be extracted without
// disentangling history from the platform drizzle journal. Every
// table this package owns — including its ledger — lives in its own
// `tasks` Postgres schema, never `public`; see
// docs/package-migrations.md.
import postgres from "postgres";

export interface TaskMigration {
  name: string;
  sql: string;
}

const SCHEMA = "tasks";

export const tasksMigrations: readonly TaskMigration[] = [
  {
    name: "0001_task",
    sql: `
      CREATE TABLE IF NOT EXISTS "tasks"."task" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "principal_id" text NOT NULL,
        "definition_id" text NOT NULL,
        "prompt" text NOT NULL,
        "model_preference" text,
        "status" text NOT NULL,
        "run_id" text NOT NULL,
        "result_mail_id" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz
      );
      CREATE INDEX IF NOT EXISTS "task_tenant_created_idx"
        ON "tasks"."task" ("tenant_id", "created_at");
      CREATE UNIQUE INDEX IF NOT EXISTS "task_run_id_uidx"
        ON "tasks"."task" ("run_id");
    `,
  },
  {
    name: "0002_planner_run_id",
    sql: `
      ALTER TABLE "tasks"."task" ADD COLUMN IF NOT EXISTS "planner_run_id" text;
    `,
  },
  {
    name: "0003_agent_name",
    sql: `
      ALTER TABLE "tasks"."task" ADD COLUMN IF NOT EXISTS "agent_name" text NOT NULL DEFAULT '';
      ALTER TABLE "tasks"."task" ALTER COLUMN "agent_name" DROP DEFAULT;
    `,
  },
  {
    // Task→run goes from one-to-one to one-to-many. Every task that
    // already exists is a one-leg chain, so the backfill mints its
    // position-0 leg from the columns the task already carries — a
    // task written before this migration reads back identically
    // afterwards, run id and all.
    name: "0004_task_leg",
    sql: `
      CREATE TABLE IF NOT EXISTS "tasks"."task_leg" (
        "id" text PRIMARY KEY,
        "task_id" text NOT NULL,
        "tenant_id" text NOT NULL,
        "position" integer NOT NULL,
        "definition_id" text NOT NULL,
        "prompt" text NOT NULL,
        "model_preference" text,
        "parent_run_id" text,
        "message_id" text NOT NULL,
        "run_id" text,
        "status" text NOT NULL,
        "lease_expires_at" timestamptz,
        "error_message" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "settled_at" timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "task_leg_task_position_uidx"
        ON "tasks"."task_leg" ("task_id", "position");
      CREATE UNIQUE INDEX IF NOT EXISTS "task_leg_task_message_uidx"
        ON "tasks"."task_leg" ("task_id", "message_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "task_leg_run_id_uidx"
        ON "tasks"."task_leg" ("run_id");
      CREATE INDEX IF NOT EXISTS "task_leg_task_idx"
        ON "tasks"."task_leg" ("task_id");

      INSERT INTO "tasks"."task_leg" (
        "id", "task_id", "tenant_id", "position", "definition_id",
        "prompt", "model_preference", "parent_run_id", "message_id",
        "run_id", "status", "created_at", "settled_at"
      )
      SELECT
        'tleg_' || replace(gen_random_uuid()::text, '-', ''),
        t."id",
        t."tenant_id",
        0,
        t."definition_id",
        t."prompt",
        t."model_preference",
        NULL,
        'chain:' || t."id" || ':0',
        t."run_id",
        CASE t."status"
          WHEN 'done' THEN 'done'
          WHEN 'failed' THEN 'failed'
          ELSE 'running'
        END,
        t."created_at",
        t."completed_at"
      FROM "tasks"."task" t
      ON CONFLICT DO NOTHING;
    `,
  },
  {
    // "The agent was given its prompt" stops being inferrable from the
    // leg's status the moment the leg settles, so it gets its own
    // column. Every leg that already carries a run id was written by
    // the pre-chain one-leg path, which only ever recorded a run after
    // its prompt had gone out — those legs really did start.
    name: "0005_task_leg_started_at",
    sql: `
      ALTER TABLE "tasks"."task_leg"
        ADD COLUMN IF NOT EXISTS "started_at" timestamptz;
      UPDATE "tasks"."task_leg"
        SET "started_at" = "created_at"
        WHERE "run_id" IS NOT NULL AND "started_at" IS NULL;
    `,
  },
];

/**
 * Every folded run this package's own launches recorded in `task` or
 * `task_leg` — a task's own `run_id` names its first leg, and
 * `task_leg.run_id` names every hand-off in a chain (CL-6052). Exists
 * for `@corbits/folded-runs`' one-time backfill (CL-6061): before its
 * own `folded_run` marker table existed, these two tables were the
 * only durable record that a given run was folded. This package never
 * writes to `folded_runs.folded_run` itself — that would make it
 * depend on a package that already depends on it — so it only ever
 * reads its own schema and hands the ids back; the caller
 * (scripts/db-setup.ts, the one place that already knows every
 * installed package) is the one that inserts them as markers via
 * `@corbits/folded-runs`' own export.
 */
export interface TaskFoldedRunSeed {
  readonly id: string;
  readonly tenantId: string;
}

export async function listTaskFoldedRunIds(
  databaseUrl: string,
): Promise<TaskFoldedRunSeed[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = await sql.unsafe(`
      SELECT "run_id" AS "id", "tenant_id" AS "tenantId" FROM "tasks"."task"
      UNION
      SELECT "run_id" AS "id", "tenant_id" AS "tenantId" FROM "tasks"."task_leg"
      WHERE "run_id" IS NOT NULL
    `);
    return rows.map((row) => ({
      id: String(row["id"]),
      tenantId: String(row["tenantId"]),
    }));
  } finally {
    await sql.end();
  }
}

const LEDGER_TABLE = "tasks_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyTasksMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyTasksMigrations(
  databaseUrl: string,
): Promise<ApplyTasksMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of tasksMigrations) {
      const existing = await sql.unsafe(
        `SELECT 1 FROM ${quoteQualified(SCHEMA, LEDGER_TABLE)} WHERE name = $1`,
        [migration.name],
      );
      if (existing.length > 0) {
        alreadyApplied.push(migration.name);
        continue;
      }
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql);
          await tx.unsafe(
            `INSERT INTO ${quoteQualified(SCHEMA, LEDGER_TABLE)} (name) VALUES ($1)`,
            [migration.name],
          );
        });
        applied.push(migration.name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `tasks migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
