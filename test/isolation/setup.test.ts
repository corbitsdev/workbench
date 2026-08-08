// Unit coverage for the isolation suite's database gate: a missing
// DATABASE_URL/ISOLATION_DATABASE_URL must only ever skip quietly in
// local dev, never in CI. E2E_REQUIRED=1 is this repo's one convention
// for that (see scripts/e2e/harness.ts's e2eDatabaseUrl), so this test
// proves resolveDatabaseUrl honors it identically.

import { afterEach, describe, expect, test } from "bun:test";
import { resolveDatabaseUrl } from "./setup.ts";

const gatedKeys = [
  "DATABASE_URL",
  "ISOLATION_DATABASE_URL",
  "E2E_REQUIRED",
] as const;
const saved = new Map(gatedKeys.map((key) => [key, process.env[key]]));

/** Unsets a gated variable for the duration of one test; an empty
 * string reads as "not configured" to resolveDatabaseUrl, same as a
 * variable the shell never set. */
function unset(key: (typeof gatedKeys)[number]): void {
  process.env[key] = "";
}

afterEach(() => {
  for (const key of gatedKeys) {
    process.env[key] = saved.get(key) ?? "";
  }
});

describe("resolveDatabaseUrl", () => {
  test("returns undefined when no database is configured and E2E_REQUIRED is unset", () => {
    unset("DATABASE_URL");
    unset("ISOLATION_DATABASE_URL");
    unset("E2E_REQUIRED");
    expect(resolveDatabaseUrl()).toBeUndefined();
  });

  test("throws when E2E_REQUIRED=1 but no database is configured", () => {
    unset("DATABASE_URL");
    unset("ISOLATION_DATABASE_URL");
    process.env["E2E_REQUIRED"] = "1";
    expect(() => resolveDatabaseUrl()).toThrow(/E2E_REQUIRED=1/);
  });

  test("ISOLATION_DATABASE_URL wins over DATABASE_URL", () => {
    process.env["DATABASE_URL"] = "postgres://localhost:5432/other";
    process.env["ISOLATION_DATABASE_URL"] =
      "postgres://localhost:5432/isolation";
    unset("E2E_REQUIRED");
    expect(resolveDatabaseUrl()).toBe("postgres://localhost:5432/isolation");
  });

  test("E2E_REQUIRED=1 does not throw once a database is configured", () => {
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    unset("ISOLATION_DATABASE_URL");
    process.env["E2E_REQUIRED"] = "1";
    expect(resolveDatabaseUrl()).toBe("postgres://localhost:5432/workbench");
  });
});
