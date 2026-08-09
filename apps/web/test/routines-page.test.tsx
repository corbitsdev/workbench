// Screen-level proof for the Routines page's two pure components,
// mirroring pages.test.tsx's shape: real (possibly empty) `APIQuery`
// props in, honest markup out — no live fetch.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery, WorkflowRun } from "../src/api";
import {
  RoutineDetailPage,
  RoutinesListPage,
} from "../src/pages/routines-page";
import type { Routine, RoutineRun } from "../src/routines-api";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const routine: Routine = {
  id: "rtn_1",
  name: "Morning brief",
  definitionId: "wfd_1",
  trigger: { kind: "daily", hour: 9, minute: 0 },
  scope: "bench",
  input: {},
  enabled: true,
  deliveryChannelId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("RoutinesListPage", () => {
  test("says there are no routines yet", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        routines={ready([])}
        runHistories={new Map()}
        liveRuns={ready([])}
        definitions={[]}
        onOpen={() => {}}
        onCreate={() => Promise.resolve()}
        onToggleEnabled={() => {}}
        onRunNow={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("No routines yet");
    expect(markup).toContain("No routine runs in flight");
  });

  test("renders a routine by name and cadence, never a raw id", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        routines={ready([routine])}
        runHistories={new Map()}
        liveRuns={ready([])}
        definitions={[{ id: "wfd_1", name: "Researcher", status: "deployed" }]}
        onOpen={() => {}}
        onCreate={() => Promise.resolve()}
        onToggleEnabled={() => {}}
        onRunNow={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Daily at 09:00 UTC");
    expect(markup).not.toContain("rtn_1");
  });

  test("filters live runs to only those correlated with a routine", () => {
    const correlatedRun: WorkflowRun = {
      id: "run_correlated",
      tenantId: "tenant_1",
      tenantName: "Acme",
      definitionId: "wfd_1",
      definitionName: "Researcher",
      address: "run_correlated@acme.localhost",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const runHistories = new Map<string, readonly RoutineRun[]>([
      [
        routine.id,
        [
          {
            runId: "run_correlated",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      ],
    ]);
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        routines={ready([routine])}
        runHistories={runHistories}
        liveRuns={ready([correlatedRun])}
        definitions={[]}
        onOpen={() => {}}
        onCreate={() => Promise.resolve()}
        onToggleEnabled={() => {}}
        onRunNow={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("Acme");
    expect(markup).not.toContain("No routine runs in flight");
  });
});

describe("RoutineDetailPage", () => {
  test("shows the routine's name, cadence, and empty run history", () => {
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(routine)}
        runs={ready<readonly RoutineRun[]>([])}
        onBack={() => {}}
      />,
    );
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Daily at 09:00 UTC");
    expect(markup).toContain("No runs yet");
  });

  test("renders run history with a resolved status", () => {
    const run: RoutineRun = {
      runId: "run_1",
      triggeredBy: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { status: "completed" },
    };
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(routine)}
        runs={ready<readonly RoutineRun[]>([run])}
        onBack={() => {}}
      />,
    );
    expect(markup).toContain("manual");
    expect(markup).toContain("completed");
  });
});
