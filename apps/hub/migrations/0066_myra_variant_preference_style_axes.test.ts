import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0066_myra_variant_preference_style_axes.sql"),
  "utf8",
);

describe("migration 0066_myra_variant_preference_style_axes", () => {
  it("adds the global and per-surface style-axis columns to myra_variant_preference", () => {
    expect(sql).toContain('ALTER TABLE "myra_variant_preference"');
    for (const column of [
      "personality",
      "emoji_use",
      "ui_type",
      "artifact_usage_chat",
      "artifact_usage_triage",
      "tool_usage_chat",
      "tool_usage_triage",
      "skill_usage_chat",
      "skill_usage_triage",
    ]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS "${column}" text`);
    }
  });

  it("does not touch any interchange-owned table", () => {
    expect(sql).not.toMatch(/ALTER TABLE\s+"asset"/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"principal"/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+"agent"/i);
  });
});
