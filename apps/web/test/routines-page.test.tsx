// Screen-level proof for the Routines page's pure components: real
// (possibly empty) `APIQuery` props in, honest markup out — no live fetch.
// List rows live in shell col2; this page owns create + detail only.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery } from "../src/api";
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
  input: {
    draftedSteps: [{ title: "Pull signups", detail: "CSV from warehouse" }],
  },
  enabled: true,
  deliveryChannelId: "ch_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const listProps = {
  runHistories: new Map<string, readonly RoutineRun[]>(),
  liveRuns: ready([]),
  definitions: [] as const,
  channels: [] as const,
  selectedId: null as string | null,
  onSelect: (_id: string | null) => {},
  onCreate: () => Promise.resolve(),
  onDescribe: () =>
    Promise.resolve({
      id: "draft_test",
      prompt: "test",
      status: "draft" as const,
      proposedSteps: [],
      proposedTrigger: null,
      proposedName: null,
      definitionId: null,
      deliveryChannelId: "ch_1",
      scope: "bench" as const,
      autonomy: null,
      approvedRoutineId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  onApproveDraft: () => Promise.resolve(),
  onDiscardDraft: () => Promise.resolve(),
  onToggleEnabled: () => {},
  onRunNow: () => Promise.resolve(),
};

describe("RoutinesListPage", () => {
  test("says there are no routines yet when the list is empty", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage routines={ready([])} {...listProps} />,
    );
    expect(markup).toContain("No routines yet");
    expect(markup).toContain("Create one from a workflow or a prompt.");
    expect(markup).toContain("New routine");
  });

  test("prompts to select when routines exist but none is open", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        definitions={[{ id: "wfd_1", name: "Researcher", status: "deployed" }]}
      />,
    );
    expect(markup).toContain("Select a routine");
    // List rows live in col2 — the stage must not re-render the master list.
    expect(markup).not.toContain("Morning brief");
    expect(markup).not.toContain("rtn_1");
  });

  test("selected routine shows steps and recent runs", () => {
    const runHistories = new Map<string, readonly RoutineRun[]>([
      [
        routine.id,
        [
          {
            runId: "run_1",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T00:00:00.000Z",
            run: { status: "completed" },
          },
        ],
      ],
    ]);
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        runHistories={runHistories}
        selectedId={routine.id}
        definitions={[{ id: "wfd_1", name: "Researcher", status: "deployed" }]}
        channels={[
          {
            id: "ch_1",
            title: "Ops",
            kind: "channel",
            pinned: false,
            participants: [],
          },
        ]}
      />,
    );
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Daily at 09:00 UTC, delivers to Ops.");
    expect(markup).toContain("Pull signups");
    expect(markup).toContain("Recent runs");
    expect(markup).toContain("completed");
    expect(markup).not.toContain("rtn_1");
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
    expect(markup).toContain("Pull signups");
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
