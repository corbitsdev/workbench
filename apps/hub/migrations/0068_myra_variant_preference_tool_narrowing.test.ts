import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(import.meta.dir, "0068_myra_variant_preference_tool_narrowing.sql"),
  "utf8",
);

describe("migration 0068_myra_variant_preference_tool_narrowing", () => {
  it("adds disabled catalog package and tool name columns", () => {
    expect(sql).toContain('ALTER TABLE "myra_variant_preference"');
    expect(sql).toContain("disabled_catalog_packages");
    expect(sql).toContain("disabled_tool_names");
  });
});
