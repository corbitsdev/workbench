// Database bootstrap: makes the database in DATABASE_URL runnable by
// creating it if it does not exist, then handing off to the hub's own
// `migrateHub` (apps/hub/src/migrate.ts) to apply the platform schema
// plus every mounted Corbits package's migration — the hub is the one
// process that knows what it mounts, so it is the one place that
// migrates. This script makes an empty Postgres server usable; it
// authors no SQL of its own.
//
// Exported surface (consumed by the CLI's setup verb and the test
// harnesses):
//
//   setupDatabase(databaseUrl, { schema? })  -> DbSetupReport
//   resetSchema(databaseUrl, { schema? })    -> void
//
// Run directly: `bun scripts/db-setup.ts [--reset]` (reads DATABASE_URL).

import { createDB, dropSchema as dropIntxSchema } from "@intx/db";

interface SqlClient {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  end(options?: { timeout: number }): Promise<void>;
}

type PostgresFactory = (options: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
  onnotice: () => undefined;
}) => SqlClient;

// The driver is the hub's dependency, so it resolves from apps/hub rather
// than from this script's own directory.
const hubDir = new URL("../apps/hub/", import.meta.url).pathname;

async function loadPostgres(): Promise<PostgresFactory> {
  const resolved = Bun.resolveSync("postgres", hubDir);
  const loaded = (await import(resolved)) as { default: PostgresFactory };
  return loaded.default;
}

interface HubMigrateConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  schema?: string;
}

async function loadMigrateHub(): Promise<(config: HubMigrateConfig, db: unknown) => Promise<void>> {
  const resolved = Bun.resolveSync("../apps/hub/src/migrate.ts", import.meta.dir);
  const loaded = (await import(resolved)) as {
    migrateHub: (config: HubMigrateConfig, db: unknown) => Promise<void>;
  };
  return loaded.migrateHub;
}

export interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Parse DATABASE_URL the same way the hub does (see dbConfigFromUrl in
 * apps/hub/src/index.ts), so this script bootstraps exactly the
 * connection the hub will use. An empty user falls through to the
 * postgres client's OS-username default, matching the hub's behavior.
 */
export function dbTargetFromUrl(databaseUrl: string): DbTarget {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      `DATABASE_URL is not a parseable URL: ${JSON.stringify(databaseUrl)}. ` +
        "Expected e.g. postgres://user:pass@localhost:5432/workbench.",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`DATABASE_URL must be a postgres:// URL, got ${url.protocol}//.`);
  }
  const database = url.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error(
      "DATABASE_URL names no database (empty path). " +
        "Expected e.g. postgres://localhost:5432/workbench.",
    );
  }
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

