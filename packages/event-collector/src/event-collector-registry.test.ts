import { describe, test, expect } from "bun:test";
import { inferenceTurn, turnPart } from "@intx/db/schema";
import type { InferenceEvent } from "@intx/types/runtime";

import { createEventCollectorRegistry } from "./event-collector-registry";

// ---------------------------------------------------------------------------
// Fake DB that enforces the real foreign-key invariant: a turn_part insert
// fails unless its turn row was already committed. The inference_turn insert is
// given artificial latency so that if the registry dispatched events without
// serializing (the upstream bug, CL-1656), inference.done's part inserts would
// run during inference.start's still-pending turn insert and throw — dropping
// the parts. With per-agent serialization they cannot.
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeDb(
  opts: { turnInsertDelayMs?: number; throwOnPartOnce?: boolean } = {},
) {
  const turnInsertDelayMs = opts.turnInsertDelayMs ?? 10;
  let throwOnPartOnce = opts.throwOnPartOnce ?? false;
  const turns = new Set<string>();
  const turnRows: Record<string, unknown>[] = [];
  const parts: { turnId: string; type: string; ordinal: number }[] = [];
  const fkViolations: string[] = [];
  const turnUpdates: { status: string }[] = [];

  const db = {
    insert(table: unknown) {
      return {
        async values(vals: Record<string, unknown>) {
          if (table === inferenceTurn) {
            await delay(turnInsertDelayMs);
            turns.add(vals["id"] as string);
            turnRows.push(vals);
            return;
          }
          if (table === turnPart) {
            if (throwOnPartOnce) {
              throwOnPartOnce = false;
              throw new Error("simulated transient part insert failure");
            }
            const turnId = vals["turnId"] as string;
            if (!turns.has(turnId)) {
              fkViolations.push(turnId);
              throw new Error(
                `turn_part violates foreign key: turn ${turnId} not present`,
              );
            }
            parts.push({
              turnId,
              type: vals["type"] as string,
              ordinal: vals["ordinal"] as number,
            });
            return;
          }
          throw new Error("unexpected insert table");
        },
      };
    },
    update(_table: unknown) {
      return {
        set(vals: Record<string, unknown>) {
          return {
            async where(_cond: unknown) {
              turnUpdates.push({ status: vals["status"] as string });
            },
          };
        },
      };
    },
  };

  return { db: db as never, turns, turnRows, parts, fkViolations, turnUpdates };
}

function event(type: string, seq: number, data: unknown): InferenceEvent {
  return { type, seq, data } as InferenceEvent;
}

function startEvent(seq: number): InferenceEvent {
  return event("inference.start", seq, { model: "gpt-4" });
}

function doneEvent(seq: number): InferenceEvent {
  return event("inference.done", seq, {
    turn: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "hello" },
      ],
      model: "gpt-4",
    },
    usage: { input: 1, output: 1 },
  });
}

