import { expect, test } from "bun:test";

import {
  createRoutine,
  listRoutines,
  runRoutineNow,
  updateRoutine,
  type RoutineToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): RoutineToolClientConfig {
  return {
    hubRoutinesUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

function routineViewBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rtn_1",
    name: "Morning digest",
    definitionId: "def_1",
    trigger: { kind: "daily", hour: 9, minute: 0 },
    scope: "bench",
    input: { instruction: "Summarize overnight activity" },
    enabled: true,
    deliveryWorkbenchId: null,
    consecutiveFailures: 0,
    deadLetteredAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

test("listRoutines reaches the tenant's workflow-run routines endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({ items: [routineViewBody()] }));
  }) as unknown as typeof fetch;

  const items = await listRoutines(testConfig(fetchImpl));

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-routines/routines",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(items).toEqual([routineViewBody()] as never);
});

test("listRoutines throws an honest error on a non-ok response, never fabricating a list", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(listRoutines(testConfig(fetchImpl))).rejects.toThrow(/500/);
});

test("listRoutines throws when the response doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ nonsense: true }),
    )) as unknown as typeof fetch;

  await expect(listRoutines(testConfig(fetchImpl))).rejects.toThrow(
    /expected shape/,
  );
});

test("createRoutine posts name/definitionId/trigger/input to the routines endpoint", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody()), { status: 201 });
  }) as unknown as typeof fetch;

  const routine = await createRoutine(testConfig(fetchImpl), {
    name: "Morning digest",
    definitionId: "def_1",
    trigger: { kind: "daily", hour: 9, minute: 0 },
    input: { instruction: "Summarize overnight activity" },
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-routines/routines",
  );
  expect(seenBody).toEqual({
    name: "Morning digest",
    definitionId: "def_1",
    trigger: { kind: "daily", hour: 9, minute: 0 },
    input: { instruction: "Summarize overnight activity" },
  });
  expect(routine.id).toBe("rtn_1");
});

test("createRoutine surfaces the route's own error message on a non-ok response", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "definition not found" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(
    createRoutine(testConfig(fetchImpl), {
      name: "x",
      definitionId: "def_missing",
      trigger: { kind: "daily", hour: 9, minute: 0 },
    }),
  ).rejects.toThrow("definition not found");
});

test("updateRoutine patches the routine's own path", async () => {
  let seenUrl: string | undefined;
  let seenMethod: string | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenMethod = init?.method;
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody({ enabled: false })));
  }) as unknown as typeof fetch;

  const routine = await updateRoutine(testConfig(fetchImpl), "rtn_1", {
    enabled: false,
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-routines/routines/rtn_1",
  );
  expect(seenMethod).toBe("PATCH");
  expect(seenBody).toEqual({ enabled: false });
  expect(routine.enabled).toBe(false);
});

test("runRoutineNow posts to the routine's own run path and returns the launched run id", async () => {
  let seenUrl: string | undefined;
  let seenMethod: string | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenMethod = init?.method;
    return new Response(JSON.stringify({ runId: "run_9" }), { status: 201 });
  }) as unknown as typeof fetch;

  const result = await runRoutineNow(testConfig(fetchImpl), "rtn_1");

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-routines/routines/rtn_1/run",
  );
  expect(seenMethod).toBe("POST");
  expect(result).toEqual({ runId: "run_9" });
});

test("runRoutineNow posts a named input override when one is given", async () => {
  let seenBody: unknown;
  let seenHeaders: RequestInit["headers"];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    seenBody =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    seenHeaders = init?.headers;
    return new Response(JSON.stringify({ runId: "run_9" }), { status: 201 });
  }) as unknown as typeof fetch;

  await runRoutineNow(testConfig(fetchImpl), "rtn_1", {
    topic: "acme competitors",
  });

  expect(seenBody).toEqual({ input: { topic: "acme competitors" } });
  expect(seenHeaders).toEqual(
    expect.objectContaining({ "content-type": "application/json" }),
  );
});

test("runRoutineNow throws an honest error on an unreachable hub, never fabricating a run", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;

  await expect(runRoutineNow(testConfig(fetchImpl), "rtn_1")).rejects.toThrow(
    /connection refused/,
  );
});
