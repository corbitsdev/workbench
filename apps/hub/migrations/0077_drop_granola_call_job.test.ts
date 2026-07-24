import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName, isTable, Table } from "drizzle-orm";
import * as schema from "../src/db/schema";

const sql = readFileSync(
  join(import.meta.dir, "0077_drop_granola_call_job.sql"),
  "utf8",
);

describe("migration 0077_drop_granola_call_job", () => {
  it("drops granola_call_job and its indexes", () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS "granola_call_job"/i);
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS "granola_call_job_tenant_note_uniq"/i,
    );
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS "granola_call_job_status_next_attempt_idx"/i,
    );
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS "granola_call_job_lease_until_idx"/i,
    );
  });

  it("drops granola_call_job from the drizzle schema too (no resurrection via the coverage guard)", () => {
    const schemaTables = Object.values(schema)
      .filter((value) => isTable(value))
      .map((table) => getTableName(table as Table));
    expect(schemaTables).not.toContain("granola_call_job");
  });
});