async function until(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

const ADDR = "ins_1@tenant.local";

describe("createEventCollectorRegistry (serialized dispatch)", () => {
  test("persists the turn row before parts when start+done dispatch back-to-back", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 20 });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create(ADDR, "tnt_1", "ses_1", "ins_1");

    // Fire both with no await between them — exactly how the orchestrator
    // dispatches a rapid start→done. The slow turn insert means an unserialized
    // registry would FK-violate on the done parts.
    registry.dispatch(ADDR, startEvent(1));
    registry.dispatch(ADDR, doneEvent(2));

    // step-start + reasoning + text + step-finish = 4 parts.
    await until(() => fake.parts.length >= 4);

    expect(fake.fkViolations).toEqual([]);
    expect(fake.turnRows).toHaveLength(1);
    const turnId = fake.turnRows[0]?.["id"];
    expect(fake.parts.map((p) => p.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "step-finish",
    ]);
    expect(fake.parts.every((p) => p.turnId === turnId)).toBe(true);
    expect(fake.parts.map((p) => p.ordinal)).toEqual([0, 1, 2, 3]);
  });

  test("does not block a second agent behind the first", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 30 });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create("a@x", "tnt_1", "ses_a", "ins_a");
    registry.create("b@x", "tnt_1", "ses_b", "ins_b");

    registry.dispatch("a@x", startEvent(1));
    registry.dispatch("b@x", startEvent(1));

    // Both agents' turn rows commit; neither is gated on the other's queue.
    await until(() => fake.turnRows.length >= 2);
    expect(fake.turnRows).toHaveLength(2);
  });

  test("reactor.done finalizes and removes the collector after the queue drains", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 5 });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create(ADDR, "tnt_1", "ses_1", "ins_1");

    registry.dispatch(ADDR, startEvent(1));
    registry.dispatch(ADDR, doneEvent(2));
    registry.dispatch(ADDR, event("reactor.done", 3, {}));

    await until(() => !registry.has(ADDR));
    expect(fake.fkViolations).toEqual([]);
    expect(registry.has(ADDR)).toBe(false);
  });

  test("preserves ordinals per turn across two sequential turns", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 10 });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create(ADDR, "tnt_1", "ses_1", "ins_1");

    registry.dispatch(ADDR, startEvent(1));
    registry.dispatch(ADDR, doneEvent(2));
    registry.dispatch(ADDR, startEvent(3));
    registry.dispatch(ADDR, doneEvent(4));

    await until(() => fake.turnRows.length >= 2 && fake.parts.length >= 8);

    expect(fake.fkViolations).toEqual([]);
    expect(fake.turnRows).toHaveLength(2);
    const [t0, t1] = [fake.turnRows[0]?.["id"], fake.turnRows[1]?.["id"]];
    expect(t0).not.toBe(t1);
    const firstTurnParts = fake.parts.filter((p) => p.turnId === t0);
    const secondTurnParts = fake.parts.filter((p) => p.turnId === t1);
    expect(firstTurnParts.map((p) => p.ordinal)).toEqual([0, 1, 2, 3]);
    expect(secondTurnParts.map((p) => p.ordinal)).toEqual([0, 1, 2, 3]);
  });

  test("a thrown onEvent does not wedge the queue — later events still apply", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 5, throwOnPartOnce: true });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create(ADDR, "tnt_1", "ses_1", "ins_1");

    // First turn's first part insert throws (swallowed + logged). The chain
    // must survive so the next turn persists fully.
    registry.dispatch(ADDR, startEvent(1));
    registry.dispatch(ADDR, doneEvent(2));
    registry.dispatch(ADDR, startEvent(3));
    registry.dispatch(ADDR, doneEvent(4));

    await until(() => fake.turnRows.length >= 2 && fake.parts.length >= 4);

    expect(fake.fkViolations).toEqual([]);
    const lastTurnId = fake.turnRows[1]?.["id"];
    const lastTurnParts = fake.parts.filter((p) => p.turnId === lastTurnId);
    expect(lastTurnParts.map((p) => p.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "step-finish",
    ]);
  });

  test("abandon drains queued events, then finalizes the turn as failed", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 15 });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create(ADDR, "tnt_1", "ses_1", "ins_1");

    registry.dispatch(ADDR, startEvent(1));
    registry.abandon(ADDR);

    // has() reflects teardown immediately (parity with upstream)...
    expect(registry.has(ADDR)).toBe(false);

    // ...but the queued start still persists its turn row, and abandon then
    // finalizes that turn as failed rather than abandoning mid-write.
    await until(() => fake.turnUpdates.some((u) => u.status === "failed"));
    expect(fake.turnRows).toHaveLength(1);
    expect(fake.fkViolations).toEqual([]);
  });

  test("create() replacing a live collector abandons the old one and persists the new turn", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 10 });
    const registry = createEventCollectorRegistry({ db: fake.db });
    registry.create(ADDR, "tnt_1", "ses_old", "ins_1");
    registry.dispatch(ADDR, startEvent(1));

    // Re-create on the same address (e.g. relaunch) while the old turn is in
    // flight; the old collector is abandoned on the shared queue and the new
    // collector's events chain after it.
    registry.create(ADDR, "tnt_1", "ses_new", "ins_1");
    registry.dispatch(ADDR, startEvent(2));
    registry.dispatch(ADDR, doneEvent(3));

    await until(() => fake.turnRows.length >= 2 && fake.parts.length >= 4);

    expect(fake.fkViolations).toEqual([]);
    expect(fake.turnUpdates.some((u) => u.status === "failed")).toBe(true);
    const newTurnId = fake.turnRows[1]?.["id"];
    const newTurnParts = fake.parts.filter((p) => p.turnId === newTurnId);
    expect(newTurnParts.map((p) => p.type)).toEqual([
      "step-start",
      "reasoning",
      "text",
      "step-finish",
    ]);
  });

  test("onTurnFinalized receives a structurally correct TurnFinalized after connector.reply", async () => {
    const fake = createFakeDb({ turnInsertDelayMs: 5 });
    const received: unknown[] = [];
    const registry = createEventCollectorRegistry({
      db: fake.db,
      onTurnFinalized: (_addr, turn) => {
        received.push(turn);
      },
    });
    registry.create(ADDR, "tnt_1", "ses_1", "ins_1");

    registry.dispatch(ADDR, startEvent(1));
    registry.dispatch(ADDR, doneEvent(2));
    registry.dispatch(
      ADDR,
      event("connector.reply", 3, { content: "hello", checkpointHash: "abc" }),
    );

    await until(() => received.length >= 1);

    const turn = received[0] as Record<string, unknown>;
    expect(typeof turn["turnId"]).toBe("string");
    expect(turn["status"]).toBe("completed");
    expect(turn["text"]).toBe("hello");
    expect(turn["hadReply"]).toBe(true);
    expect(turn["hadError"]).toBe(false);
    expect(Array.isArray(turn["errors"])).toBe(true);
    expect(Array.isArray(turn["toolCalls"])).toBe(true);
    expect(Array.isArray(turn["toolErrors"])).toBe(true);
  });
});
