// Scheduler poller: cron match → CAS → launch. Skip-missed, no backoff.
import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  createWorkflowScheduler,
  DEFAULT_WORKFLOW_SCHEDULER_POLL_INTERVAL_MS,
  runNowScheduledDefinition,
  tickWorkflowScheduler,
  type ScheduledDefinition,
  type WorkflowSchedulerDeps,
} from "../src/workflow-scheduler";

const AT_0900 = new Date("2026-01-01T09:00:00.000Z");
const AT_0901 = new Date("2026-01-01T09:01:00.000Z");
const NEXT_DAY_0900 = new Date("2026-01-02T09:00:00.000Z");
const DAILY_0900 = "0 9 * * *";

function scheduled(
  overrides: Partial<ScheduledDefinition> = {},
): ScheduledDefinition {
  return {
    definitionId: "def_1",
    tenantId: "t1",
    creatorPrincipalId: "user_1",
    definitionAssetId: "ast_1",
    name: "workbench-digest",
    cron: DAILY_0900,
    ...overrides,
  };
}

function memoryClaim() {
  const claimed = new Map<string, string>();
  return {
    claimScheduleMinute: async (definitionId: string, minute: string) => {
      if (claimed.get(definitionId) === minute) return false;
      claimed.set(definitionId, minute);
      return true;
    },
  };
}

function tickDeps(
  overrides: Partial<
    Pick<
      WorkflowSchedulerDeps,
      "listScheduledDefinitions" | "claimScheduleMinute" | "launch"
    >
  > &
    Pick<WorkflowSchedulerDeps, "launch">,
): Parameters<typeof tickWorkflowScheduler>[0] {
  const claim = memoryClaim();
  return {
    listScheduledDefinitions: async () => [scheduled()],
    claimScheduleMinute: claim.claimScheduleMinute,
    ...overrides,
  };
}

describe("tickWorkflowScheduler", () => {
  test("due + matching minute launches exactly once", async () => {
    const launches: string[] = [];
    await tickWorkflowScheduler(
      tickDeps({
        launch: async (def) => {
          launches.push(def.definitionId);
        },
      }),
      AT_0900,
    );
    expect(launches).toEqual(["def_1"]);
  });

  test("cron does not match → no launch", async () => {
    let launches = 0;
    await tickWorkflowScheduler(
      tickDeps({
        launch: async () => {
          launches += 1;
        },
      }),
      AT_0901,
    );
    expect(launches).toBe(0);
  });

  test("status not listed (stopped omitted from list) → no launch", async () => {
    let launches = 0;
    await tickWorkflowScheduler(
      tickDeps({
        listScheduledDefinitions: async () => [],
        launch: async () => {
          launches += 1;
        },
      }),
      AT_0900,
    );
    expect(launches).toBe(0);
  });

  test("same minuteKey second tick → no second launch (CAS loser)", async () => {
    const claim = memoryClaim();
    let launches = 0;
    const deps = tickDeps({
      claimScheduleMinute: claim.claimScheduleMinute,
      launch: async () => {
        launches += 1;
      },
    });
    await tickWorkflowScheduler(deps, AT_0900);
    await tickWorkflowScheduler(deps, AT_0900);
    expect(launches).toBe(1);
  });

  test("clock jumps over the minute → no catch-up", async () => {
    let launches = 0;
    await tickWorkflowScheduler(
      tickDeps({
        launch: async () => {
          launches += 1;
        },
      }),
      AT_0901,
    );
    expect(launches).toBe(0);
  });

  test("null creator → no launch", async () => {
    let launches = 0;
    await tickWorkflowScheduler(
      tickDeps({
        listScheduledDefinitions: async () => [
          scheduled({ creatorPrincipalId: null }),
        ],
        launch: async () => {
          launches += 1;
        },
      }),
      AT_0900,
    );
    expect(launches).toBe(0);
  });

  test("launch throw is logged and the next matching minute can retry", async () => {
    const claim = memoryClaim();
    let attempts = 0;
    const deps = tickDeps({
      claimScheduleMinute: claim.claimScheduleMinute,
      launch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("launch exploded");
      },
    });
    await tickWorkflowScheduler(deps, AT_0900);
    expect(attempts).toBe(1);
    await tickWorkflowScheduler(deps, AT_0900);
    expect(attempts).toBe(1);
    await tickWorkflowScheduler(deps, NEXT_DAY_0900);
    expect(attempts).toBe(2);
  });

  test("claim throw on one definition does not skip the rest of the poll", async () => {
    const launches: string[] = [];
    await tickWorkflowScheduler(
      tickDeps({
        listScheduledDefinitions: async () => [
          scheduled({ definitionId: "def_bad" }),
          scheduled({ definitionId: "def_ok" }),
        ],
        claimScheduleMinute: async (definitionId) => {
          if (definitionId === "def_bad") throw new Error("claim exploded");
          return true;
        },
        launch: async (def) => {
          launches.push(def.definitionId);
        },
      }),
      AT_0900,
    );
    expect(launches).toEqual(["def_ok"]);
  });
});

