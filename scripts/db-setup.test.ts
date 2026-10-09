// Unit coverage for scripts/db-setup.ts's pure derivation helpers, runnable
// without any Postgres. The schema-migration regression (that provisioning the
// _e2e sibling also runs migrateHub against it) is covered in e2e/
// db-gate-reachable.test.ts's schema-presence probe, which is DB-gated.
import { describe, expect, test } from "bun:test";

import { dbTargetFromUrl, e2eSiblingTarget } from "./db-setup";

describe("dbTargetFromUrl", () => {
  test("parses a postgres URL into its connection target", () => {
    expect(dbTargetFromUrl("postgres://user:pass@localhost:5432/workbench")).toEqual({
      host: "localhost",
      port: 5432,
      user: "user",
      password: "pass",
      database: "workbench",
    });
  });

  test("defaults the port and decodes url-encoded credentials", () => {
    // postgresql (long) protocol is accepted too, and an empty port falls back
    // to 5432.
    expect(dbTargetFromUrl("postgresql://u:%40x@db:9999/bench")).toEqual({
      host: "db",
      port: 9999,
      user: "u",
      password: "@x",
      database: "bench",
    });
  });

  test("rejects a non-postgres protocol", () => {
    expect(() => dbTargetFromUrl("mysql://localhost/db")).toThrow(/postgres/);
  });

  test("rejects a url with no database name", () => {
    expect(() => dbTargetFromUrl("postgres://localhost")).toThrow(/names no database/);
  });
});

describe("e2eSiblingTarget", () => {
  test("derives the _e2e sibling name on the same server and credentials", () => {
    expect(e2eSiblingTarget(dbTargetFromUrl("postgres://u:p@h:5433/workbench"))).toEqual({
      host: "h",
      port: 5433,
      user: "u",
      password: "p",
      database: "workbench_e2e",
    });
  });

  test("is idempotent when the database already ends _e2e", () => {
    expect(e2eSiblingTarget(dbTargetFromUrl("postgres://h/workbench_e2e"))).toMatchObject({
      database: "workbench_e2e",
    });
  });
});
