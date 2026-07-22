import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(import.meta.dir, "0074_work_unit.sql"), "utf8");

describe("migration 0074_work_unit", () => {
  it("creates work_unit with lease + idempotency uniqueness", () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "work_unit"');
    expect(sql).toContain('"lease_owner"');
    expect(sql).toContain('"lease_until"');
    expect(sql).toContain('"idempotency_key"');
    expect(sql).toContain('"status"');
    expect(sql).toContain("work_unit_tenant_kind_key_uniq");
    expect(sql).toContain("work_unit_claim_idx");
    expect(sql).toContain("pending");
    expect(sql).toContain("leased");
    expect(sql).toContain("done");
    expect(sql).toContain("dead");
  });
});
