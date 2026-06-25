/**
 * Drop and recreate the database.
 *
 * Use this to start fresh during development.
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

async function resetDatabase(): Promise<void> {
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
    console.log(`Dropping database "${DB.database}"...`);
    await sql.unsafe(
      `DROP DATABASE IF EXISTS "${DB.database.replace(/"/g, '""')}"`,
    );
    console.log(`Database dropped.`);

    console.log(`Creating database "${DB.database}"...`);
    await sql.unsafe(`CREATE DATABASE "${DB.database.replace(/"/g, '""')}"`);
    console.log(`Database created.`);
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  console.log("=== GTM Workbench DB Reset ===");

  try {
    await resetDatabase();
    console.log(
      "\n✅ DB reset complete. Run 'bun run db:setup' to reinitialize.",
    );
  } catch (err) {
    console.error("\n❌ DB reset failed:");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
