// Central definition of "this suite needs a real database." Every
// DB-gated suite defines its own describeIfDb by hand-checking
// DATABASE_URL, which means a missing database skips the suite in
// total silence — a broken CI env would report green the same way a
// real pass does. dbGate is the one place that decides what a skip
// means: it counts the skip, prints an unmissable summary once the
// run ends, and — under E2E_REQUIRED=1 (this repo's convention for
// turning a DB skip into a hard failure, see harness.ts) — throws
// instead of skipping.
import { afterAll, describe } from "bun:test";

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
    "To run them: docker compose -f docker-compose.test.yml up -d, then",
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/workbench bun test ...",
    "Set E2E_REQUIRED=1 to make a skip like this a hard failure (CI does).",
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
  skipped.push(label);
  afterAll(printSummary);
  if (process.env["E2E_REQUIRED"] === "1") {
    throw new Error(
      `E2E_REQUIRED=1 but DATABASE_URL is not set; "${label}" would be skipped.`,
    );
  }
  return describe.skip;
}
