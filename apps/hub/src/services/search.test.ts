import { describe, expect, it, mock } from "bun:test";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema as intx } from "@intx/db";
import * as wb from "../db/schema";
import type { HubDb } from "../db";

interface ToolSummary {
  name: string;
  providerName: string;
  description: string;
  version: string | null;
}

// Mock the tool catalog at the module boundary so the in-process tools source
// does not touch the proxy db (it resolves credentials of its own otherwise).
let toolsImpl: () => Promise<ToolSummary[]> = () => Promise.resolve([]);
mock.module("../lib/tenant-tools", () => ({
  listAvailableToolSummaries: () => toolsImpl(),
}));

const { searchTenant, scoreText, humanizeKind, paginate, PER_SOURCE_LIMIT } =
  await import("./search");

const SCHEMA = { ...intx, ...wb };

interface ProxyCall {
  query: string;
  params: unknown[];
}

// A drizzle pg-proxy db that records every generated SQL string + params and
// returns caller-supplied rows per query (matched by a substring of the SQL).
// This exercises the REAL query builder — the generated SQL and its bound
// params are what the test asserts on, not a hand-rolled mock's return value.
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

const ISO = "2026-01-01T00:00:00.000Z";

describe("scoreText", () => {
  it("ranks exact > prefix > contains > miss", () => {
    expect(scoreText("foo", "foo")).toBe(3);
    expect(scoreText("foo", "foobar")).toBe(2);
    expect(scoreText("foo", "a foobar")).toBe(1);
    expect(scoreText("foo", "bar")).toBe(0);
  });
});

describe("humanizeKind", () => {
  it("title-cases and strips separators", () => {
    expect(humanizeKind("pain_point-collateral")).toBe("Pain Point Collateral");
  });
});

describe("paginate", () => {
  it("flags hasMore and trims the extra row when over the limit", () => {
    const over = paginate(
      Array.from({ length: PER_SOURCE_LIMIT + 1 }, (_, i) => i),
    );
    expect(over.rows).toHaveLength(PER_SOURCE_LIMIT);
    expect(over.hasMore).toBe(true);

    const exact = paginate(
      Array.from({ length: PER_SOURCE_LIMIT }, (_, i) => i),
    );
    expect(exact.rows).toHaveLength(PER_SOURCE_LIMIT);
    expect(exact.hasMore).toBe(false);
  });
});

