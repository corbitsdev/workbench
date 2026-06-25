/**
 * Database seeder - creates the dev user for local development.
 * Called after migrations in db-setup.ts
 */

import postgres from "postgres";

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

  return parseDatabaseUrl(databaseUrl);
}

const DB = resolveDBConfig();

async function seedDatabase(): Promise<void> {
  const client = postgres({
    host: DB.host,
    port: DB.port,
    user: DB.user,
    password: DB.password,
    database: DB.database,
    ssl: DB.ssl,
    max: 1,
  });

  console.log("Seeding database...");

  try {
    const existing = await client`
      SELECT id FROM "user" WHERE id = 'dev-user'
    `;

    if (existing.length > 0) {
      console.log("  (skip) Dev user already exists");
    } else {
      await client`
        INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at)
        VALUES ('dev-user', 'Dev User', 'dev@example.com', true, null, NOW(), NOW())
      `;
      console.log("  ✅ Dev user created: dev@example.com");
    }
  } catch (err) {
    console.error("  Database error:", err);
    if (err instanceof Error) {
      throw new Error(`Failed to seed database: ${err.message}`);
    }
    throw err;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  try {
    await seedDatabase();
    console.log("✅ Seeding complete.");
  } catch (err) {
    console.error("❌ Seeding failed:");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
