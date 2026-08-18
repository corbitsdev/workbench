import { describe, expect, test } from "bun:test";

import { createTurnLatencyTracker } from "./latency-tracker";
import { createMemoryTurnLatencyStore } from "./latency-store";

function fakeClock(start: number) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createTurnLatencyTracker", () => {
  test("records every stage for a cold-start message run", async () => {
    const store = createMemoryTurnLatencyStore();
    const clock = fakeClock(1_000);
    let n = 0;
    const tracker = createTurnLatencyTracker({
      store,
      generateId: () => `id-${++n}`,
      now: clock.now,
    });

    tracker.onSessionCreate("agent-1", "tenant-acme", "session-1");

    tracker.onEvent("agent-1", { type: "reactor.start" });
    clock.advance(30_000); // cold-start reactor boot
    tracker.onEvent("agent-1", {
      type: "message.run.started",
      data: { messageId: "msg-1", messageRunId: "run-1", receivedAt: 1_000 },
    });
    clock.advance(1_000);
    tracker.onEvent("agent-1", { type: "inference.start" });
    clock.advance(2_000);
    tracker.onEvent("agent-1", { type: "inference.text.delta" });
    clock.advance(500);
    // A second delta must not move firstTokenAt.
    tracker.onEvent("agent-1", { type: "inference.text.delta" });
    clock.advance(1_500);
    tracker.onEvent("agent-1", {
      type: "message.run.ended",
      data: { messageRunId: "run-1", messageId: "msg-1", status: "completed" },
    });

    const rows = await store.listLatencyByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(1);
    const row = rows.at(0);
    if (row === undefined) throw new Error("expected a row");
    expect(row.tenantId).toBe("tenant-acme");
    expect(row.sessionId).toBe("session-1");
    expect(row.messageRunId).toBe("run-1");
    expect(row.status).toBe("completed");
    expect(row.receivedAt.getTime()).toBe(1_000);
    // reactor.start observed at t=1000, then 30s cold-start boot plus the
    // 1s before inference.start fires: reactorStartAt -> inferenceStartAt
    // spans both.
    const { reactorStartAt, inferenceStartAt, firstTokenAt, replyPostedAt } =
      row;
    if (
      reactorStartAt === null ||
      inferenceStartAt === null ||
      firstTokenAt === null
    ) {
      throw new Error("expected every stage timestamp to be recorded");
    }
    expect(inferenceStartAt.getTime() - reactorStartAt.getTime()).toBe(31_000);
    expect(firstTokenAt.getTime() - inferenceStartAt.getTime()).toBe(2_000);
    expect(replyPostedAt.getTime() - firstTokenAt.getTime()).toBe(2_000);
  });

  test("reactorStartAt is null on a warm session's later message", async () => {
    const store = createMemoryTurnLatencyStore();
    const clock = fakeClock(0);
    let n = 0;
    const tracker = createTurnLatencyTracker({
      store,
      generateId: () => `id-${++n}`,
      now: clock.now,
    });

    tracker.onSessionCreate("agent-1", "tenant-acme", "session-1");
    // No reactor.start this time — the reactor was already running.
    tracker.onEvent("agent-1", {
      type: "message.run.started",
      data: { messageId: "msg-2", messageRunId: "run-2", receivedAt: 0 },
    });
    tracker.onEvent("agent-1", { type: "inference.start" });
    tracker.onEvent("agent-1", { type: "inference.text.delta" });
    tracker.onEvent("agent-1", {
      type: "message.run.ended",
      data: { messageRunId: "run-2", messageId: "msg-2", status: "completed" },
    });

    const rows = await store.listLatencyByTenants(["tenant-acme"]);
    expect(rows[0]?.reactorStartAt).toBeNull();
  });

  test("ignores events for a session that was never created", async () => {
    const store = createMemoryTurnLatencyStore();
    const tracker = createTurnLatencyTracker({
      store,
      generateId: () => "id-1",
    });

    tracker.onEvent("ghost-agent", {
      type: "message.run.started",
      data: { messageId: "m", messageRunId: "r", receivedAt: Date.now() },
    });
    tracker.onEvent("ghost-agent", {
      type: "message.run.ended",
      data: { messageRunId: "r", messageId: "m", status: "completed" },
    });

    const rows = await store.listLatencyByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(0);
  });

  test("onSessionEnd drops in-flight state without persisting", async () => {
    const store = createMemoryTurnLatencyStore();
    const tracker = createTurnLatencyTracker({
      store,
      generateId: () => "id-1",
    });

    tracker.onSessionCreate("agent-1", "tenant-acme", "session-1");
    tracker.onEvent("agent-1", {
      type: "message.run.started",
      data: { messageId: "m", messageRunId: "r", receivedAt: Date.now() },
    });
    tracker.onSessionEnd("agent-1");
    tracker.onEvent("agent-1", {
      type: "message.run.ended",
      data: { messageRunId: "r", messageId: "m", status: "completed" },
    });

    const rows = await store.listLatencyByTenants(["tenant-acme"]);
    expect(rows).toHaveLength(0);
  });
});
