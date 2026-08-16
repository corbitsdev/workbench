import { expect, test } from "bun:test";

import {
  dispatchTask,
  TaskDispatchFailedError,
  type TaskDispatchClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): TaskDispatchClientConfig {
  return {
    hubTaskPlannerUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("dispatchTask posts to the workflow-task-planner dispatch endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ taskId: "task_1" }), { status: 201 });
  }) as unknown as typeof fetch;

  const result = await dispatchTask(testConfig(fetchImpl), {
    outcome: "Summarize the incident",
    agentDefinitionId: "wfd_agent",
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-task-planner/dispatch",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(seenBody).toEqual({
    outcome: "Summarize the incident",
    agentDefinitionId: "wfd_agent",
  });
  expect(result).toEqual({ taskId: "task_1" });
});

test("dispatchTask omits agentDefinitionId from the request body when not given", async () => {
  let seenBody: unknown;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ taskId: "task_1" }), { status: 201 });
  }) as unknown as typeof fetch;

  await dispatchTask(testConfig(fetchImpl), {
    outcome: "Let the planner decide",
  });

  expect(seenBody).toEqual({ outcome: "Let the planner decide" });
});

test("dispatchTask throws TaskDispatchFailedError on the route's fail-closed 422", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "dispatch_failed",
          message: "That task couldn't be dispatched.",
        },
      }),
      { status: 422 },
    )) as unknown as typeof fetch;

  await expect(
    dispatchTask(testConfig(fetchImpl), { outcome: "Do something" }),
  ).rejects.toBeInstanceOf(TaskDispatchFailedError);
});

test("dispatchTask throws TaskDispatchFailedError on a 400 bad request", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "bad_request",
          message: "This dispatch couldn't be read",
        },
      }),
      { status: 400 },
    )) as unknown as typeof fetch;

  await expect(
    dispatchTask(testConfig(fetchImpl), { outcome: "" }),
  ).rejects.toBeInstanceOf(TaskDispatchFailedError);
});

test("dispatchTask throws an honest error on a non-4xx HTTP failure, never fabricating a result", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(
    dispatchTask(testConfig(fetchImpl), { outcome: "Do something" }),
  ).rejects.toThrow(/500/);
});

test("dispatchTask throws on a response that doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ nonsense: true }), {
      status: 201,
    })) as unknown as typeof fetch;

  await expect(
    dispatchTask(testConfig(fetchImpl), { outcome: "Do something" }),
  ).rejects.toThrow(/expected shape/);
});

test("dispatchTask propagates an unreachable-hub failure honestly", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;

  await expect(
    dispatchTask(testConfig(fetchImpl), { outcome: "Do something" }),
  ).rejects.toThrow(/connection refused/);
});
