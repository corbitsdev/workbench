import { describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema as intx } from "@intx/db";
import * as wb from "../db/schema";
import type { HubDb } from "../db";
import {
  searchActors,
  ActorSearchQueryTooShortError,
  ACTOR_SEARCH_MIN_QUERY_LENGTH,
  ACTOR_SEARCH_MAX_RESULTS,
} from "./actor-search";

const SCHEMA = { ...intx, ...wb };

interface ProxyCall {
  query: string;
  params: unknown[];
}

// A drizzle pg-proxy db that records every generated SQL string + params and
// returns caller-supplied rows per query. This exercises the REAL query
// builder — the generated SQL and its bound params are what the tenant-scoping
// proof asserts on.
function makeRecordingDb(rowsFor: (query: string) => unknown[][]): {
  db: HubDb;
  calls: ProxyCall[];
} {
  const calls: ProxyCall[] = [];
  const db = drizzle(
    async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return { rows: rowsFor(query) };
    },
    { schema: SCHEMA },
  );
  return { db: db as unknown as HubDb, calls };
}

describe("searchActors", () => {
  it("rejects a query below the minimum length without touching the db", async () => {
    const { db, calls } = makeRecordingDb(() => []);
    const short = "a".repeat(ACTOR_SEARCH_MIN_QUERY_LENGTH - 1);
    await expect(
      searchActors(db, { tenantId: "tn-1", query: short }),
    ).rejects.toBeInstanceOf(ActorSearchQueryTooShortError);
    await expect(
      searchActors(db, { tenantId: "tn-1", query: "   " }),
    ).rejects.toBeInstanceOf(ActorSearchQueryTooShortError);
    expect(calls).toHaveLength(0);
  });

  it("scopes every generated query to the caller's tenant (cross-tenant principals can never appear)", async () => {
    const { db, calls } = makeRecordingDb(() => []);
    await searchActors(db, { tenantId: "tn-secret", query: "acme" });
    // Both source queries (user principals, agent principals) must filter on
    // principal.tenant_id and bind the caller's tenant id. A query built
    // outside the scoped filter would fail this.
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.query).toContain('"principal"."tenant_id"');
      expect(call.params).toContain("tn-secret");
    }
  });

  it("returns user and agent kinds, validated and merged", async () => {
    const { db } = makeRecordingDb((query) => {
      if (query.includes('"user"')) {
        return [["prn-u1", "active", "Acme Ada", "ada@acme.com", 3]];
      }
      return [["prn-a1", "active", "Acme Agent", 2]];
    });
    const result = await searchActors(db, { tenantId: "tn-1", query: "acme" });
    const kinds = result.actors.map((a) => a.kind).sort();
    expect(kinds).toEqual(["agent", "user"]);
    const userActor = result.actors.find((a) => a.kind === "user")!;
    expect(userActor.id).toBe("prn-u1");
    expect(userActor.displayName).toBe("Acme Ada");
    expect(userActor.email).toBe("ada@acme.com");
    expect(userActor.status).toBe("active");
    const agentActor = result.actors.find((a) => a.kind === "agent")!;
    expect(agentActor.id).toBe("prn-a1");
    expect(agentActor.displayName).toBe("Acme Agent");
    expect(agentActor.email).toBeUndefined();
    // exact-rank ordering: the higher-ranked user row sorts first
    expect(result.actors[0]!.id).toBe("prn-u1");
  });

  it("bounds the result count and binds the limit into the SQL", async () => {
    const manyUsers = Array.from(
      { length: ACTOR_SEARCH_MAX_RESULTS },
      (_, i) => [`prn-u${i}`, "active", `Acme ${i}`, `u${i}@acme.com`, 1],
    );
    const manyAgents = Array.from(
      { length: ACTOR_SEARCH_MAX_RESULTS },
      (_, i) => [`prn-a${i}`, "active", `Agent ${i}`, 1],
    );
    const { db, calls } = makeRecordingDb((query) =>
      query.includes('"user"') ? manyUsers : manyAgents,
    );
    const result = await searchActors(db, { tenantId: "tn-1", query: "acme" });
    expect(result.actors.length).toBe(ACTOR_SEARCH_MAX_RESULTS);
    for (const call of calls) {
      expect(call.params).toContain(ACTOR_SEARCH_MAX_RESULTS);
    }
  });

  it("clamps a caller-supplied limit to the maximum", async () => {
    const { db, calls } = makeRecordingDb(() => []);
    await searchActors(db, { tenantId: "tn-1", query: "acme", limit: 9999 });
    for (const call of calls) {
      expect(call.params).toContain(ACTOR_SEARCH_MAX_RESULTS);
      expect(call.params).not.toContain(9999);
    }
  });

  it("escapes LIKE metacharacters so a literal % cannot wildcard-scan", async () => {
    const { db, calls } = makeRecordingDb(() => []);
    await searchActors(db, { tenantId: "tn-1", query: "50%" });
    for (const call of calls) {
      expect(call.params).toContain("%50\\%%");
    }
  });
});
