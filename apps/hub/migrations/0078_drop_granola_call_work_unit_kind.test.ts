import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workUnitKinds } from "../src/db/schema";

const sql = readFileSync(
  join(import.meta.dir, "0078_drop_granola_call_work_unit_kind.sql"),
  "utf8",
);

describe("migration 0078_drop_granola_call_work_unit_kind", () => {
  it("deletes orphaned granola_call work_unit rows", () => {
    expect(sql).toMatch(
      /DELETE FROM "work_unit" WHERE "kind" = 'granola_call'/i,
    );
  });

  it("granola_call is no longer a recognized work_unit kind in the drizzle schema", () => {
    expect(workUnitKinds as readonly string[]).not.toContain("granola_call");
    expect(workUnitKinds).toEqual(["knowledge_capture", "agent_task_turn"]);
  });
});
