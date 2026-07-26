import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0054_scheduled_trigger_fire_history.sql"),
  "utf8",
);

describe("migration 0054_scheduled_trigger_fire_history", () => {
  it("adds last_run_id on scheduled_trigger", () => {
    expect(sql).toContain('ALTER TABLE "scheduled_trigger"');
    expect(sql).toContain('"last_run_id"');
  });

  it("creates scheduled_trigger_fire with schedule FK and fired_at index", () => {
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS "scheduled_trigger_fire"',
    );
    expect(sql).toContain('"scheduled_trigger_id"');
    expect(sql).toContain('"run_id"');
    expect(sql).toContain("scheduled_trigger_fire_schedule_fired_idx");
  });

  it("documents workbench-only scope and does not touch interchange tables", () => {
    expect(sql.toLowerCase()).toContain("workbench-owned");
    expect(sql).not.toMatch(/\binference_/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"principal"/i);
  });
});
