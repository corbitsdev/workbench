import { describe, expect, test, beforeEach } from "bun:test";
import { turnPart, inferenceTurn } from "@intx/db/schema";
import type { DB } from "@intx/db";

import {
  withTurnPartPersistGuard,
  turnPartPersistFailures,
} from "./turn-part-write-guard";

class FakePostgresError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Mirrors drizzle-orm's own DrizzleQueryError: `.message` is just the query
// text and param list, the real Postgres error sits on `.cause`. See
// drizzle-orm/errors.js.
class FakeDrizzleQueryError extends Error {
  constructor(cause: unknown) {
    super('Failed query: insert into "turn_part" (...)\nparams: ...');
    this.cause = cause;
  }
}

function fakeDb(
  valuesImpl: (values: unknown, call: number) => Promise<unknown>,
): { db: DB["db"]; calls: unknown[] } {
  const calls: unknown[] = [];
  const db = {
    insert: () => ({
      values: (values: unknown) => {
        calls.push(values);
        return valuesImpl(values, calls.length);
      },
    }),
  } as unknown as DB["db"];
  return { db, calls };
}

describe("withTurnPartPersistGuard", () => {
  beforeEach(() => {
    turnPartPersistFailures.reset();
  });

  test("retries once and succeeds on a transient turn_id FK race", async () => {
    const { db, calls } = fakeDb(async (_values, call) => {
      if (call === 1) {
        throw new FakeDrizzleQueryError(
          new FakePostgresError(
            "23503",
            'insert or update on table "turn_part" violates foreign key constraint "turn_part_turn_id_inference_turn_id_fk"',
          ),
        );
      }
      return { ok: true };
    });
    const wrapped = withTurnPartPersistGuard(db);

    const result: unknown = await wrapped.insert(turnPart).values({
      id: "part_1",
      turnId: "turn_1",
      sessionId: "session_1",
      type: "tool",
      ordinal: 0,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(turnPartPersistFailures.count).toBe(0);
  });

  test("logs the real cause and counts the loss when the retry also fails", async () => {
    const cause = new FakePostgresError(
      "23503",
      'insert or update on table "turn_part" violates foreign key constraint "turn_part_turn_id_inference_turn_id_fk"',
    );
    const { db } = fakeDb(async () => {
      throw new FakeDrizzleQueryError(cause);
    });
    const wrapped = withTurnPartPersistGuard(db);

    await expect(
      wrapped.insert(turnPart).values({
        id: "part_1",
        turnId: "turn_1",
        sessionId: "session_1",
        type: "tool",
        ordinal: 0,
      }),
    ).rejects.toThrow();

    expect(turnPartPersistFailures.count).toBe(1);
  });

  test("counts and rethrows a non-FK failure without retrying", async () => {
    const { db, calls } = fakeDb(async () => {
      throw new FakeDrizzleQueryError(
        new FakePostgresError(
          "23502",
          "null value in column violates not-null constraint",
        ),
      );
    });
    const wrapped = withTurnPartPersistGuard(db);

    await expect(
      wrapped.insert(turnPart).values({
        id: "part_1",
        turnId: "turn_1",
        sessionId: "session_1",
        type: "tool",
        ordinal: 0,
      }),
    ).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(turnPartPersistFailures.count).toBe(1);
  });

  test("does not touch inserts into other tables", async () => {
    const { db, calls } = fakeDb(async () => ({ ok: true }));
    const wrapped = withTurnPartPersistGuard(db);

    await wrapped.insert(inferenceTurn).values({
      id: "turn_1",
      sessionId: "session_1",
      runId: "run_1",
      tenantId: "tenant_1",
      model: "claude",
      startedAt: new Date(),
    });

    expect(calls).toHaveLength(1);
    expect(turnPartPersistFailures.count).toBe(0);
  });
});
