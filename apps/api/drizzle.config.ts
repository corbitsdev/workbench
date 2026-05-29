import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    host: process.env["DB_HOST"] ?? "localhost",
    port: Number(process.env["DB_PORT"] ?? "5433"),
    user: process.env["DB_USER"] ?? "workbench",
    password: process.env["DB_PASSWORD"] ?? "workbench-dev-password",
    database: process.env["DB_NAME"] ?? "workbench",
  },
});
