import { describe, expect, it } from "bun:test";
import type { WorkflowRun } from "../hooks/use-workflow";
import {
  DEFAULT_RUN_FILTERS,
  applyRunFilters,
  distinctRunKinds,
} from "./workflow-run-filters";

function run(partial: Partial<WorkflowRun> & { runId: string }): WorkflowRun {
  return {
    kind: "deck-build",
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

const runs: WorkflowRun[] = [
  run({
    runId: "a",
    kind: "deck-build",
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
  }),
  run({
    runId: "b",
    kind: "last30days",
    status: "failed",
    createdAt: "2026-01-03T00:00:00Z",
  }),
  run({
    runId: "c",
    kind: "deck-build",
    status: "running",
    createdAt: "2026-01-02T00:00:00Z",
  }),
];

describe("distinctRunKinds", () => {
  it("returns each kind once, sorted", () => {
    expect(distinctRunKinds(runs)).toEqual(["deck-build", "last30days"]);
  });
});

describe("applyRunFilters", () => {
  it("defaults to newest-first with no narrowing", () => {
    const out = applyRunFilters(runs, DEFAULT_RUN_FILTERS);
    expect(out.map((r) => r.runId)).toEqual(["b", "c", "a"]);
  });

  it("sorts oldest-first when asked", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      sort: "oldest",
    });
    expect(out.map((r) => r.runId)).toEqual(["a", "c", "b"]);
  });

  it("narrows by status", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      status: "failed",
    });
    expect(out.map((r) => r.runId)).toEqual(["b"]);
  });

  it("narrows by workflow kind", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      kind: "deck-build",
    });
    expect(out.map((r) => r.runId)).toEqual(["c", "a"]);
  });

  it("combines status and kind filters", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      kind: "deck-build",
      status: "running",
    });
    expect(out.map((r) => r.runId)).toEqual(["c"]);
  });

  it("matches runs by a case-insensitive kind substring search", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      search: "LAST30",
    });
    expect(out.map((r) => r.runId)).toEqual(["b"]);
  });

  it("matches runs by a case-insensitive humanized kind label search", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      search: "deck build",
    });
    expect(out.map((r) => r.runId)).toEqual(["c", "a"]);
  });

  it("matches runs by a case-insensitive runId substring search", () => {
    const withIds: WorkflowRun[] = [
      run({ runId: "run_abc123", kind: "deck-build" }),
      run({ runId: "run_xyz789", kind: "deck-build" }),
    ];
    const out = applyRunFilters(withIds, {
      ...DEFAULT_RUN_FILTERS,
      search: "ABC123",
    });
    expect(out.map((r) => r.runId)).toEqual(["run_abc123"]);
  });

  it("treats a whitespace-only search as no search", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      search: "   ",
    });
    expect(out).toHaveLength(runs.length);
  });

  it("returns nothing when the search matches no kind", () => {
    const out = applyRunFilters(runs, {
      ...DEFAULT_RUN_FILTERS,
      search: "nomatch",
    });
    expect(out).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const before = runs.map((r) => r.runId);
    applyRunFilters(runs, { ...DEFAULT_RUN_FILTERS, sort: "oldest" });
    expect(runs.map((r) => r.runId)).toEqual(before);
  });
});
