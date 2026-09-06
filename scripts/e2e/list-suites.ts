// Prints a JSON array of e2e suite ids for the CI matrix: one id per
// scripts/e2e/*.test.ts file, except harness.test.ts, db-gate.test.ts, and
// db-setup.test.ts, which fold into a single "unit" entry (they cover pure
// helpers rather than a full hub+sidecar boot, so a single fast job covers
// all three instead of paying three boot costs).
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const UNIT_SUITE_FILES = [
  "harness",
  "db-gate",
  "db-setup",
  "list-suites",
] as const;

export async function listSuites(e2eDir: string): Promise<string[]> {
  const entries = await readdir(e2eDir, { withFileTypes: true });
  const suiteNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name.slice(0, -".test.ts".length));

  const unitFiles = new Set<string>(UNIT_SUITE_FILES);
  const suites = suiteNames.filter((name) => !unitFiles.has(name));
  if (suiteNames.some((name) => unitFiles.has(name))) suites.push("unit");

  return suites.sort();
}

if (import.meta.main) {
  const suites = await listSuites(join(import.meta.dir));
  console.log(JSON.stringify(suites));
}
