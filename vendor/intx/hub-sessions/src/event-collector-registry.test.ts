import { describe, expect, test } from "bun:test";

import type { InferenceEvent } from "@intx/types/runtime";
import type { DB } from "@intx/db";

import { createEventCollectorRegistry } from "./event-collector-registry";

// Captures every insert/update the collector issues, resolving each on a
// later tick so concurrent onEvent calls would interleave exactly the way
// they do against a real database. Rows are told apart by shape: an
// inference_turn insert carries `model`, a turn_part insert carries
// `ordinal`.
function createRecordingDb(): {
  db: DB["db"];
  turnInserts: Record<string, unknown>[];
  partInserts: Record<string, unknown>[];
  turnUpdates: Record<string, unknown>[];
} {
  const turnInserts: Record<string, unknown>[] = [];
  const partInserts: Record<string, unknown>[] = [];
  const turnUpdates: Record<string, unknown>[] = [];
  const later = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        await later();
        if ("model" in row) turnInserts.push(row);
        else partInserts.push(row);
      },
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => ({
        where: async () => {
          await later();
          turnUpdates.push(row);
        },
      }),
    }),
  } as unknown as DB["db"];
  return { db, turnInserts, partInserts, turnUpdates };
}

function turnEvents(seqBase: number, text: string): InferenceEvent[] {
  return [
    {
      type: "inference.start",
      seq: seqBase,
      data: { model: "test-model" },
    },
    {
      type: "inference.done",
      seq: seqBase + 1,
      data: { turn: { content: [{ type: "text", text }] } },
    },
    {
      type: "connector.reply",
      seq: seqBase + 2,
      data: { content: text },
    },
  ] as InferenceEvent[];
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("event collector registry dispatch ordering (CL-6379)", () => {
  test("back-to-back turn events dispatched without awaiting persist every part, in order, and finalize every turn", async () => {
    const { db, turnInserts, partInserts, turnUpdates } = createRecordingDb();
    const registry = createEventCollectorRegistry({ db });
    registry.create("agent@test", "tenant-1", "ses_1", "run-1");

    // Fire-and-forget, exactly as the session orchestrator's `agent.event`
    // listener does: two full turns arrive faster than any DB roundtrip.
    for (const event of [...turnEvents(1, "first"), ...turnEvents(4, "second")]) {
      registry.dispatch("agent@test", event);
    }

    await until(() => turnUpdates.length >= 2, 2000);

    // Two turns opened, two finalized — the second turn must not be left
    // "running" because the first turn's finalize interleaved with it.
    expect(turnInserts).toHaveLength(2);
    expect(turnUpdates).toHaveLength(2);
    expect(turnUpdates.map((u) => u["status"])).toEqual([
      "completed",
      "completed",
    ]);

    // Each turn persists step-start, text, step-finish — nothing dropped
    // by "no active turn", and ordinals reflect event order.
    const byTurn = new Map<unknown, Record<string, unknown>[]>();
    for (const part of partInserts) {
      const parts = byTurn.get(part["turnId"]) ?? [];
      parts.push(part);
      byTurn.set(part["turnId"], parts);
    }
    expect(byTurn.size).toBe(2);
    for (const parts of byTurn.values()) {
      expect(parts.map((p) => p["type"])).toEqual([
        "step-start",
        "text",
        "step-finish",
      ]);
      expect(parts.map((p) => p["ordinal"])).toEqual([0, 1, 2]);
    }

    // After both turns settle the collector is idle: no current turn.
    expect(registry.getCurrentTurnId("agent@test")).toBeNull();
  });
});
