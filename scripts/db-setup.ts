/**
 * Forward-only database migration runner.
 *
 * Uses drizzle-orm's built-in migrator for Interchange migrations, then applies
 * the GTM custom migrations in `apps/hub/migrations/*.sql`. Each custom file is
 * tracked in a `_workbench_migrations` ledger so it runs exactly once, and each
 * file's statements run inside a single transaction so a partial failure rolls
 * back without recording the file (it is retried cleanly on the next run).
 *
 * Migration files are still expected to be idempotent (CREATE TABLE IF NOT
 * EXISTS, ADD COLUMN IF NOT EXISTS, guarded ADD CONSTRAINT) so that a pre-ledger
 * dev DB bootstraps safely on the first run after the ledger was introduced.
 * This custom runner owns the hub migrations; the drizzle-kit journal is not used.
 */

interface DBConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

function parseDatabaseUrl(url: string): DBConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid DATABASE_URL: could not parse as URL`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `Invalid DATABASE_URL: expected postgres:// or postgresql:// scheme, got ${parsed.protocol}`,
    );
  }

  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || 5432);
  const user = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");
  const database = parsed.pathname.replace(/^\//, "");

  if (!user) throw new Error(`Invalid DATABASE_URL: username is missing`);
  if (!password) throw new Error(`Invalid DATABASE_URL: password is missing`);
  if (!database)
    throw new Error(`Invalid DATABASE_URL: database name is missing`);

  const ssl =
    parsed.searchParams.get("sslmode") === "require" ||
    parsed.searchParams.get("sslmode") === "prefer" ||
    parsed.searchParams.get("ssl") === "true" ||
    process.env["DB_SSL"] === "true";

  return { host, port, user, password, database, ssl };
}

function resolveDBConfig(): DBConfig {
  const databaseUrl = process.env["DATABASE_URL"];

  if (!databaseUrl) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL. " +
        "Example: postgres://workbench:workbench-dev-password@localhost:5433/workbench",
    );
  }

  const config = parseDatabaseUrl(databaseUrl);
  console.log(
    `[db-config] Using DATABASE_URL (host=${config.host}, port=${config.port}, db=${config.database})`,
  );
  return config;
}

const DB = resolveDBConfig();

