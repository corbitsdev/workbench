// Central definition of "this suite needs a real database." Every
// DB-gated suite defines its own describeIfDb by hand-checking
// DATABASE_URL, which means a missing database skips the suite in
// total silence — a broken CI env would report green the same way a
// real pass does. dbGate is the one place that decides what a skip
// means: it counts the skip, prints an unmissable summary once the
// run ends, and — when CI=true (except GitHub jobs that never
// provision Postgres) — throws instead of skipping.
import { afterAll, describe } from "bun:test";

export const TEST_COMPOSE_FILE = "docker-compose.test.yml";
export const TEST_COMPOSE_UP = `docker compose -f ${TEST_COMPOSE_FILE} up -d`;
export const TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/workbench";

export const MISSING_DATABASE_HINT =
  `Start Postgres with \`${TEST_COMPOSE_UP}\`, then ` +
  `DATABASE_URL=${TEST_DATABASE_URL} bun test ...`;

// GitHub Actions sets CI=true on every job. The unit/structural jobs
// never provision Postgres; DB-gated suites skip there (loudly) and
// run in e2e / isolation / db-suites, which do. Any other CI context
// — including `CI=true bun test` locally — treats a missing
// DATABASE_URL as a hard failure so a miswired pipeline cannot skip
// green.
const CI_JOBS_WITHOUT_POSTGRES = new Set([
  "lint",
  "typecheck",
  "build-test",
  "structural",
]);

export function databaseIsRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["CI"] !== "true") return false;
  const job = env["GITHUB_JOB"];
  if (job !== undefined && job !== "" && CI_JOBS_WITHOUT_POSTGRES.has(job)) {
    return false;
  }
  return true;
}

export function missingDatabaseError(label: string): Error {
  return new Error(
    `DATABASE_URL is not set; "${label}" cannot run. ${MISSING_DATABASE_HINT}`,
  );
}

export function skippedDatabaseWarning(label: string): string {
  return `${label}: DATABASE_URL is not set; suite skipped. ${MISSING_DATABASE_HINT}`;
}

export function assertDatabaseConfigured(
  databaseUrl: string | undefined,
  label: string,
): void {
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
 * databaseUrl: the resolved DATABASE_URL (or "" / undefined when absent).
 * label: identifies the skipped suite in the summary — pass import.meta.path.
 */
export function dbGate(
  databaseUrl: string | undefined,
  label: string,
): typeof describe {
  if (databaseUrl !== undefined && databaseUrl !== "") return describe;
  if (databaseIsRequired()) throw missingDatabaseError(label);
  skipped.push(label);
  afterAll(printSummary);
  return describe.skip;
}
