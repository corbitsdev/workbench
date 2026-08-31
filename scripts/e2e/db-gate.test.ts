// Unit coverage for dbGate: a missing database must never skip in
// total silence. Locally (CI unset) it returns describe.skip and the
// summary names `docker-compose.test.yml`. Under CI=true it throws
// instead, so a miswired pipeline cannot report green on a suite that
// never ran. GitHub's unit/structural jobs have no Postgres and are
// not required; they still skip with the same compose hint.

import { afterEach, describe, expect, test } from "bun:test";
import { databaseIsRequired, dbGate } from "./db-gate.ts";

const gatedKeys = ["CI", "GITHUB_JOB", "E2E_REQUIRED"] as const;
const saved = new Map(gatedKeys.map((key) => [key, process.env[key]]));

function unset(key: (typeof gatedKeys)[number]): void {
  delete process.env[key];
}

afterEach(() => {
  for (const key of gatedKeys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("databaseIsRequired", () => {
  test("is false when CI is unset, even if E2E_REQUIRED=1", () => {
    unset("CI");
    unset("GITHUB_JOB");
    process.env["E2E_REQUIRED"] = "1";
    expect(databaseIsRequired()).toBe(false);
  });

  test("is true when CI=true and the job is not a unit/structural job", () => {
    process.env["CI"] = "true";
    unset("GITHUB_JOB");
    expect(databaseIsRequired()).toBe(true);
    process.env["GITHUB_JOB"] = "e2e";
    expect(databaseIsRequired()).toBe(true);
    process.env["GITHUB_JOB"] = "isolation";
    expect(databaseIsRequired()).toBe(true);
    process.env["GITHUB_JOB"] = "db-suites";
    expect(databaseIsRequired()).toBe(true);
  });

  test("is false on GitHub jobs that never provision Postgres", () => {
    process.env["CI"] = "true";
    process.env["GITHUB_JOB"] = "build-test";
    expect(databaseIsRequired()).toBe(false);
    process.env["GITHUB_JOB"] = "structural";
    expect(databaseIsRequired()).toBe(false);
    process.env["GITHUB_JOB"] = "lint";
    expect(databaseIsRequired()).toBe(false);
    process.env["GITHUB_JOB"] = "typecheck";
    expect(databaseIsRequired()).toBe(false);
  });
});

describe("dbGate", () => {
  test("returns describe when a database URL is configured", () => {
    process.env["CI"] = "true";
    unset("GITHUB_JOB");
    expect(dbGate("postgres://localhost:5432/workbench", "example")).toBe(
      describe,
    );
  });

  test("returns describe.skip when no database is configured and CI is unset", () => {
    unset("CI");
    unset("GITHUB_JOB");
    expect(dbGate(undefined, "example")).toBe(describe.skip);
    expect(dbGate("", "example")).toBe(describe.skip);
  });

  test("does not treat E2E_REQUIRED as a required-ness signal", () => {
    unset("CI");
    unset("GITHUB_JOB");
    process.env["E2E_REQUIRED"] = "1";
    expect(dbGate(undefined, "example")).toBe(describe.skip);
  });

  test("throws when CI=true but no database is configured", () => {
    process.env["CI"] = "true";
    unset("GITHUB_JOB");
    expect(() => dbGate(undefined, "example-suite")).toThrow(/example-suite/);
    expect(() => dbGate(undefined, "example-suite")).toThrow(
      /docker compose -f docker-compose\.test\.yml up -d/,
    );
    expect(() => dbGate("", "example-suite")).toThrow(
      /postgres:\/\/postgres:postgres@localhost:5432\/workbench/,
    );
  });

  test("does not throw under CI=true once a database is configured", () => {
    process.env["CI"] = "true";
    unset("GITHUB_JOB");
    expect(dbGate("postgres://localhost:5432/workbench", "example")).toBe(
      describe,
    );
  });

  test("skips on the GitHub unit job even when CI=true", () => {
    process.env["CI"] = "true";
    process.env["GITHUB_JOB"] = "build-test";
    expect(dbGate(undefined, "example")).toBe(describe.skip);
  });
});
