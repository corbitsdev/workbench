// Tears down local state so the next `bun run dev` lands on a virgin
// onboarding flow: drops the platform schema (database, auth tables,
// every installed package's tables, and the db-setup ledger all live
// in the same schema, so one drop clears them all) and removes the
// on-disk directories the hub and the dev sidecar keep durable repo
// and asset state in.
//
// Refuses outright against a non-local DATABASE_URL — there is no
// override. A schema drop is unrecoverable, and this script exists for
// local onboarding testing, never for a real deployment.
//
// Exported surface (consumed by the CLI's `reset` verb):
//
//   resetLocalState(env)  -> ResetReport
//
// Run directly: `bun scripts/reset.ts` (reads DATABASE_URL and
// HUB_DATA_DIR from the environment, same as `bun run dev`).

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { readHubConfig } from "../apps/hub/src/config.ts";
import { resetSchema } from "./db-setup.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

const LOCAL_DATABASE_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuse to reset against a database that is not plainly local. There
 * is no confirmation flag to bypass this — a hosted or shared
 * DATABASE_URL should never be reachable through this path at all.
 */
export function requireLocalDatabase(databaseUrl: string): void {
  const { hostname } = new URL(databaseUrl);
  if (LOCAL_DATABASE_HOSTNAMES.has(hostname)) return;
  throw new Error(
    [
      `refusing to reset: DATABASE_URL's host ${JSON.stringify(hostname)} is not local`,
      "(expected localhost, 127.0.0.1, or ::1).",
      "workbench reset only ever targets a laptop's own database; point",
      "DATABASE_URL at a local Postgres to use it.",
    ].join("\n"),
  );
}

/**
 * The on-disk directories a local `bun run dev` checkout keeps durable
 * state in: the hub's `HUB_DATA_DIR` (resolved the same way the hub
 * itself resolves it — against `apps/hub`'s working directory) and the
 * dev sidecar's data directory, which `scripts/dev.ts` always pins to
 * `.data/sidecar` at the repo root regardless of `SIDECAR_DATA_DIR`.
 */
export function resolveLocalStateDirs(
  root: string,
  hubDataDir: string,
): { hubDataDir: string; sidecarDataDir: string } {
  return {
    hubDataDir: path.resolve(path.join(root, "apps", "hub"), hubDataDir),
    sidecarDataDir: path.join(root, ".data", "sidecar"),
  };
}

export type ResetReport = {
  database: string;
  removedDirs: string[];
};

export type ResetDeps = {
  root: string;
  resetSchema: typeof resetSchema;
  rm: typeof rm;
  exists: typeof existsSync;
};

const defaultDeps: ResetDeps = {
  root: repoRoot,
  resetSchema,
  rm,
  exists: existsSync,
};

/**
 * Drop the platform schema and remove the on-disk asset directories,
 * leaving a checkout in the same state as a fresh clone with `.env`
 * already filled in. `bun run dev` recreates the schema and the
 * directories on its next start.
 */
export async function resetLocalState(
  env: Record<string, string | undefined>,
  deps: ResetDeps = defaultDeps,
): Promise<ResetReport> {
  const config = readHubConfig(env);
  requireLocalDatabase(config.databaseUrl);

  await deps.resetSchema(config.databaseUrl);

  const dirs = resolveLocalStateDirs(deps.root, config.hubDataDir);
  const removedDirs: string[] = [];
  for (const dir of [dirs.hubDataDir, dirs.sidecarDataDir]) {
    if (!deps.exists(dir)) continue;
    await deps.rm(dir, { recursive: true, force: true });
    removedDirs.push(dir);
  }

  const database = new URL(config.databaseUrl).pathname.replace(/^\//, "");
  return { database, removedDirs };
}

if (import.meta.main) {
  const envFile = path.join(repoRoot, ".env");
  if (!existsSync(envFile)) {
    console.error(
      [
        `No .env file found in ${repoRoot}.`,
        "Create one from the template and re-run:",
        "",
        "  cp .env.example .env",
        "  bun scripts/reset.ts",
      ].join("\n"),
    );
    process.exit(1);
  }
  try {
    const report = await resetLocalState(process.env);
    console.log(
      `reset: dropped the platform schema in database ${JSON.stringify(report.database)}`,
    );
    if (report.removedDirs.length === 0) {
      console.log("reset: no on-disk asset directories were present");
    } else {
      for (const dir of report.removedDirs) {
        console.log(`reset: removed ${dir}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