describe("createWorkflowScheduler's setInterval wiring", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("defaults to the real 30s cadence when pollIntervalMs is unset", async () => {
    jest.useFakeTimers();
    let launches = 0;
    const scheduler = createWorkflowScheduler({
      listScheduledDefinitions: async () => [scheduled()],
      ...memoryClaim(),
      launch: async () => {
        launches += 1;
      },
      now: () => AT_0900,
    });
    try {
      jest.advanceTimersByTime(DEFAULT_WORKFLOW_SCHEDULER_POLL_INTERVAL_MS - 1);
      await Promise.resolve();
      expect(launches).toBe(0);

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(launches).toBe(1);
    } finally {
      scheduler.stop();
    }
  });

  test("an injected pollIntervalMs overrides the default cadence", async () => {
    jest.useFakeTimers();
    let launches = 0;
    const scheduler = createWorkflowScheduler({
      listScheduledDefinitions: async () => [scheduled()],
      ...memoryClaim(),
      launch: async () => {
        launches += 1;
      },
      now: () => AT_0900,
      pollIntervalMs: 500,
    });
    try {
      jest.advanceTimersByTime(499);
      await Promise.resolve();
      expect(launches).toBe(0);

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(launches).toBe(1);
    } finally {
      scheduler.stop();
    }
  });
});

// Hub-zero T4 (CL-8126) cut the scheduled delivery join: a triggered run
// launches straight into the runner with no settings-row lookup and no
// chat join, so there is no `joinScheduledDefinitionToChat` left to test.

type FakeRunRow = {
  id: string;
  definitionId: string;
  tenantId: string;
  anchorRunId: string;
  address: string | null;
  status: string;
  createdAt: Date;
};

function createFakeTriggerDb(rows: FakeRunRow[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () =>
              rows
                .filter((row) => row.anchorRunId === row.id)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
          }),
        }),
      }),
    }),
  };
}

const LIVE_ANCHOR: FakeRunRow = {
  id: "wfr_anchor1",
  definitionId: "wfd_digest",
  tenantId: "t1",
  anchorRunId: "wfr_anchor1",
  address: "wfr_anchor1@acme.workbench.test",
  status: "deployed",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function runNowArgs() {
  return {
    tenantId: "t1",
    definitionId: "wfd_digest",
    principalId: "clicker_1",
    fromDomain: "acme.workbench.test",
    content: "Run now.",
    name: "workbench-digest",
    definitionAssetId: "ast_1",
  };
}

describe("runNowScheduledDefinition", () => {
  test("launches without a delivery join and returns runId", async () => {
    const result = await runNowScheduledDefinition(
      {
        db: createFakeTriggerDb([LIVE_ANCHOR]) as never,
        sidecarRouter: { routeMail: () => true } as never,
      },
      runNowArgs(),
    );
    expect(result).toEqual({ runId: "wfr_anchor1" });
  });
});
