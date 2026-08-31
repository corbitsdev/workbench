// Unit coverage for the isolation suite's database gate: a missing
// DATABASE_URL/ISOLATION_DATABASE_URL must only ever skip quietly in
// local dev, never in CI. dbGate's CI=true convention is this repo's
// one signal for that, so this test proves resolveDatabaseUrl honors
// it identically.

import { afterEach, describe, expect, test } from "bun:test";
import { resolveDatabaseUrl } from "./setup.ts";

const gatedKeys = [
  "DATABASE_URL",
  "ISOLATION_DATABASE_URL",
  "CI",
  "GITHUB_JOB",
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
  test("returns undefined when no database is configured and CI is unset", () => {
    unset("DATABASE_URL");
    unset("ISOLATION_DATABASE_URL");
    unset("CI");
    unset("GITHUB_JOB");
    unset("E2E_REQUIRED");
    expect(resolveDatabaseUrl()).toBeUndefined();
  });

  test("throws when CI=true but no database is configured", () => {
    unset("DATABASE_URL");
    unset("ISOLATION_DATABASE_URL");
    process.env["CI"] = "true";
    unset("GITHUB_JOB");
    expect(() => resolveDatabaseUrl()).toThrow(
      /docker compose -f docker-compose\.test\.yml up -d/,
    );
  });

  test("ISOLATION_DATABASE_URL wins over DATABASE_URL", () => {
    process.env["DATABASE_URL"] = "postgres://localhost:5432/other";
    process.env["ISOLATION_DATABASE_URL"] =
      "postgres://localhost:5432/isolation";
    unset("CI");
    expect(resolveDatabaseUrl()).toBe("postgres://localhost:5432/isolation");
  });

  test("CI=true does not throw once a database is configured", () => {
    process.env["DATABASE_URL"] = "postgres://localhost:5432/workbench";
    unset("ISOLATION_DATABASE_URL");
    process.env["CI"] = "true";
    unset("GITHUB_JOB");
    expect(resolveDatabaseUrl()).toBe("postgres://localhost:5432/workbench");
  });

  test("does not treat E2E_REQUIRED as a required-ness signal", () => {
    unset("DATABASE_URL");
    unset("ISOLATION_DATABASE_URL");
    unset("CI");
    process.env["E2E_REQUIRED"] = "1";
    expect(resolveDatabaseUrl()).toBeUndefined();
  });
});
