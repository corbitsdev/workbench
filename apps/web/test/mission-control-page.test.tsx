import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { Workbench } from "@corbits/chat-ui";
import type { WorkingTask } from "@corbits/tasks-ui";

import { BenchContext, type BenchState } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import {
  computeInFlightRows,
  computeJumpBackRows,
  MissionControlRoute,
} from "../src/pages/mission-control-page";
import type { RoutineActivityItem } from "../src/shell/routine-activity";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function workingTask(overrides: Partial<WorkingTask>): WorkingTask {
  return {
    id: "task_1",
    definitionId: "def_1",
    workbenchId: null,
    agentName: "Research Analyst",
    prompt: "Summarize 3 threads",
    modelPreference: null,
    status: "running",
    runId: "run_1",
    runIds: ["run_1"],
    stepCount: 6,
    resultMailId: null,
    createdAt: "2026-08-19T10:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function routine(overrides: Partial<RoutineActivityItem>): RoutineActivityItem {
  return {
    id: "rtn_1",
    name: "Weekly digest",
    status: "running",
    startedAt: "2026-08-19T09:00:00.000Z",
    ...overrides,
  };
}

function workbench(overrides: Partial<Workbench>): Workbench {
  return {
    id: "wb_1",
    title: "Launch plan",
    kind: "workbench",
    pinned: false,
    participants: [],
    lastActivityAt: "2026-08-19T09:00:00.000Z",
    ...overrides,
  };
}

describe("computeInFlightRows", () => {
  test("drops queued tasks — nothing has started executing yet", () => {
    const rows = computeInFlightRows([workingTask({ status: "queued" })], []);
    expect(rows).toEqual([]);
  });

  test("keeps running and needs-you tasks, and only running routines", () => {
    const rows = computeInFlightRows(
      [
        workingTask({ id: "t1", status: "running" }),
        workingTask({ id: "t2", status: "needs-you" }),
      ],
      [
        routine({ id: "r1", status: "running" }),
        routine({ id: "r2", status: "deployed" }),
      ],
    );
    expect(rows.map((row) => row.key)).toEqual([
      "task:t1",
      "task:t2",
      "routine:r1",
    ]);
  });

  test("sorts newest first and derives an honest steps ratio from real run ids", () => {
    const rows = computeInFlightRows(
      [
        workingTask({
          id: "old",
          createdAt: "2026-08-19T08:00:00.000Z",
          runIds: ["a", "b"],
          stepCount: 9,
        }),
        workingTask({ id: "new", createdAt: "2026-08-19T11:00:00.000Z" }),
      ],
      [],
    );
    expect(rows.map((row) => row.key)).toEqual(["task:new", "task:old"]);
    expect(rows[1]?.steps).toBe("2/9");
  });
});

describe("computeJumpBackRows", () => {
  test("drops a workbench with no recorded activity instead of inventing a time", () => {
    // `lastActivityAt` is optional, and under `exactOptionalPropertyTypes`
    // "no recorded activity" means the key is absent, not set to undefined.
    const silent: Workbench = {
      id: "silent",
      title: "Launch plan",
      kind: "workbench",
      pinned: false,
      participants: [],
    };
    const rows = computeJumpBackRows([silent], [], [], () => undefined);
    expect(rows).toEqual([]);
  });

  test("merges workbenches, chats, and agents, newest first, capped at the limit", () => {
    const rows = computeJumpBackRows(
      [workbench({ id: "wb1", lastActivityAt: "2026-08-19T09:00:00.000Z" })],
      [
        workbench({
          id: "chat1",
          kind: "chat",
          lastActivityAt: "2026-08-19T11:00:00.000Z",
        }),
      ],
      [
        {
          id: "agent1",
          name: "Research Analyst",
          createdAt: "2026-08-19T10:00:00.000Z",
        },
      ],
      () => undefined,
      2,
    );
    expect(rows.map((row) => row.key)).toEqual(["bench:chat1", "agent:agent1"]);
    expect(rows[0]?.context).toBe("chat");
  });
});

const benchState: BenchState = {
  memberships: { kind: "ready", data: { data: [], nextCursor: null } },
  selectedTenantId: "tnt_bench_a",
  selectedPrincipalId: "prn_bench_a",
  selectTenant: () => {},
  onBenchCreated: () => {},
};

function stubEmptyBenchFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/approvals/needs-you")) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/insights/activity")) {
      return Promise.resolve(
        new Response(JSON.stringify({ days: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/tasks")) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/agent-definitions/visible")) {
      return Promise.resolve(
        new Response(JSON.stringify({ definitions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ items: [], data: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

describe("MissionControlRoute", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  test("renders honest empty states with nothing waiting and nothing running", async () => {
    stubEmptyBenchFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <NavigationProvider navigate={() => undefined}>
            <BenchContext.Provider value={benchState}>
              <MissionControlRoute navigate={() => undefined} />
            </BenchContext.Provider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    for (let count = 0; count < 5; count += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(container.textContent).toContain("Mission Control");
    expect(container.textContent).toContain("Nothing waiting on you");
    expect(container.textContent).toContain("Nothing running right now");
    expect(container.textContent).toContain("Nothing recent yet.");
  });
});
