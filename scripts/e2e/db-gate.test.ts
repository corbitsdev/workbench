// Unit coverage for dbGate: a missing database must never skip in
// total silence. Without E2E_REQUIRED it returns describe.skip (the
// suite still skips quietly in local dev); with E2E_REQUIRED=1 (this
// repo's convention, see harness.ts's e2eDatabaseUrl) it throws
// instead, so CI can never report green on a suite that never ran.

import { afterEach, describe, expect, test } from "bun:test";
import { dbGate } from "./db-gate.ts";

const saved = process.env["E2E_REQUIRED"];

afterEach(() => {
  if (saved === undefined) delete process.env["E2E_REQUIRED"];
  else process.env["E2E_REQUIRED"] = saved;
});

describe("dbGate", () => {
  test("returns describe when a database URL is configured", () => {
    delete process.env["E2E_REQUIRED"];
    expect(dbGate("postgres://localhost:5432/workbench", "example")).toBe(
      describe,
    );
  });

  test("returns describe.skip when no database is configured and E2E_REQUIRED is unset", () => {
    delete process.env["E2E_REQUIRED"];
    expect(dbGate(undefined, "example")).toBe(describe.skip);
    expect(dbGate("", "example")).toBe(describe.skip);
  });

  test("throws when E2E_REQUIRED=1 but no database is configured", () => {
    process.env["E2E_REQUIRED"] = "1";
    expect(() => dbGate(undefined, "example-suite")).toThrow(
      /E2E_REQUIRED=1.*example-suite/,
    );
  });

  test("does not throw under E2E_REQUIRED=1 once a database is configured", () => {
    process.env["E2E_REQUIRED"] = "1";
    expect(dbGate("postgres://localhost:5432/workbench", "example")).toBe(
      describe,
    );
  });
});
