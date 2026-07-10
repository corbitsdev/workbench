import { describe, expect, it, mock } from "bun:test";
import type { PriceCatalog } from "@workbench/pricing";

import {
  computePreviousRange,
  deriveAgentActivity,
  resolveAgentActivity,
  fetchActiveInstanceDays,
  fetchArtifactCreatedDates,
  fetchInstanceCreatedDates,
  getUsageByPerson,
  getUsageByWorkflowType,
} from "./activity-overview";
import type { DB } from "@intx/db";

/**
 * Minimal Drizzle chain whose every builder method returns itself and which
 * resolves (when awaited) to `rows`. Lets the fetch helpers run their real
 * row→date mapping without a database.
 */
function makeChainDb(rows: unknown[]): DB["db"] {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    having: () => chain,
    then: (resolve: (value: unknown) => unknown) => resolve(rows),
  };
  return chain as unknown as DB["db"];
}

describe("fetchArtifactCreatedDates", () => {
  it("truncates each createdAt timestamp to its UTC calendar date", async () => {
    const db = makeChainDb([
      { createdAt: new Date("2026-07-01T23:30:00.000Z") },
      { createdAt: new Date("2026-07-02T00:05:00.000Z") },
    ]);
    expect(await fetchArtifactCreatedDates(db, "t1", {})).toEqual([
      "2026-07-01",
      "2026-07-02",
    ]);
  });
});

describe("fetchInstanceCreatedDates", () => {
  it("truncates each createdAt timestamp to its UTC calendar date", async () => {
    const db = makeChainDb([
      { createdAt: new Date("2026-07-05T12:00:00.000Z") },
    ]);
    expect(await fetchInstanceCreatedDates(db, "t1", {})).toEqual([
      "2026-07-05",
    ]);
  });
});

describe("fetchActiveInstanceDays", () => {
  it("passes through instance/day rows and drops null instance ids", async () => {
    const db = makeChainDb([
      { instanceId: "ins_a", date: "2026-07-01" },
      { instanceId: null, date: "2026-07-01" },
      { instanceId: "ins_b", date: "2026-07-02" },
    ]);
    expect(await fetchActiveInstanceDays(db, "t1", {})).toEqual([
      { instanceId: "ins_a", date: "2026-07-01" },
      { instanceId: "ins_b", date: "2026-07-02" },
    ]);
  });
});

/** Fabricated rate catalog for cost-computation tests (CL-2723). */
function testCatalog(): PriceCatalog {
  return {
    source: "test",
    generatedAt: "2026-07-05T00:00:00.000Z",
    models: {
      "model-a": {
        modelId: "model-a",
        provider: "test",
        providerName: "Test",
        input: 1,
        output: 2,
        cacheRead: null,
        cacheWrite: null,
      },
    },
    qualified: {},
    ambiguous: [],
  };
}

type PersonRow = {
  principalId: string;
  name: string | null;
  model?: string | null;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
};

function makePersonDb(rows: PersonRow[], capture: { groupByCols?: unknown[] }) {
  const chain = {
    select: mock(() => chain),
    selectDistinctOn: mock(() => chain),
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    leftJoin: mock(() => chain),
    where: mock(() => chain),
    orderBy: mock(() => chain),
    as: mock(() => ({})),
    groupBy: mock((...cols: unknown[]) => {
      capture.groupByCols = cols;
      return Promise.resolve(
        rows.map((r) => ({
          model: null,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          ...r,
        })),
      );
    }),
  };
  return chain as never;
}

describe("computePreviousRange", () => {
  it("returns the equal-length window immediately before a closed range", () => {
    const prev = computePreviousRange(
      { startDate: "2026-06-08", endDate: "2026-06-14" },
      "2026-06-25",
    );
    expect(prev).toEqual({ startDate: "2026-06-01", endDate: "2026-06-07" });
  });

  it("uses today as the end reference when the range is open-ended", () => {
    const prev = computePreviousRange(
      { startDate: "2026-06-19" },
      "2026-06-25",
    );
    // window is 7 days (19th..25th inclusive); previous is 12th..18th
    expect(prev).toEqual({ startDate: "2026-06-12", endDate: "2026-06-18" });
  });

  it("returns null for an all-time range with no start date", () => {
    expect(computePreviousRange({}, "2026-06-25")).toBeNull();
  });

  it("spans month boundaries correctly", () => {
    const prev = computePreviousRange(
      { startDate: "2026-03-01", endDate: "2026-03-31" },
      "2026-06-25",
    );
    expect(prev).toEqual({ startDate: "2026-01-29", endDate: "2026-02-28" });
  });
});

