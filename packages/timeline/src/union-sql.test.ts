import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { timelineSources } from "./registry";
import { buildTimelineUnionQuery } from "./union-sql";

const dialect = new PgDialect();

const scope = { tenantId: "ten_test", principalId: "prn_test" };

function render(args: Parameters<typeof buildTimelineUnionQuery>[0]) {
  return dialect.sqlToQuery(buildTimelineUnionQuery(args));
}

describe("buildTimelineUnionQuery", () => {
  test("emits one branch per registered source, joined with union all", () => {
    const { sql } = render({ scope, limit: 20 });
    const unions = sql.match(/union all/g) ?? [];
    expect(unions).toHaveLength(timelineSources.length - 1);
  });

  test("every branch emits the identical column set with text-cast ids", () => {
    const { sql } = render({ scope, limit: 20 });
    for (const alias of [
      "as id",
      "as kind",
      "as source_table",
      "as ts",
      "as summary",
    ]) {
      const count = sql.match(new RegExp(alias, "g")) ?? [];
      expect(count.length).toBeGreaterThanOrEqual(timelineSources.length);
    }
    const casts = sql.match(/cast\([^)]+ as text\)/g) ?? [];
    expect(casts.length).toBeGreaterThanOrEqual(timelineSources.length);
    const normalized = sql.match(/::timestamptz/g) ?? [];
    expect(normalized.length).toBeGreaterThanOrEqual(timelineSources.length);
  });

  test("binds tenant and principal params for every branch", () => {
    const { params } = render({ scope, limit: 20 });
    const tenantBinds = params.filter((p) => p === scope.tenantId);
    const principalBinds = params.filter((p) => p === scope.principalId);
    expect(tenantBinds.length).toBeGreaterThanOrEqual(timelineSources.length);
    expect(principalBinds.length).toBeGreaterThanOrEqual(
      timelineSources.length,
    );
  });

  test("uses keyset pagination, never OFFSET", () => {
    const noCursor = render({ scope, limit: 20 });
    expect(noCursor.sql.toLowerCase()).not.toContain("offset");

    const cursor = {
      timestamp: "2026-07-01T00:00:00.000Z",
      sourceTable: "artifact",
      id: "abc",
    };
    const withCursor = render({ scope, limit: 20, cursor });
    expect(withCursor.sql.toLowerCase()).not.toContain("offset");
    expect(withCursor.params).toContain(cursor.timestamp);
    expect(withCursor.params).toContain(cursor.id);
    expect(withCursor.sql.length).toBeGreaterThan(noCursor.sql.length);
  });

  test("orders by the composite sort key and applies per-branch and outer limits", () => {
    const { sql, params } = render({ scope, limit: 25 });
    expect(sql).toContain("order by ts desc, source_table asc, id asc");
    const limitBinds = params.filter((p) => p === 25);
    expect(limitBinds.length).toBe(timelineSources.length + 1);
  });

  test("rejects a non-positive or non-integer limit", () => {
    expect(() => buildTimelineUnionQuery({ scope, limit: 0 })).toThrow();
    expect(() => buildTimelineUnionQuery({ scope, limit: -5 })).toThrow();
    expect(() => buildTimelineUnionQuery({ scope, limit: 2.5 })).toThrow();
  });
});
