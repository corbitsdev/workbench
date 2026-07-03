import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { timelineEntryKinds } from "./entry-schema";
import { timelineSources } from "./registry";
import { buildTimelineBranchQuery } from "./union-sql";

const dialect = new PgDialect();

const scope = { tenantId: "ten_test", principalIds: ["prn_test"] };

describe("timeline source registry", () => {
  test("registers all 13 sources, one per kind, kinds unique", () => {
    expect(timelineSources).toHaveLength(13);
    const kinds = timelineSources.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect([...kinds].sort()).toEqual([...timelineEntryKinds].sort());
  });

  test("every source table is registered exactly once per kind", () => {
    const pairs = timelineSources.map((s) => `${s.table}:${s.kind}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  test("every descriptor carries a tenant scope that binds the tenant id", () => {
    for (const source of timelineSources) {
      expect(source.tenantScope).toBeDefined();
      const query = dialect.sqlToQuery(
        buildTimelineBranchQuery(source, { scope, limit: 10 }),
      );
      expect(query.params).toContain(scope.tenantId);
      expect(query.sql).toContain('"tenant_id"');
    }
  });

  test("every descriptor carries a principal scope that binds the principal id", () => {
    for (const source of timelineSources) {
      expect(source.principalScope).toBeDefined();
      const query = dialect.sqlToQuery(
        buildTimelineBranchQuery(source, { scope, limit: 10 }),
      );
      expect(query.params).toContain("prn_test");
    }
  });

  test("only tool_call carries a client-supplied timestamp, and it is flagged with a note", () => {
    const clientSupplied = timelineSources.filter(
      (s) => s.timestamp.clientSupplied,
    );
    expect(clientSupplied.map((s) => s.kind)).toEqual(["tool_call"]);
    for (const source of clientSupplied) {
      expect(source.timestamp.note ?? "").not.toBe("");
    }
  });

  test("every summary projection is a static expression with no bound params", () => {
    for (const source of timelineSources) {
      expect(source.summarySql).not.toContain("$");
      expect(source.summarySql).not.toContain(";");
    }
  });

  test("soft-deletable sources exclude deleted rows", () => {
    const runs = timelineSources.find((s) => s.kind === "workflow_run");
    expect(runs?.filterSql).toContain("deleted_at is null");
  });
});
