import { describe, expect, test } from "bun:test";

import { groupRunsByDefinition, purposeRunsForInsights, runDisplayName } from "./insights-stats";
import type { InsightsRun } from "./insights-api";

function run(partial: Partial<InsightsRun> & Pick<InsightsRun, "id" | "status">): InsightsRun {
  return {
    tenantId: "t1",
    definitionId: "def",
    definitionName: partial.definitionName ?? "research-brief",
    address: "addr",
    createdAt: partial.createdAt ?? "2026-01-02T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-02T00:00:00.000Z",
    routineId: partial.routineId ?? null,
    routineName: partial.routineName ?? null,
    ...partial,
  };
}

describe("purposeRunsForInsights", () => {
  const deployment = run({ id: "ins_deployed", status: "running" });

  test("leaves an ordinary top-level deployment run alone", () => {
    expect(purposeRunsForInsights([deployment])).toEqual([deployment]);
  });

  test("an empty feed (server already scoped out everything) reads as zero, not an error", () => {
    expect(purposeRunsForInsights([])).toEqual([]);
  });
});

describe("groupRunsByDefinition", () => {
  test("groups runs by definitionId, newest first within each group", () => {
    const groups = groupRunsByDefinition([
      run({
        id: "a1",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      run({
        id: "b1",
        status: "running",
        definitionId: "wfd_b",
        definitionName: "Weekly digest",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      run({
        id: "a2",
        status: "error",
        definitionId: "wfd_a",
        definitionName: "Research brief",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ]);

    expect(groups.map((g) => g.groupKey)).toEqual(["wfd_a", "wfd_b"]);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(groups[0]?.displayName).toBe("Research brief");
  });

  test("an empty feed groups to nothing", () => {
    expect(groupRunsByDefinition([])).toEqual([]);
  });

  test("groups native rows with no routine attribution by definition", () => {
    // The native `GET /workflows/runs` listing carries no `routineId`, so
    // history groups by definition — never by an invented routine.
    const native = run({
      id: "n1",
      status: "running",
      definitionId: "wfd_a",
      definitionName: "Research brief",
    });
    delete native.routineId;
    delete native.routineName;
    const groups = groupRunsByDefinition([native]);
    expect(groups.map((g) => g.groupKey)).toEqual(["wfd_a"]);
    expect(groups[0]?.displayName).toBe("Research brief");
  });

  test("uses the newest run's name, not input-array-first, when a definition was renamed", () => {
    // Old run (chronologically oldest) appears FIRST in the input array,
    // simulating an unsorted/out-of-order feed. Newer run (renamed) is second.
    const groups = groupRunsByDefinition([
      run({
        id: "old",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "Old Name",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      run({
        id: "new",
        status: "deployed",
        definitionId: "wfd_a",
        definitionName: "New Name",
        createdAt: "2026-01-05T00:00:00.000Z",
      }),
    ]);
    expect(groups[0]?.runs.map((r) => r.id)).toEqual(["new", "old"]);
    // The group header should reflect the current (newest) name.
    expect(groups[0]?.displayName).toBe("New Name");
  });

  test("groups a routine fire by its routine, not its shared definition, and shows the routine's name", () => {
    const groups = groupRunsByDefinition([
      run({
        id: "fire1",
        status: "running",
        definitionId: "wfd_workbench_digest",
        definitionName: "workbench-digest",
        routineId: "rtn_pulse_check",
        routineName: "Pulse check",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      // A second routine firing the very same definition must land in
      // its own group, not merge with "Pulse check" above.
      run({
        id: "fire2",
        status: "running",
        definitionId: "wfd_workbench_digest",
        definitionName: "workbench-digest",
        routineId: "rtn_weekly_roundup",
        routineName: "Weekly roundup",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    expect(groups.map((g) => g.groupKey).sort()).toEqual(
      ["rtn_pulse_check", "rtn_weekly_roundup"].sort(),
    );
    expect(groups.map((g) => g.displayName).sort()).toEqual(
      ["Pulse check", "Weekly roundup"].sort(),
    );
  });
});

describe("runDisplayName", () => {
  test("prefers the routine's name when the run fired from one", () => {
    expect(
      runDisplayName(
        run({
          id: "fire1",
          status: "running",
          definitionName: "workbench-digest",
          routineId: "rtn_pulse_check",
          routineName: "Pulse check",
        }),
      ),
    ).toBe("Pulse check");
  });

  test("falls back to the definition name for a run with no routine/task parent", () => {
    expect(
      runDisplayName(
        run({
          id: "direct1",
          status: "running",
          definitionName: "researcher",
          routineId: null,
          routineName: null,
        }),
      ),
    ).toBe("researcher");
  });

  test("falls back to the definition name for a native row with no routine attribution", () => {
    const native = run({
      id: "native1",
      status: "running",
      definitionName: "researcher",
    });
    delete native.routineId;
    delete native.routineName;
    expect(runDisplayName(native)).toBe("researcher");
  });
});
