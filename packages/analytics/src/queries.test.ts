import { describe, expect, it, mock } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { getTokenDataStartDate } from "./queries";

function makeDb(rows: { date: string | null }[]) {
  const captured: { where?: SQL } = {};
  const where = mock(async (predicate: SQL) => {
    captured.where = predicate;
    return rows;
  });
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  return { db: { select } as never, captured };
}

function renderWhere(predicate: SQL | undefined): string {
  if (predicate === undefined) throw new Error("no where predicate captured");
  return new PgDialect().sqlToQuery(predicate).sql;
}

describe("getTokenDataStartDate", () => {
  it("returns the earliest bucket date that carries real tokens", async () => {
    const { db } = makeDb([{ date: "2026-06-10" }]);
    expect(await getTokenDataStartDate({ db, tenantId: "tnt_1" })).toBe(
      "2026-06-10",
    );
  });

  it("returns null when the tenant has no token-bearing buckets (min is null)", async () => {
    const { db } = makeDb([{ date: null }]);
    expect(await getTokenDataStartDate({ db, tenantId: "tnt_1" })).toBeNull();
  });

  it("returns null when there are no rows at all", async () => {
    const { db } = makeDb([]);
    expect(await getTokenDataStartDate({ db, tenantId: "tnt_1" })).toBeNull();
  });

  it("filters on the tenant and a positive sum over every token column", async () => {
    const { db, captured } = makeDb([{ date: "2026-06-10" }]);
    await getTokenDataStartDate({ db, tenantId: "tnt_1" });

    const sql = renderWhere(captured.where);
    expect(sql).toContain('"tenant_id"');
    for (const col of [
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "thinking_tokens",
    ]) {
      expect(sql).toContain(`"${col}"`);
    }
    expect(sql).toContain("> 0");
  });
});
