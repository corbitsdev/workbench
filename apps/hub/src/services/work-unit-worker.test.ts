import { describe, expect, it } from "bun:test";
import type { HubDb } from "../db";
import type { WorkUnitQueue } from "./work-unit-queue";
import { createWorkUnitWorker } from "./work-unit-worker";

function makeStubQueue(): WorkUnitQueue {
  return {
    enqueue: async () => ({ id: "u1", created: true }),
    claimDue: async () => [],
    heartbeat: async () => true,
    complete: async () => {},
    fail: async () => {},
    retryDead: async () => false,
    discardDead: async () => false,
    listDead: async () => [],
    listAgedLeased: async () => [],
    health: async () => ({
      byStatus: {},
      byKindStatus: [],
      oldestPendingAgeMs: null,
      deadCount: 0,
      agedLeasedCount: 0,
    }),
  };
}

describe("createWorkUnitWorker shutdown", () => {
  it("stop is safe before start and idempotent after start", () => {
    const worker = createWorkUnitWorker({
      db: {} as HubDb,
      queue: makeStubQueue(),
      tickIntervalMs: 60_000,
    });

    expect(() => worker.stop()).not.toThrow();
    worker.start();
    expect(() => worker.stop()).not.toThrow();
    expect(() => worker.stop()).not.toThrow();
  });
});
