import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifact } from "../src/db/schema";

const sql = readFileSync(
  join(import.meta.dir, "0079_drop_artifact_status.sql"),
  "utf8",
);

describe("migration 0079_drop_artifact_status", () => {
  it("drops artifact.status", () => {
    expect(sql).toMatch(
      /ALTER TABLE "artifact" DROP COLUMN IF EXISTS "status"/,
    );
  });

  it("status is no longer a column in the Drizzle artifact schema", () => {
    expect(Object.keys(artifact)).not.toContain("status");
  });

  it("no artifactStatus export remains in the schema module", () => {
    const schemaSource = readFileSync(
      join(import.meta.dir, "..", "src", "db", "schema.ts"),
      "utf8",
    );
    expect(schemaSource).not.toContain("artifactStatus");
  });
});
