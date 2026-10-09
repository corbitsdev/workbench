// Central definition of "this suite needs a real database." Every
// DB-gated suite defines its own describeIfDb by hand-checking
// DATABASE_URL, which means a missing database skips the suite in
// total silence — a broken CI env would report green the same way a
// real pass does. dbGate is the one place that decides what a skip
// means: it counts the skip, prints an unmissable summary once the
// run ends, and — when CI=true (except GitHub jobs that never
// provision Postgres) — throws instead of skipping.
import { afterAll, describe } from "bun:test";

import { e2eDatabaseUrl } from "./database-url";

export const TEST_COMPOSE_FILE = "compose.test.yml";
export const TEST_COMPOSE_UP = `docker compose -f ${TEST_COMPOSE_FILE} up -d`;
export const TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/workbench";

export const MISSING_DATABASE_HINT =
  `Start Postgres with \`${TEST_COMPOSE_UP}\`, then ` +
  `DATABASE_URL=${TEST_DATABASE_URL} bun test ...`;

// GitHub Actions sets CI=true on every job. None of ci.yml's jobs
// provision Postgres (dropped the db-backed e2e/isolation/
// db-suites jobs), so every DB-gated suite skips there (loudly). Any
// other CI context — including `CI=true bun test` locally — treats a
// missing DATABASE_URL as a hard failure so a miswired pipeline cannot
// skip green.
const CI_JOBS_WITHOUT_POSTGRES = new Set(["setup", "lint", "typecheck", "unit"]);

export function databaseIsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["CI"] !== "true") return false;
  const job = env["GITHUB_JOB"];
  if (job !== undefined && job !== "" && CI_JOBS_WITHOUT_POSTGRES.has(job)) {
    return false;
  }
  return true;
}

export function missingDatabaseError(label: string): Error {
  return new Error(`DATABASE_URL is not set; "${label}" cannot run. ${MISSING_DATABASE_HINT}`);
}

export function skippedDatabaseWarning(label: string): string {
  return `${label}: DATABASE_URL is not set; suite skipped. ${MISSING_DATABASE_HINT}`;
}

export function assertDatabaseConfigured(databaseUrl: string | undefined, label: string): void {
  if (databaseUrl !== undefined && databaseUrl !== "") return;
  if (databaseIsRequired()) throw missingDatabaseError(label);
}

// `bun test` never fires `process.on("exit"/"beforeExit")` handlers, so a
// true end-of-run hook does not exist across files — each skipped file
// registers its own `afterAll`, printed against the shared, growing list
// below. The last skip of the run is always the one whose banner shows
// the complete count, so nothing is lost; earlier banners just show the
// running total, which is itself already loud enough not to miss.
const skipped: string[] = [];

function printSummary(): void {
  const rule = "=".repeat(78);
  const lines = [
    "",
    rule,
    `SKIPPED ${skipped.length} DB-gated suite(s) so far — no DATABASE_URL. This is NOT a pass.`,
    ...skipped.map((label) => `  - ${label}`),
    "",
    `To run them: ${TEST_COMPOSE_UP}, then`,
    `DATABASE_URL=${TEST_DATABASE_URL} bun test ...`,
    "CI=true turns a skip like this into a hard failure.",
    rule,
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

/**
 * databaseUrl: the raw configured DATABASE_URL (or "" / undefined when
 * absent). label: identifies the skipped suite in the summary — pass
 * import.meta.path.
 *
 * Every DB-gated suite runs against the `_e2e` sibling database, never the
 * developer's own `DATABASE_URL`: when a database is configured, dbGate
 * redirects the resolved url (via e2eDatabaseUrl) onto the derived `_e2e`
 * database and propagates it onto process.env.DATABASE_URL so bootHub and
 * every direct-DB read hit the sibling the suite owns outright. When
 * DATABASE_URL is unset the suite skips (hard failure in CI that provisions
 * Postgres), exactly as before.
 */
export function dbGate(databaseUrl: string | undefined, label: string): typeof describe {
  if (databaseUrl !== undefined && databaseUrl !== "") {
    const e2eUrl = e2eDatabaseUrl();
    if (e2eUrl !== undefined) {
      // Fail closed: a DB-gated suite must only ever run against the derived
      // `_e2e` sibling, never the developer's own database. If the resolver
      // ever regresses into returning a non-`_e2e` URL, refuse to redirect
      // rather than silently run e2e against the real DB.
      const e2eDatabase = new URL(e2eUrl).pathname.replace(/^\//, "");
      if (!e2eDatabase.endsWith("_e2e")) {
        throw new Error(
          `Resolved e2e database does not target a _e2e sibling: ${e2eUrl}. ` +
            "Refusing to run a DB-gated suite against a non-_e2e database.",
        );
      }
      process.env["DATABASE_URL"] = e2eUrl;
    }
    return describe;
  }
  if (databaseIsRequired()) throw missingDatabaseError(label);
  skipped.push(label);
  afterAll(printSummary);
  return describe.skip;
}
