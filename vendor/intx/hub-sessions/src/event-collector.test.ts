import { describe, expect, test } from "bun:test";

import type { InferenceEvent } from "@intx/types/runtime";
import type { DB } from "@intx/db";

import { createEventCollector, type UsageForwarded } from "./event-collector";

// Minimal stand-in for the two drizzle call chains event-collector.ts
// drives (insert().values() and update().set().where()) — enough to
// exercise the inference.usage forwarding without a real database.
function createFakeDb(): DB["db"] {
  const chain = {
    values: () => Promise.resolve(),
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return {
    insert: () => chain,
    update: () => chain,
  } as unknown as DB["db"];
}

describe("createEventCollector inference.usage forwarding", () => {
  test("forwards turnId, model, and usage to onUsage — CL-5879 kill-date 2026-09-05", async () => {
    const forwarded: UsageForwarded[] = [];
    const collector = createEventCollector({
      db: createFakeDb(),
      sessionId: "session-1",
      runId: "run-1",
      tenantId: "tenant-acme",
      onUsage: (usage) => forwarded.push(usage),
    });

    await collector.onEvent({
      type: "inference.start",
      seq: 1,
      data: { model: "claude-sonnet" },
    } as InferenceEvent);

    const turnId = collector.getCurrentTurnId();
    expect(turnId).not.toBeNull();

    await collector.onEvent({
      type: "inference.usage",
      seq: 2,
      data: {
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        source: {
          sourceId: "source-1",
          provider: "anthropic",
          model: "claude-sonnet",
        },
      },
    } as InferenceEvent);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toEqual({
      turnId,
      model: "claude-sonnet",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        thinking: 0,
      },
    });
  });

  test("drops inference.usage with no active turn", async () => {
    const forwarded: UsageForwarded[] = [];
    const collector = createEventCollector({
      db: createFakeDb(),
      sessionId: "session-1",
      runId: "run-1",
      tenantId: "tenant-acme",
      onUsage: (usage) => forwarded.push(usage),
    });

    await collector.onEvent({
      type: "inference.usage",
      seq: 1,
      data: {
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          thinking: 0,
        },
        source: { sourceId: "s", provider: "anthropic", model: "m" },
      },
    } as InferenceEvent);

    expect(forwarded).toHaveLength(0);
  });
});
