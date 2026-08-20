import { expect, test } from "bun:test";

import { fireRoutineNow, type FireRoutineApiResult } from "./fire-routine.ts";
import type { SqlClientLike } from "./trace.ts";

const noRows: SqlClientLike = { unsafe: async () => [] };

test("posts run-now, polls until the run appears, and reads its tool calls", async () => {
  const calls: { method: string; route: string }[] = [];
  let listCount = 0;
  const api = async (
    _base: string,
    method: string,
    route: string,
  ): Promise<FireRoutineApiResult> => {
    calls.push({ method, route });
    if (method === "POST") {
      return { status: 201, data: { runId: "run-123" } };
    }
    listCount += 1;
    if (listCount < 2) {
      return { status: 200, data: { items: [] } };
    }
    return {
      status: 200,
      data: { items: [{ runId: "run-123", run: { status: "delivered" } }] },
    };
  };

  const turn = await fireRoutineNow(
    {
      api,
      hubUrl: "http://hub.test",
      tenantId: "tenant-1",
      cookies: ["session=abc"],
      sql: noRows,
    },
    "routine-1",
    "Daily digest",
    { pollIntervalMs: 0 },
  );

  expect(turn.human).toBe("(routine fired: Daily digest)");
  expect(turn.replyText).toBe(JSON.stringify({ status: "delivered" }));
  expect(turn.toolCalls).toEqual([]);
  expect(calls[0]).toMatchObject({
    method: "POST",
    route: "/api/tenants/tenant-1/routines/routine-1/run",
  });
  expect(listCount).toBe(2);
});

test("reads the fired run's tool calls off the platform tables", async () => {
  const sql: SqlClientLike = {
    unsafe: async () => [
      {
        metadata: JSON.stringify({
          kind: "call",
          callId: "c1",
          name: "memory_add",
          arguments: { key: "cadence" },
        }),
        ordinal: 0,
        started_at: new Date(0),
      },
      {
        metadata: JSON.stringify({
          kind: "result",
          callId: "c1",
          content: "saved",
          isError: false,
        }),
        ordinal: 1,
        started_at: new Date(0),
      },
    ],
  };
  const api = async (
    _base: string,
    method: string,
  ): Promise<FireRoutineApiResult> =>
    method === "POST"
      ? { status: 201, data: { runId: "run-9" } }
      : { status: 200, data: { items: [{ runId: "run-9" }] } };

  const turn = await fireRoutineNow(
    {
      api,
      hubUrl: "http://hub.test",
      tenantId: "tenant-1",
      cookies: [],
      sql,
    },
    "routine-2",
    "Memory writer",
    { pollIntervalMs: 0 },
  );

  expect(turn.toolCalls).toEqual([
    {
      name: "memory_add",
      arguments: { key: "cadence" },
      isError: false,
      result: "saved",
    },
  ]);
});

test("throws a named error if run-now does not return 201", async () => {
  const api = async (): Promise<FireRoutineApiResult> => ({
    status: 404,
    data: { error: { code: "not_found" } },
  });
  await expect(
    fireRoutineNow(
      {
        api,
        hubUrl: "http://hub.test",
        tenantId: "t",
        cookies: [],
        sql: noRows,
      },
      "missing-routine",
      "Ghost routine",
    ),
  ).rejects.toThrow(/POST .\/\/\/run returned 404|POST .*\/run returned 404/);
});

test("times out loudly if the run never appears in the run list", async () => {
  const api = async (
    _base: string,
    method: string,
  ): Promise<FireRoutineApiResult> =>
    method === "POST"
      ? { status: 201, data: { runId: "run-gone" } }
      : { status: 200, data: { items: [] } };

  await expect(
    fireRoutineNow(
      {
        api,
        hubUrl: "http://hub.test",
        tenantId: "t",
        cookies: [],
        sql: noRows,
      },
      "routine-3",
      "Vanishing routine",
      { pollTimeoutMs: 5, pollIntervalMs: 1 },
    ),
  ).rejects.toThrow(/never appeared/);
});
