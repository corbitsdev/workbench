import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDB } from "@intx/db";
import { getLogger } from "@intx/log";

const log = getLogger(["api", "migrate"]);

const dbConfig = {
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? "5433"),
  user: process.env["DB_USER"] ?? "workbench",
  password: process.env["DB_PASSWORD"] ?? "workbench-dev-password",
  database: process.env["DB_NAME"] ?? "workbench",
};

const { db, close } = createDB(dbConfig);

async function runMigrations() {
  let migrationError: unknown;
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dir, "../../migrations") });
    log.info("Migrations completed successfully");
  } catch (error) {
    migrationError = error;
    log.error("Migration failed", { error });
  } finally {
    try {
      await close();
    } catch (closeError) {
      log.error("Failed to close database connection", { closeError });
    }
  }
  if (migrationError) {
    throw migrationError;
  }
}

runMigrations();
