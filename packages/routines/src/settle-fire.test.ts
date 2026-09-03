import { describe, expect, test } from "bun:test";

import { settleRoutineFire, settleRoutineFireFromTurn } from "./settle-fire";

describe("settleRoutineFire", () => {
  test("persists completed + endedAt via markTerminal after a finished fire", async () => {
    const endedAt = new Date("2026-01-01T00:01:00.000Z");
    const calls: {
      runId: string;
      status: string;
      endedAt: Date;
    }[] = [];

    const won = await settleRoutineFire(
      {
        isRoutineFire: async () => true,
        markTerminal: async (runId, status, at) => {
          calls.push({ runId, status, endedAt: at });
          return { id: runId, status, endedAt: at };
        },
      },
      { runId: "run_fire1", status: "completed", endedAt },
    );

    expect(won).toBe(true);
    expect(calls).toEqual([
      { runId: "run_fire1", status: "completed", endedAt },
    ]);
  });

  test("a failed fire persists failed, never completed", async () => {
    const endedAt = new Date("2026-01-01T00:01:00.000Z");
    const calls: string[] = [];

    await settleRoutineFire(
      {
        isRoutineFire: async () => true,
        markTerminal: async (_runId, status, _at) => {
          calls.push(status);
          return { status };
        },
      },
      { runId: "run_fire1", status: "failed", endedAt },
    );

    expect(calls).toEqual(["failed"]);
  });

  test("does not markTerminal a run that is not a routine fire", async () => {
    let marked = false;

    const won = await settleRoutineFire(
      {
        isRoutineFire: async () => false,
        markTerminal: async () => {
          marked = true;
          return {};
        },
      },
      { runId: "run_chat1", status: "completed" },
    );

    expect(won).toBe(false);
    expect(marked).toBe(false);
  });

  test("a losing markTerminal (already terminal) is not a second persist", async () => {
    const won = await settleRoutineFire(
      {
        isRoutineFire: async () => true,
        markTerminal: async () => null,
      },
      { runId: "run_fire1", status: "completed" },
    );

    expect(won).toBe(false);
  });
});

describe("settleRoutineFireFromTurn", () => {
  test("looks up the run by address and persists the turn's terminal status", async () => {
    const endedAt = new Date("2026-01-01T00:02:00.000Z");
    const calls: {
      runId: string;
      status: string;
      endedAt: Date;
    }[] = [];

    const won = await settleRoutineFireFromTurn(
      {
        lookupRunByAddress: async (address) =>
          address === "run_fire1@acme.workbench.test"
            ? { id: "run_fire1" }
            : undefined,
        isRoutineFire: async (runId) => runId === "run_fire1",
        markTerminal: async (runId, status, at) => {
          calls.push({ runId, status, endedAt: at });
          return { id: runId, status, endedAt: at };
        },
      },
      "run_fire1@acme.workbench.test",
      { status: "completed" },
      endedAt,
    );

    expect(won).toBe(true);
    expect(calls).toEqual([
      { runId: "run_fire1", status: "completed", endedAt },
    ]);
  });

  test("a failed turn persists failed", async () => {
    const calls: string[] = [];

    await settleRoutineFireFromTurn(
      {
        lookupRunByAddress: async () => ({ id: "run_fire1" }),
        isRoutineFire: async () => true,
        markTerminal: async (_runId, status) => {
          calls.push(status);
          return { status };
        },
      },
      "run_fire1@acme.workbench.test",
      { status: "failed" },
      new Date("2026-01-01T00:02:00.000Z"),
    );

    expect(calls).toEqual(["failed"]);
  });

  test("unknown address is a no-op", async () => {
    let marked = false;

    const won = await settleRoutineFireFromTurn(
      {
        lookupRunByAddress: async () => undefined,
        isRoutineFire: async () => true,
        markTerminal: async () => {
          marked = true;
          return {};
        },
      },
      "run_missing@acme.workbench.test",
      { status: "completed" },
    );

    expect(won).toBe(false);
    expect(marked).toBe(false);
  });
});
