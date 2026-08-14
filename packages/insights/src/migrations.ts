// Package-owned migrations for @corbits/insights. Bookkeeping uses its
// own ledger table so the package can be extracted without disentangling
// history from the platform drizzle journal. Every table this package
// owns — including its ledger — lives in its own `insights` Postgres
// schema, never `public`; see docs/package-migrations.md.
import postgres from "postgres";

export interface InsightsMigration {
  name: string;
  sql: string;
}

const SCHEMA = "insights";

export const insightsMigrations: readonly InsightsMigration[] = [
  {
    name: "0001_usage_turn",
    sql: `
      CREATE TABLE IF NOT EXISTS "insights"."usage_turn" (
        "id" text PRIMARY KEY,
        "tenant_id" text NOT NULL,
        "session_id" text NOT NULL,
        "turn_id" text NOT NULL,
        "model" text NOT NULL,
        "input_tokens" integer NOT NULL DEFAULT 0,
        "cache_read_tokens" integer NOT NULL DEFAULT 0,
        "cache_write_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "thinking_tokens" integer NOT NULL DEFAULT 0,
        "recorded_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "usage_turn_turn_id_uidx"
        ON "insights"."usage_turn" ("turn_id");
      CREATE INDEX IF NOT EXISTS "usage_turn_tenant_recorded_idx"
        ON "insights"."usage_turn" ("tenant_id", "recorded_at");
    `,
  },
  {
    name: "0002_model_price",
    sql: `
      CREATE TABLE IF NOT EXISTS "insights"."model_price" (
        "model" text PRIMARY KEY,
        "input_per_m_tok" numeric,
        "output_per_m_tok" numeric,
        "cache_read_per_m_tok" numeric,
        "cache_write_per_m_tok" numeric,
        "thinking_per_m_tok" numeric
      );
    `,
  },
  {
    name: "0003_move_tables_to_insights_schema",
    sql: `
      DO $$
      DECLARE
        table_name text;
      BEGIN
        FOREACH table_name IN ARRAY ARRAY['usage_turn', 'model_price']
        LOOP
          IF to_regclass('public.' || table_name) IS NOT NULL
             AND to_regclass('insights.' || table_name) IS NULL THEN
            EXECUTE format('ALTER TABLE public.%I SET SCHEMA insights', table_name);
          END IF;
        END LOOP;
      END $$;
    `,
  },
];

const LEDGER_TABLE = "insights_migrations";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export interface ApplyInsightsMigrationsReport {
  applied: string[];
  alreadyApplied: string[];
}

export async function applyInsightsMigrations(
  databaseUrl: string,
): Promise<ApplyInsightsMigrationsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SCHEMA)}`);

    // Pre-existing dev DBs from before this package had its own schema
    // carry the ledger in `public` — move it in place so its history
    // (which migrations already ran) comes with it. A fresh install
    // never has a `public` ledger, so this is a no-op there.
    await sql.unsafe(
      `DO $$ BEGIN IF to_regclass('public.${LEDGER_TABLE}') IS NOT NULL ` +
        `AND to_regclass('${SCHEMA}.${LEDGER_TABLE}') IS NULL THEN ` +
        `ALTER TABLE "public".${quoteIdentifier(LEDGER_TABLE)} SET SCHEMA ${quoteIdentifier(SCHEMA)}; ` +
        `END IF; END $$;`,
    );

    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quoteQualified(SCHEMA, LEDGER_TABLE)} (` +
        `name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of insightsMigrations) {
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
          `insights migration ${migration.name} failed: ${message}`,
          { cause: err },
        );
      }
    }

    return { applied, alreadyApplied };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
