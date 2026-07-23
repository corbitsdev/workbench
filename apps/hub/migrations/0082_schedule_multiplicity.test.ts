import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduledTrigger } from "../src/db/schema";

const sql = readFileSync(
  join(import.meta.dir, "0082_schedule_multiplicity.sql"),
  "utf8",
);

describe("migration 0082_schedule_multiplicity", () => {
  it("drops the personal (tenant, owner, kind) partial unique index", () => {
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS "scheduled_trigger_personal_owner_kind_uniq"/,
    );
  });

  it("drops the tenant (tenant, kind) partial unique index", () => {
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS "scheduled_trigger_tenant_kind_uniq"/,
    );
  });

  it("adds a name column", () => {
    expect(sql).toMatch(/ADD COLUMN "name" text/);
  });

  it("backfills name from workflow_kind for existing rows", () => {
    expect(sql).toMatch(
      /SET "name" = "workflow_kind"\s*\nWHERE "name" IS NULL/,
    );
  });

  it("makes name NOT NULL with a non-empty check, after the backfill", () => {
    const backfillIdx = sql.indexOf('SET "name" = "workflow_kind"');
    const notNullIdx = sql.indexOf('ALTER COLUMN "name" SET NOT NULL');
    expect(backfillIdx).toBeGreaterThan(-1);
    expect(notNullIdx).toBeGreaterThan(backfillIdx);
    expect(sql).toMatch(/CHECK \(length\("name"\) > 0\)/);
  });

  it("name is a Drizzle column", () => {
    expect(Object.keys(scheduledTrigger)).toContain("name");
  });

  it("adds a (tenant, owner, kind, name) unique index for personal schedules", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "scheduled_trigger_personal_owner_kind_name_uniq"\s*\n\s*ON "scheduled_trigger" \("tenant_id", "owner_member_principal_id", "workflow_kind", "name"\)\s*\n\s*WHERE "scope" = 'personal'/,
    );
  });

  it("adds a (tenant, kind, name) unique index for tenant-scoped schedules", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "scheduled_trigger_tenant_kind_name_uniq"\s*\n\s*ON "scheduled_trigger" \("tenant_id", "workflow_kind", "name"\)\s*\n\s*WHERE "scope" = 'tenant'/,
    );
  });
});
