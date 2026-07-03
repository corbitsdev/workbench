import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { TENANT_WIDE_SCOPE } from "./descriptor";
import { timelineSources } from "./registry";
import { buildTimelineUnionQuery } from "./union-sql";

const dialect = new PgDialect();

const scope = { tenantId: "ten_test", principalIds: ["prn_test"] };

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
    const principalBinds = params.filter((p) => p === "prn_test");
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

  test("scopes every branch to the full principal-id set with bound params", () => {
    const multi = {
      tenantId: "ten_test",
      principalIds: ["prn_user", "prn_synth_a", "prn_synth_b"],
    };
    const { sql, params } = render({ scope: multi, limit: 10 });
    for (const id of multi.principalIds) {
      const binds = params.filter((p) => p === id);
      expect(binds.length).toBeGreaterThanOrEqual(timelineSources.length);
    }
    expect(sql).toContain(" in (");
    expect(sql).not.toContain("prn_synth_a");
  });

  test("rejects an empty principal-id set", () => {
    expect(() =>
      buildTimelineUnionQuery({
        scope: { tenantId: "ten_test", principalIds: [] },
        limit: 5,
      }),
    ).toThrow(/principal/i);
  });

  describe("tenant-wide scope", () => {
    const wide = {
      tenantId: "ten_test",
      principalIds: TENANT_WIDE_SCOPE,
    } as const;

    test("still binds the tenant param for every branch (tenant isolation holds)", () => {
      const { params } = render({ scope: wide, limit: 20 });
      const tenantBinds = params.filter((p) => p === wide.tenantId);
      expect(tenantBinds.length).toBeGreaterThanOrEqual(timelineSources.length);
    });

    test("drops the principal predicate: no principal id is bound", () => {
      const { params } = render({ scope: wide, limit: 20 });
      // A principal-scoped render binds the id many times; the tenant-wide
      // render must not bind any principal id at all.
      expect(params).not.toContain("prn_test");
      // The per-principal scoped render is strictly longer (extra predicates).
      const scoped = render({ scope, limit: 20 });
      expect(render({ scope: wide, limit: 20 }).sql.length).toBeLessThan(
        scoped.sql.length,
      );
    });

    test("does not reject tenant-wide as an empty scope", () => {
      expect(() =>
        buildTimelineUnionQuery({ scope: wide, limit: 5 }),
      ).not.toThrow();
    });

    test("redacts sensitive summaries (memory content, credential name) on the tenant-wide feed", () => {
      const { sql } = render({ scope: wide, limit: 20 });
      // The memory branch must NOT project the content snippet tenant-wide.
      expect(sql).not.toContain("left(src.content, 140)");
      // Both redacted sources collapse to a NULL summary literal.
      const nulls = sql.match(/null::text\) as summary/g) ?? [];
      expect(nulls.length).toBe(2);
    });

    test("keeps the full sensitive summaries on the per-principal drill-down", () => {
      const { sql } = render({ scope, limit: 20 });
      // The deliberate per-principal view still shows content and the name.
      expect(sql).toContain("left(src.content, 140)");
      expect(sql).not.toContain("null::text) as summary");
    });
  });

  test("selects a lossless ts_text column alongside ts in every branch and the outer select", () => {
    const { sql } = render({ scope, limit: 20 });
    const branchAliases = sql.match(/as ts_text/g) ?? [];
    expect(branchAliases.length).toBe(timelineSources.length);
    expect(sql).toContain(
      "select id, kind, source_table, ts, ts_text, summary",
    );
    const textCasts = sql.match(/::timestamptz::text/g) ?? [];
    expect(textCasts.length).toBe(timelineSources.length);
  });

  test("binds the cursor timestamp verbatim into the keyset predicate", () => {
    const pgText = "2026-07-01 10:00:00.123456+00";
    const { params } = render({
      scope,
      limit: 20,
      cursor: { timestamp: pgText, sourceTable: "artifact", id: "abc" },
    });
    expect(params).toContain(pgText);
  });

  test("rejects a non-positive or non-integer limit", () => {
    expect(() => buildTimelineUnionQuery({ scope, limit: 0 })).toThrow();
    expect(() => buildTimelineUnionQuery({ scope, limit: -5 })).toThrow();
    expect(() => buildTimelineUnionQuery({ scope, limit: 2.5 })).toThrow();
  });
});
