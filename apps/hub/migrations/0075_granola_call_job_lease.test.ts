import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0075_granola_call_job_lease.sql"),
  "utf8",
);

describe("migration 0075_granola_call_job_lease", () => {
  it("adds lease columns and index on granola_call_job", () => {
    expect(sql).toContain("lease_owner");
    expect(sql).toContain("lease_until");
    expect(sql).toContain("granola_call_job_lease_until_idx");
  });
});