async function waitForPostgres(maxRetries = 10, delayMs = 1000): Promise<void> {
  const postgres = await import("postgres");

  console.log(
    `Waiting for Postgres at ${DB.host}:${DB.port} (user: ${DB.user})...`,
  );

  for (let i = 0; i < maxRetries; i++) {
    try {
      const sql = postgres.default({
        host: DB.host,
        port: DB.port,
        user: DB.user,
        password: DB.password,
        database: "postgres",
        ssl: DB.ssl,
        max: 1,
        connect_timeout: 2,
      });
      await sql`SELECT 1`;
      await sql.end();
      console.log("Postgres is ready.");
      return;
    } catch {
      if (i < maxRetries - 1) {
        process.stdout.write(".");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(
    `Could not connect to Postgres at ${DB.host}:${DB.port} after ${maxRetries} attempts. Is the container running and the port mapped?`,
  );
}

async function checkDatabase(): Promise<void> {
  const postgres = await import("postgres");
  const sql = postgres.default({
    host: DB.host,
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database: "postgres",
    ssl: DB.ssl,
    max: 1,
  });

  try {
    const rows =
      await sql`SELECT 1 FROM pg_database WHERE datname = ${DB.database}`;
    if (rows.length === 0) {
      console.log(`Creating database "${DB.database}"...`);
      await sql.unsafe(`CREATE DATABASE "${DB.database.replace(/"/g, '""')}"`);
      console.log(`Database "${DB.database}" created.`);
    } else {
      console.log(`Database "${DB.database}" already exists.`);
    }
  } finally {
    await sql.end();
  }
}

async function runInterchangeMigrations(
  client: import("postgres").Sql<{}>,
): Promise<void> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");

  const db = drizzle(client);

  console.log("\n  → Applying Interchange migrations...");
  const start = Date.now();
  await migrate(db, {
    migrationsFolder: "interchange/packages/db/migrations",
  });
  console.log(`  ✅ Interchange migrations applied in ${Date.now() - start}ms`);
}

/**
 * Name of the applied-migrations ledger table. Each row records one custom
 * migration file that has been applied successfully, so each file runs exactly
 * once across repeated `db:setup` invocations.
 */
const MIGRATIONS_LEDGER_TABLE = "_workbench_migrations";

/**
 * Ensure the applied-migrations ledger exists. Idempotent (CREATE TABLE IF NOT
 * EXISTS), so it is safe to call on every run, including pre-ledger dev DBs.
 */
async function ensureMigrationsLedger(
  client: import("postgres").Sql<{}>,
): Promise<void> {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_LEDGER_TABLE}" (
      "filename" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Apply GTM custom migrations from `apps/hub/migrations/*.sql`.
 *
 * Migration-authoring convention:
 *   - The custom runner owns these migrations (NOT drizzle-kit). There is no
 *     `meta/_journal.json` snapshot; ordering is by sorted filename
 *     (`NNNN_description.sql`), and each file is applied exactly once.
 *   - Statements within a file are separated by `--> statement-breakpoint`.
 *   - Each file is applied inside a single transaction: a partial failure rolls
 *     back cleanly and the file is NOT recorded, so the next run retries it
 *     from a clean state. (Postgres DDL is transactional.)
 *   - Write statements to be idempotent anyway (`CREATE TABLE IF NOT EXISTS`,
 *     `ADD COLUMN IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object`).
 *     This guards the bootstrap run on a dev DB that predates the ledger: every
 *     file re-runs once as a no-op, then gets recorded.
 */
async function runCustomMigrations(
  client: import("postgres").Sql<{}>,
): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const migrationsDir = "apps/hub/migrations";

  if (!fs.existsSync(migrationsDir)) {
    console.log("\n  → No custom migrations found.");
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("\n  → No custom migrations found.");
    return;
  }

  await ensureMigrationsLedger(client);

  const appliedRows = await client<{ filename: string }[]>`
    SELECT filename FROM ${client(MIGRATIONS_LEDGER_TABLE)}
  `;
  const applied = new Set(appliedRows.map((r) => r.filename));

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(
      `\n  → All ${files.length} custom migration(s) already applied. No-op.`,
    );
    return;
  }

  console.log(
    `\n  → Applying ${pending.length} pending custom migration(s) (${applied.size} already applied)...`,
  );
  const start = Date.now();

  for (const file of pending) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    // A file whose first line is `-- migrate:no-transaction` runs each
    // statement standalone — required for CREATE INDEX CONCURRENTLY, which
    // Postgres refuses inside a transaction. Such files lose atomic rollback:
    // every statement must be independently idempotent AND self-repairing
    // (e.g. DROP INDEX CONCURRENTLY IF EXISTS before each CREATE, clearing an
    // INVALID leftover from an interrupted build), because a mid-file failure
    // leaves earlier statements applied and the file unrecorded — it re-runs
    // in full on the next setup.
    const noTransaction = /^--\s*migrate:no-transaction/.test(raw);

    if (noTransaction) {
      for (const stmt of statements) {
        await client.unsafe(stmt);
      }
      await client`
        INSERT INTO ${client(MIGRATIONS_LEDGER_TABLE)} (filename)
        VALUES (${file})
      `;
    } else {
      // Apply the whole file in one transaction so a partial failure rolls
      // back cleanly and the file is not recorded as applied.
      await client.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`
          INSERT INTO ${tx(MIGRATIONS_LEDGER_TABLE)} (filename)
          VALUES (${file})
        `;
      });
    }

    console.log(`    (applied) ${file}`);
  }

  console.log(`  ✅ Custom migrations applied in ${Date.now() - start}ms`);
}

async function runMigrations(): Promise<void> {
  const postgres = await import("postgres");

  const client = postgres.default({
    host: DB.host,
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database: DB.database,
    ssl: DB.ssl,
    max: 1,
  });

  console.log("Running forward-only migrations...");

  await runInterchangeMigrations(client);
  await runCustomMigrations(client);

  await client.end();
}

async function main(): Promise<void> {
  console.log("=== GTM Workbench DB Setup ===");

  try {
    await waitForPostgres();
    await checkDatabase();
    await runMigrations();
    console.log("\n✅ DB setup complete.");
  } catch (err) {
    console.error("\n❌ DB setup failed:");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
