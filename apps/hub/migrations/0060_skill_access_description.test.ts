import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0060_skill_access_description.sql"),
  "utf8",
);

describe("migration 0060_skill_access_description", () => {
  it("adds a nullable description column to skill_access", () => {
    expect(sql).toContain('ALTER TABLE "skill_access"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "description" text');
  });

  it("documents workbench-only scope and does not touch interchange tables", () => {
    expect(sql.toLowerCase()).toContain("workbench-owned");
    expect(sql).not.toMatch(/ALTER TABLE\s+"asset"/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"principal"/i);
  });
});