describe("deriveAgentActivity", () => {
  it("counts instances with activity as active and the remainder as idle", () => {
    const result = deriveAgentActivity(
      [{ turnCount: 5 }, { turnCount: 0 }, { turnCount: 3 }],
      10,
    );
    expect(result).toEqual({ active: 2, idle: 8 });
  });

  it("never reports negative idle when active exceeds the instance total", () => {
    const result = deriveAgentActivity([{ turnCount: 1 }, { turnCount: 2 }], 1);
    expect(result).toEqual({ active: 2, idle: 0 });
  });

  it("treats an empty breakdown as all idle", () => {
    expect(deriveAgentActivity([], 4)).toEqual({ active: 0, idle: 4 });
  });
});

describe("resolveAgentActivity", () => {
  it("uses in-range byInstance rows only when the range has date bounds", () => {
    expect(
      resolveAgentActivity([{ turnCount: 1 }, { turnCount: 0 }], 99, {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      }),
    ).toEqual({ active: 1, idle: 1 });
  });

  it("does not treat all-time instance total as idle when range has no in-range rows", () => {
    expect(
      resolveAgentActivity([], 4, {
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      }),
    ).toEqual({ active: 0, idle: 0 });
  });

  it("falls back to all-time instance total when the range is unbounded", () => {
    expect(resolveAgentActivity([{ turnCount: 1 }], 5, {})).toEqual({
      active: 1,
      idle: 4,
    });
  });
});

