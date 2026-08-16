import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  taskDispatchTools,
  DISPATCH_TASK_TOOL,
  type WorkflowDispatchEnv,
} from "./tool";

function testEnv(): WorkflowDispatchEnv {
  return {
    hubTaskPlannerUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowDispatchEnv;
}

function callFor(args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name: DISPATCH_TASK_TOOL, arguments: args };
}

test("declares exactly the dispatch_task tool", () => {
  const bundle = taskDispatchTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([DISPATCH_TASK_TOOL]);
});

test("requires the sanctioned workflow-dispatch env keys", () => {
  expect(taskDispatchTools.requires).toEqual([
    "hubTaskPlannerUrl",
    "sidecarToken",
    "address",
  ]);
});

test("declares approval: \"ask\" — Interchange's native per-invocation gate — so a human must approve before this bundle's run() ever executes", () => {
  expect(taskDispatchTools.definitions).toEqual([
    { name: DISPATCH_TASK_TOOL, approval: "ask" },
  ]);
});

test("the tool's input schema requires only outcome, and offers an optional agentDefinitionId", () => {
  const bundle = taskDispatchTools(testEnv());
  const definition = bundle.definitions[0] as unknown as {
    inputSchema: { required: string[]; properties: Record<string, unknown> };
  };
  expect(definition.inputSchema.required).toEqual(["outcome"]);
  expect(definition.inputSchema.properties["agentDefinitionId"]).toBeDefined();
});

test("the tool's description explains both dispatch paths", () => {
  const bundle = taskDispatchTools(testEnv());
  const definition = bundle.definitions[0] as unknown as {
    description: string;
  };
  expect(definition.description).toMatch(/agentDefinitionId/);
  expect(definition.description).toMatch(/planner/);
});

test("rejects a call missing the required outcome without calling out", async () => {
  const bundle = taskDispatchTools(testEnv());
  const result = await bundle.run(callFor({}), new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("on approval, dispatches with agentDefinitionId when given and returns an honest, non-fabricating success message", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ taskId: "task_1" }), { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const bundle = taskDispatchTools(testEnv());
    const result = await bundle.run(
      callFor({
        outcome: "Summarize the incident",
        agentDefinitionId: "wfd_agent",
      }),
      new AbortController().signal,
    );
    expect(seenUrl).toBe(
      "https://hub.example.com/api/workflow-task-planner/dispatch",
    );
    expect(seenBody).toEqual({
      outcome: "Summarize the incident",
      agentDefinitionId: "wfd_agent",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/^Dispatched/);
    expect(result.content).toMatch(/task_1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("on approval, dispatches without agentDefinitionId when omitted, letting the planner choose", async () => {
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ taskId: "task_2" }), { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const bundle = taskDispatchTools(testEnv());
    await bundle.run(
      callFor({ outcome: "Let the platform pick an agent" }),
      new AbortController().signal,
    );
    expect(seenBody).toEqual({ outcome: "Let the platform pick an agent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a dispatch failure returns an honest error result, never a fabricated completion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "dispatch_failed",
          message: "That task couldn't be dispatched.",
        },
      }),
      { status: 422 },
    )) as unknown as typeof fetch;
  try {
    const bundle = taskDispatchTools(testEnv());
    const result = await bundle.run(
      callFor({ outcome: "Do something impossible" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("That task couldn't be dispatched.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an honest error result on an unreachable hub, never fabricating success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;
  try {
    const bundle = taskDispatchTools(testEnv());
    const result = await bundle.run(
      callFor({ outcome: "Do something" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown tool name returns an honest error, never a silent no-op", async () => {
  const bundle = taskDispatchTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
