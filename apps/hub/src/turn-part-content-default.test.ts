import { describe, expect, test } from "bun:test";
import { turnPart, inferenceTurn } from "@intx/db/schema";
import type { DB } from "@intx/db";

import { withTurnPartWriteDefaults } from "./turn-part-content-default";

function fakeDb(): {
  db: DB["db"];
  calls: { table: unknown; values: unknown }[];
} {
  const calls: { table: unknown; values: unknown }[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        calls.push({ table, values });
        return Promise.resolve();
      },
    }),
  } as unknown as DB["db"];
  return { db, calls };
}

describe("withTurnPartWriteDefaults", () => {
  test("fills content: '' for a tool part insert that omits content", async () => {
    const { db, calls } = fakeDb();
    const wrapped = withTurnPartWriteDefaults(db);

    await wrapped.insert(turnPart).values({
      id: "part_1",
      turnId: "turn_1",
      sessionId: "session_1",
      type: "tool",
      ordinal: 0,
      metadata: { kind: "call", callId: "call_1", name: "echo", arguments: {} },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toMatchObject({ content: "" });
  });

  test("leaves an explicit content value untouched", async () => {
    const { db, calls } = fakeDb();
    const wrapped = withTurnPartWriteDefaults(db);

    await wrapped.insert(turnPart).values({
      id: "part_2",
      turnId: "turn_1",
      sessionId: "session_1",
      type: "text",
      ordinal: 1,
      content: "hello",
    });

    expect(calls[0]?.values).toMatchObject({ content: "hello" });
  });

  test("does not touch inserts into other tables", async () => {
    const { db, calls } = fakeDb();
    const wrapped = withTurnPartWriteDefaults(db);

    await wrapped.insert(inferenceTurn).values({
      id: "turn_1",
      sessionId: "session_1",
      runId: "run_1",
      tenantId: "tenant_1",
      model: "claude",
      startedAt: new Date(),
    });

    expect(calls[0]?.values).not.toHaveProperty("content");
  });
});