async function connect(target: DbTarget): Promise<SqlClient> {
  const postgres = await loadPostgres();
  return postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    max: 1,
    onnotice: () => undefined,
  });
}

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Connect to the target database, creating it first when it does not
 * exist (via the server's maintenance database). Returns whether the
 * database had to be created. Unreachable servers fail with the fix
 * named, mirroring the dev bootstrap's guidance.
 */
async function ensureDatabase(
  target: DbTarget,
): Promise<{ sql: SqlClient; createdDatabase: boolean }> {
  const sql = await connect(target);
  try {
    await sql.unsafe("SELECT 1");
    return { sql, createdDatabase: false };
  } catch (error) {
    await sql.end();
    if (pgErrorCode(error) !== "3D000") {
      throw new Error(
        [
          `Cannot connect to Postgres at ${target.host}:${target.port} ` +
            `(from DATABASE_URL): ${error instanceof Error ? error.message : String(error)}`,
          "Start a local Postgres and re-run. On macOS:",
          "",
          "  brew install postgresql@17 pgvector",
          "  brew services start postgresql@17",
        ].join("\n"),
        { cause: error },
      );
    }
  }
  // 3D000: the database does not exist. Create it from the maintenance
  // database, then reconnect to it.
  const maintenance = await connect({ ...target, database: "postgres" });
  try {
    await maintenance.unsafe(`CREATE DATABASE ${quoteIdentifier(target.database)}`);
  } catch (error) {
    throw new Error(
      `Database ${JSON.stringify(target.database)} does not exist and ` +
        `creating it failed: ${error instanceof Error ? error.message : String(error)}. ` +
        "Create it yourself (createdb) or point DATABASE_URL at a database " +
        "your role may create.",
      { cause: error },
    );
  } finally {
    await maintenance.end();
  }
  return { sql: await connect(target), createdDatabase: true };
}

export interface DbSetupOptions {
  /** Target Postgres schema; defaults to "public", which is where the hub connects. */
  schema?: string;
}

export interface DbSetupReport {
  /** The database name from DATABASE_URL. */
  database: string;
  /** The Postgres schema the platform tables live in. */
  schema: string;
  /** Whether the database itself had to be created. */
  createdDatabase: boolean;
}

/**
 * Make the database in `databaseUrl` runnable: create it if missing,
 * then apply every migration the hub itself applies at boot
 * (`migrateHub`). Every migration is idempotent, so re-running this is
 * always safe and reports the same thing either way.
 */
export async function setupDatabase(
  databaseUrl: string,
  options: DbSetupOptions = {},
): Promise<DbSetupReport> {
  const schema = options.schema ?? "public";
  const target = dbTargetFromUrl(databaseUrl);
  const { sql, createdDatabase } = await ensureDatabase(target);
  await sql.end();

  const config = { ...target, schema };
  const { db } = createDB(config);
  const migrateHub = await loadMigrateHub();
  await migrateHub(config, db);

  return { database: target.database, schema, createdDatabase };
}

// Every installed package that owns a named schema of its own rather
// than the platform's `public`, so a reset that only drops `schema`
// would leave those tables behind. Always dropped alongside the target
// schema so a reset is a true clean slate for every installed
// package's tables, not only the platform's.
const PACKAGE_SCHEMAS = ["mailbox", "cron", "webhook_triggers", "memory"] as const;

/**
 * Drop the target schema and everything in it (platform tables and
 * auth tables), plus every installed package's own named schema. A
 * missing database is a no-op: there is nothing to drop. Pair with
 * setupDatabase for a from-scratch rebuild.
 */
export async function resetSchema(
  databaseUrl: string,
  options: DbSetupOptions = {},
): Promise<void> {
  const schema = options.schema ?? "public";
  const target = dbTargetFromUrl(databaseUrl);
  const probe = await connect(target);
  try {
    await probe.unsafe("SELECT 1");
  } catch (error) {
    await probe.end();
    if (pgErrorCode(error) === "3D000") return;
    throw new Error(
      [
        `Cannot connect to Postgres at ${target.host}:${target.port} ` +
          `(from DATABASE_URL): ${error instanceof Error ? error.message : String(error)}`,
        "Start a local Postgres and re-run. On macOS:",
        "",
        "  brew install postgresql@17 pgvector",
        "  brew services start postgresql@17",
      ].join("\n"),
      { cause: error },
    );
  }
  await probe.end();
  await dropIntxSchema(target, { schema });
  for (const packageSchema of PACKAGE_SCHEMAS) {
    await dropIntxSchema(target, { schema: packageSchema });
  }
}

// --- command-line entry ----------------------------------------------

function describeReport(report: DbSetupReport): string {
  const lines: string[] = [];
  if (report.createdDatabase) {
    lines.push(`created database ${JSON.stringify(report.database)}`);
  }
  lines.push(
    `applied migrations into schema ${JSON.stringify(report.schema)} of database ` +
      `${JSON.stringify(report.database)}`,
  );
  return lines.map((line) => `db-setup: ${line}`).join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const unknown = args.filter((a) => a !== "--reset");
  if (unknown.length > 0) {
    console.error(
      `db-setup: unknown argument(s): ${unknown.join(" ")}\n` +
        "usage: bun scripts/db-setup.ts [--reset]",
    );
    process.exit(1);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      [
        "db-setup: DATABASE_URL is not set.",
        "Create an env file from the template and re-run:",
        "",
        "  cp .env.example .env",
        "  bun scripts/db-setup.ts",
      ].join("\n"),
    );
    process.exit(1);
  }
  try {
    if (reset) {
      await resetSchema(databaseUrl);
      console.log("db-setup: dropped existing schema");
    }
    const report = await setupDatabase(databaseUrl);
    console.log(describeReport(report));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
