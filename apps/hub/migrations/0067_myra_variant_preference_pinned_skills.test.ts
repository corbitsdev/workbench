import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0067_myra_variant_preference_pinned_skills.sql"),
  "utf8",
);

describe("migration 0067_myra_variant_preference_pinned_skills", () => {
  it("adds pinned_skill_ids to myra_variant_preference", () => {
    expect(sql).toContain('ALTER TABLE "myra_variant_preference"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "pinned_skill_ids" jsonb');
    expect(sql).toContain("DEFAULT '[]'::jsonb");
  });

  it("does not touch interchange-owned tables", () => {
    expect(sql).not.toMatch(/ALTER TABLE\s+"asset"/i);
  });
});