import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0056_granola_call_job.sql"),
  "utf8",
);

describe("migration 0056_granola_call_job", () => {
  it("creates granola_call_job with status/attempts/backoff columns", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "granola_call_job"');
    expect(sql).toContain('"tenant_id"');
    expect(sql).toContain('"note_id"');
    expect(sql).toContain('"status"');
    expect(sql).toContain('"attempts"');
    expect(sql).toContain('"next_attempt_at"');
  });

  it("enforces one job per (tenant, note) as the enqueue-dedupe backstop", () => {
    expect(sql).toContain("granola_call_job_tenant_note_uniq");
    expect(sql).toMatch(/UNIQUE INDEX.*\("tenant_id", "note_id"\)/s);
  });

  it("indexes the runner's claim query on (status, next_attempt_at)", () => {
    expect(sql).toContain("granola_call_job_status_next_attempt_idx");
  });

  it("documents workbench-only scope and does not touch interchange tables", () => {
    expect(sql.toLowerCase()).toContain("workbench-owned");
    expect(sql).not.toMatch(/\binference_/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"principal"/i);
  });
});
