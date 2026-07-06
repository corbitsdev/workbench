import { describe, expect, it } from "bun:test";
import { deriveRunEvents, type WorkflowRunEvent } from "./run-events";
import type { ConversationWorkflowRun } from "../hooks/use-workflow";

function run(
  runId: string,
  status: ConversationWorkflowRun["status"],
  kind = "brief",
): ConversationWorkflowRun {
  return {
    runId,
    kind,
    status,
    createdAt: "2026-07-03T00:00:00.000Z",
    originConversationId: "conv-1",
  };
}

const NOW = "2026-07-03T12:00:00.000Z";

describe("deriveRunEvents", () => {
  it("seeds the baseline without emitting events on first observation", () => {
    const { events, next } = deriveRunEvents({
      previous: new Map(),
      runs: [run("r1", "running"), run("r2", "completed")],
      now: NOW,
      counter: 0,
      seed: true,
    });
    expect(events).toEqual([]);
    expect(next.get("r1")).toBe("running");
    expect(next.get("r2")).toBe("completed");
  });

  it("emits started for a run appearing after the baseline is seeded", () => {
    const { events } = deriveRunEvents({
      previous: new Map([["r1", "running"]]),
      runs: [run("r1", "running"), run("r2", "running", "deck")],
      now: NOW,
      counter: 3,
      seed: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: "r2",
      kind: "deck",
      state: "started",
    });
    expect(events[0]?.id).toBe("r2:3");
  });

  it("emits gate-awaiting when a running run parks on a gate", () => {
    const { events } = deriveRunEvents({
      previous: new Map([["r1", "running"]]),
      runs: [run("r1", "awaiting")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "r1", state: "gate-awaiting" });
    expect(events[0]?.summary).toContain("needs your input");
  });

  it("emits progressed when a gated run resumes", () => {
    const { events } = deriveRunEvents({
      previous: new Map([["r1", "awaiting"]]),
      runs: [run("r1", "running")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    expect(events[0]).toMatchObject({ runId: "r1", state: "progressed" });
  });

  it("emits completed and failed on terminal transitions", () => {
    const completed = deriveRunEvents({
      previous: new Map([["r1", "running"]]),
      runs: [run("r1", "completed")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    expect(completed.events[0]?.state).toBe("completed");

    const failed = deriveRunEvents({
      previous: new Map([["r2", "awaiting"]]),
      runs: [run("r2", "failed")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    expect(failed.events[0]?.state).toBe("failed");
  });

  it("emits no event when a run's status is unchanged", () => {
    const { events } = deriveRunEvents({
      previous: new Map([["r1", "running"]]),
      runs: [run("r1", "running")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    expect(events).toEqual([]);
  });

  it("keeps two concurrent runs distinct — one event per run, each addressed", () => {
    const { events } = deriveRunEvents({
      previous: new Map([
        ["r1", "running"],
        ["r2", "running"],
      ]),
      runs: [run("r1", "awaiting", "brief"), run("r2", "completed", "deck")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    expect(events).toHaveLength(2);
    const byRun = new Map<string, WorkflowRunEvent>(
      events.map((e) => [e.runId, e]),
    );
    expect(byRun.get("r1")?.state).toBe("gate-awaiting");
    expect(byRun.get("r1")?.kind).toBe("brief");
    expect(byRun.get("r2")?.state).toBe("completed");
    expect(byRun.get("r2")?.kind).toBe("deck");
    // Unique, stable ids so concurrent runs never collide on a React key.
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("advances the counter so repeated transitions get unique ids", () => {
    const first = deriveRunEvents({
      previous: new Map([["r1", "awaiting"]]),
      runs: [run("r1", "running")],
      now: NOW,
      counter: 0,
      seed: false,
    });
    const second = deriveRunEvents({
      previous: first.next,
      runs: [run("r1", "awaiting")],
      now: NOW,
      counter: first.counter,
      seed: false,
    });
    expect(first.events[0]?.id).not.toBe(second.events[0]?.id);
  });
});