describe("searchTenant", () => {
  it("short-circuits an empty query without hitting the db", async () => {
    toolsImpl = () => Promise.resolve([]);
    const { db, calls } = makeRecordingDb(() => []);
    const result = await searchTenant(db, {
      tenantId: "tn-1",
      memberPrincipalId: "prn-1",
      query: "   ",
      page: 0,
    });
    expect(result).toEqual({ results: [], page: 0, hasMore: false });
    expect(calls).toHaveLength(0);
  });

  it("scopes every db source to the tenant id (cross-tenant isolation)", async () => {
    toolsImpl = () => Promise.resolve([]);
    const { db, calls } = makeRecordingDb(() => []);
    await searchTenant(db, {
      tenantId: "tn-secret",
      memberPrincipalId: "prn-1",
      query: "acme",
      page: 0,
    });
    // Every generated query filters by tenant_id, and the bound tenant id is
    // the caller's — a query that forgot the scope would fail this.
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call.query).toContain("tenant_id");
      expect(call.params).toContain("tn-secret");
    }
  });

  it("applies per-source limit+1 and page offset, with relevance ordering", async () => {
    toolsImpl = () => Promise.resolve([]);
    const { db, calls } = makeRecordingDb(() => []);
    await searchTenant(db, {
      tenantId: "tn-1",
      memberPrincipalId: "prn-1",
      query: "acme",
      page: 2,
    });
    // Find the artifact source query and assert its shape end to end.
    const artifactCall = calls.find((c) => c.query.includes('from "artifact"'));
    expect(artifactCall).toBeDefined();
    expect(artifactCall!.query.toLowerCase()).toContain("case when lower(");
    expect(artifactCall!.params).toContain(PER_SOURCE_LIMIT + 1);
    // page 2 → offset 10
    expect(artifactCall!.params).toContain(2 * PER_SOURCE_LIMIT);
  });

  it("excludes archived artifacts from the artifact search source", async () => {
    toolsImpl = () => Promise.resolve([]);
    const { db, calls } = makeRecordingDb(() => []);
    await searchTenant(db, {
      tenantId: "tn-1",
      memberPrincipalId: "prn-1",
      query: "acme",
      page: 1,
    });
    const artifactCall = calls.find((c) => c.query.includes('from "artifact"'));
    expect(artifactCall).toBeDefined();
    const q = artifactCall!.query.toLowerCase();
    // The soft-hide filter (archived_at IS NULL) must be woven into the query,
    // or archived artifacts would resurface via search.
    expect(q).toContain("archived_at");
    expect(q).toContain("is null");
  });

  it("normalizes rows from each source to palette items and computes hasMore", async () => {
    toolsImpl = () =>
      Promise.resolve([
        {
          name: "acme_search",
          providerName: "exa",
          description: "web search",
          version: null,
        },
      ]);
    // Return 6 chat rows (over the limit → hasMore) and one row for the others.
    const { db } = makeRecordingDb((query) => {
      if (query.includes("template_key")) {
        return Array.from({ length: PER_SOURCE_LIMIT + 1 }, (_, i) => [
          `inst-${i}`,
          `Acme call ${i}`,
          ISO,
        ]);
      }
      if (query.includes('from "artifact"')) {
        return [["art-1", "Acme one-pager", ISO]];
      }
      if (query.includes('from "asset"')) {
        return [["asset-1", "acme-skill", "Acme Skill", ISO]];
      }
      if (query.includes('from "agent_instance"')) {
        return [["inst-x", "Acme Agent", "running", ISO]];
      }
      if (query.includes('from "workflow_run"') && query.includes("group by")) {
        return [["acme_workflow", ISO]];
      }
      return [];
    });

    const result = await searchTenant(db, {
      tenantId: "tn-1",
      memberPrincipalId: "prn-1",
      query: "acme",
      page: 0,
    });

    const byCategory = (cat: string) =>
      result.results.filter((r) => r.category === cat);

    expect(byCategory("conversation")).toHaveLength(PER_SOURCE_LIMIT);
    expect(result.results.find((r) => r.id === "conversation:inst-0")?.to).toBe(
      "/chats/inst-0",
    );
    expect(byCategory("artifact")[0]?.to).toBe("/artifacts/art-1");
    expect(byCategory("skill")[0]?.title).toBe("Acme Skill");
    expect(byCategory("skill")[0]?.to).toBe("/skills/asset-1");
    expect(byCategory("workflow")[0]?.title).toBe("Acme Workflow");
    expect(byCategory("agent")[0]?.to).toBe("/chats");
    expect(byCategory("tool")[0]?.id).toBe("tool:acme_search");
    expect(byCategory("tool")[0]?.to).toBe("/tools/acme_search");
    // The chats source returned the extra row, so more pages exist.
    expect(result.hasMore).toBe(true);
  });

  it("ranks and paginates the in-process tools source", async () => {
    toolsImpl = () =>
      Promise.resolve(
        Array.from({ length: PER_SOURCE_LIMIT + 2 }, (_, i) => ({
          name: `acme_tool_${i}`,
          providerName: "p",
          description: "",
          version: null,
        })).concat([
          { name: "acme", providerName: "p", description: "", version: null },
          {
            name: "zzz",
            providerName: "p",
            description: "match acme",
            version: null,
          },
        ]),
      );
    const { db } = makeRecordingDb(() => []);
    const result = await searchTenant(db, {
      tenantId: "tn-1",
      memberPrincipalId: "prn-1",
      query: "acme",
      page: 0,
    });
    const tools = result.results.filter((r) => r.category === "tool");
    // exact "acme" must rank first; per-source limit caps the slice at 5.
    expect(tools[0]!.title).toBe("acme");
    expect(tools).toHaveLength(PER_SOURCE_LIMIT);
    expect(result.hasMore).toBe(true);
  });
});