describe("getUsageByPerson", () => {
  it("groups by the owning member principal and marks the caller as self", async () => {
    const capture: { groupByCols?: unknown[] } = {};
    const db = makePersonDb(
      [
        {
          principalId: "pri_me",
          name: "Sawyer",
          turnCount: 5,
          toolCallCount: 2,
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 900,
          cacheWriteTokens: 60,
          thinkingTokens: 15,
        },
        {
          principalId: "pri_other",
          name: "Dana",
          turnCount: 9,
          toolCallCount: 7,
          inputTokens: 800,
          outputTokens: 300,
        },
      ],
      capture,
    );

    const result = await getUsageByPerson({
      db,
      tenantId: "tnt_1",
      callerPrincipalId: "pri_me",
    });

    // Grouping happens on (memberPrincipalId, user.name, model) — CL-2723
    // added `model` so cost can be priced per model, never blended.
    expect(capture.groupByCols).toHaveLength(3);
    // Sorted by total tokens desc: Dana (1100) before Sawyer (140).
    expect(result.map((r) => r.principalId)).toEqual(["pri_other", "pri_me"]);
    const me = result.find((r) => r.principalId === "pri_me");
    expect(me?.isSelf).toBe(true);
    expect(me?.toolCallCount).toBe(2);
    // Every token class flows through separately for per-actor cost (CL-2714).
    expect(me?.cacheReadTokens).toBe(900);
    expect(me?.cacheWriteTokens).toBe(60);
    expect(me?.thinkingTokens).toBe(15);
    expect(result.find((r) => r.principalId === "pri_other")?.isSelf).toBe(
      false,
    );
  });

  it("computes cost per person from a supplied price catalog (CL-2723)", async () => {
    const capture: { groupByCols?: unknown[] } = {};
    const db = makePersonDb(
      [
        {
          principalId: "pri_me",
          name: "Sawyer",
          model: "model-a",
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
        {
          principalId: "pri_me",
          name: "Sawyer",
          model: "unknown-model",
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 1_000_000,
        },
      ],
      capture,
    );

    const result = await getUsageByPerson({
      db,
      tenantId: "tnt_1",
      callerPrincipalId: "pri_me",
      priceCatalog: testCatalog(),
    });

    const me = result.find((r) => r.principalId === "pri_me");
    // model-a costs 1M input tokens * $1/M = $1; unknown-model is unpriced.
    expect(me?.cost?.cost.total).toBeCloseTo(1, 6);
    expect(me?.cost?.hasUnpriced).toBe(true);
    expect(me?.cost?.unpricedModels).toEqual(["unknown-model"]);
    // Token totals still sum across both models regardless of pricing.
    expect(me?.inputTokens).toBe(1_000_000);
    expect(me?.outputTokens).toBe(1_000_000);
  });

  it("prices null-model usage as unpriced, never a silent $0 (CL-2723)", async () => {
    const capture: { groupByCols?: unknown[] } = {};
    const db = makePersonDb(
      [
        {
          principalId: "pri_me",
          name: "Sawyer",
          model: null,
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 2_000_000,
          outputTokens: 0,
        },
      ],
      capture,
    );

    const result = await getUsageByPerson({
      db,
      tenantId: "tnt_1",
      callerPrincipalId: "pri_me",
      priceCatalog: testCatalog(),
    });

    const me = result.find((r) => r.principalId === "pri_me");
    // Real usage with no model name must be flagged unpriced — not scored $0.
    expect(me?.cost?.hasUnpriced).toBe(true);
    expect(me?.cost?.unpricedModels).toEqual(["(unknown model)"]);
    expect(me?.cost?.cost.total).toBe(0);
    expect(me?.inputTokens).toBe(2_000_000);
  });

  it("leaves cost null when the caller supplies no price catalog", async () => {
    const capture: { groupByCols?: unknown[] } = {};
    const db = makePersonDb(
      [
        {
          principalId: "pri_me",
          name: "Sawyer",
          model: "model-a",
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
      ],
      capture,
    );

    const result = await getUsageByPerson({
      db,
      tenantId: "tnt_1",
      callerPrincipalId: "pri_me",
    });

    expect(result[0]?.cost).toBeNull();
  });

  it("falls back to a null name and never self-marks without a caller", async () => {
    const capture: { groupByCols?: unknown[] } = {};
    const db = makePersonDb(
      [
        {
          principalId: "pri_x",
          name: null,
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
      capture,
    );

    const result = await getUsageByPerson({
      db,
      tenantId: "tnt_1",
      callerPrincipalId: null,
    });

    expect(result[0]?.name).toBeNull();
    expect(result[0]?.isSelf).toBe(false);
  });
});

function makeWorkflowTypeDb(
  rows: {
    kind: string;
    model?: string | null;
    turnCount: number;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    thinkingTokens?: number;
  }[],
  capture: { groupByCols?: unknown[]; distinctOnCount?: number },
) {
  capture.distinctOnCount = 0;
  const chain = {
    select: mock(() => chain),
    // The deployment-dedup subquery collapses many-runs-per-deployment to one
    // (deploymentId, kind) so the LIKE join can't fan out and double-count.
    selectDistinctOn: mock(() => {
      capture.distinctOnCount = (capture.distinctOnCount ?? 0) + 1;
      return chain;
    }),
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock(() => chain),
    orderBy: mock(() => chain),
    as: mock(() => ({})),
    groupBy: mock((...cols: unknown[]) => {
      capture.groupByCols = cols;
      return Promise.resolve(
        rows.map((r) => ({
          model: null,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thinkingTokens: 0,
          ...r,
        })),
      );
    }),
  };
  return chain as never;
}

describe("getUsageByWorkflowType", () => {
  it("dedupes deployments, groups by workflow kind, and sorts by total tokens desc", async () => {
    const capture: { groupByCols?: unknown[]; distinctOnCount?: number } = {};
    const db = makeWorkflowTypeDb(
      [
        {
          kind: "mvt-landing-page",
          turnCount: 2,
          toolCallCount: 1,
          inputTokens: 120,
          outputTokens: 30,
        },
        {
          kind: "last30days",
          turnCount: 6,
          toolCallCount: 2,
          inputTokens: 500,
          outputTokens: 90,
        },
      ],
      capture,
    );

    const result = await getUsageByWorkflowType({ db, tenantId: "tnt_1" });

    // Structural regression guard only: the mocked chain does not execute SQL,
    // so this asserts the dedup subquery is still wired (a `DISTINCT ON`) — it
    // does NOT exercise the LIKE-prefix join, tenant scoping, or the actual
    // fan-out collapse. Those join semantics have no DB-level coverage here (the
    // hub suite has no live-DB harness); they are validated on staging per
    // docs/ANALYTICS.md.
    expect(capture.distinctOnCount).toBe(1);
    // CL-2723 added `model` to the group key so cost prices per model.
    expect(capture.groupByCols).toHaveLength(2);
    // Real behavior: mapping + sort by total tokens desc — last30days (590)
    // before mvt-landing-page (150), with turn counts passed through.
    expect(result.map((r) => r.kind)).toEqual([
      "last30days",
      "mvt-landing-page",
    ]);
    expect(result[0]?.turnCount).toBe(6);
  });

  it("computes cost per workflow kind from a supplied price catalog (CL-2723)", async () => {
    const capture: { groupByCols?: unknown[]; distinctOnCount?: number } = {};
    const db = makeWorkflowTypeDb(
      [
        {
          kind: "last30days",
          model: "model-a",
          turnCount: 2,
          toolCallCount: 1,
          inputTokens: 2_000_000,
          outputTokens: 0,
        },
      ],
      capture,
    );

    const result = await getUsageByWorkflowType({
      db,
      tenantId: "tnt_1",
      priceCatalog: testCatalog(),
    });

    // 2M input tokens * $1/M = $2.
    expect(result[0]?.cost?.cost.total).toBeCloseTo(2, 6);
    expect(result[0]?.cost?.hasUnpriced).toBe(false);
  });

  it("leaves cost null when the caller supplies no price catalog", async () => {
    const capture: { groupByCols?: unknown[]; distinctOnCount?: number } = {};
    const db = makeWorkflowTypeDb(
      [
        {
          kind: "last30days",
          model: "model-a",
          turnCount: 1,
          toolCallCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
      ],
      capture,
    );

    const result = await getUsageByWorkflowType({ db, tenantId: "tnt_1" });

    expect(result[0]?.cost).toBeNull();
  });
});
