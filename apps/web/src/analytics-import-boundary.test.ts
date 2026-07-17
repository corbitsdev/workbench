import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("analytics import boundary", () => {
  test("no web source imports the @workbench/analytics barrel", () => {
    // The barrel (packages/analytics/src/index.ts) exports the server-side
    // query/subscriber/route modules, which value-import @intx/db. Importing
    // it from the browser pulls the postgres.js driver into the bundle and
    // crashes the app at load with "Buffer is not defined" (CL-3737).
    // Browser code must import the client-safe subpath
    // "@workbench/analytics/model-tokens" instead.
    const offenders = sourceFiles(path.join(import.meta.dir)).filter((file) =>
      /from\s+["']@workbench\/analytics["']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
