import { describe, expect, it, mock } from "bun:test";

import {
  computePreviousRange,
  deriveAgentActivity,
  getUsageByPerson,
  getUsageByWorkflowType,
} from "./activity-overview";

type PersonRow = {
  principalId: string;
  name: string | null;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
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
      return Promise.resolve(rows);
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

    // Grouping happens on (memberPrincipalId, user.name).
    expect(capture.groupByCols).toHaveLength(2);
    // Sorted by total tokens desc: Dana (1100) before Sawyer (140).
    expect(result.map((r) => r.principalId)).toEqual(["pri_other", "pri_me"]);
    const me = result.find((r) => r.principalId === "pri_me");
    expect(me?.isSelf).toBe(true);
    expect(me?.toolCallCount).toBe(2);
    expect(result.find((r) => r.principalId === "pri_other")?.isSelf).toBe(
      false,
    );
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
    turnCount: number;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
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
      return Promise.resolve(rows);
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
    expect(capture.groupByCols).toHaveLength(1);
    // Real behavior: mapping + sort by total tokens desc — last30days (590)
    // before mvt-landing-page (150), with turn counts passed through.
    expect(result.map((r) => r.kind)).toEqual([
      "last30days",
      "mvt-landing-page",
    ]);
    expect(result[0]?.turnCount).toBe(6);
  });
});
