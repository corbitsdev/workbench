import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  routinesTools,
  ROUTINE_CREATE_TOOL,
  ROUTINE_LIST_TOOL,
  ROUTINE_RUN_NOW_TOOL,
  ROUTINE_UPDATE_TOOL,
  type WorkflowRoutineEnv,
} from "./tool";

function testEnv(): WorkflowRoutineEnv {
  return {
    hubRoutinesUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowRoutineEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
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
    deliveryChannelId: null,
    consecutiveFailures: 0,
    deadLetteredAt: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

test("declares exactly the four routine tools", () => {
  const bundle = routinesTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    ROUTINE_LIST_TOOL,
    ROUTINE_CREATE_TOOL,
    ROUTINE_UPDATE_TOOL,
    ROUTINE_RUN_NOW_TOOL,
  ]);
});

test("requires the sanctioned workflow-routine env keys", () => {
  expect(routinesTools.requires).toEqual([
    "hubRoutinesUrl",
    "sidecarToken",
    "address",
  ]);
});

test("routine_list has no approval key — a read never needs a human gate", () => {
  const listDef = routinesTools.definitions.find(
    (d) => d.name === ROUTINE_LIST_TOOL,
  );
  expect(listDef).toEqual({ name: ROUTINE_LIST_TOOL });
});

test('routine_create, routine_update, and routine_run_now all declare approval: "ask"', () => {
  expect(routinesTools.definitions).toEqual([
    { name: ROUTINE_LIST_TOOL },
    { name: ROUTINE_CREATE_TOOL, approval: "ask" },
    { name: ROUTINE_UPDATE_TOOL, approval: "ask" },
    { name: ROUTINE_RUN_NOW_TOOL, approval: "ask" },
  ]);
});

test("routine_create's input schema requires name, definitionId, instruction, and trigger", () => {
  const bundle = routinesTools(testEnv());
  const definition = bundle.definitions.find(
    (d) => d.name === ROUTINE_CREATE_TOOL,
  ) as unknown as { inputSchema: { required: string[] } };
  expect(definition.inputSchema.required).toEqual([
    "name",
    "definitionId",
    "instruction",
    "trigger",
  ]);
});

test("routine_update's input schema requires only id", () => {
  const bundle = routinesTools(testEnv());
  const definition = bundle.definitions.find(
    (d) => d.name === ROUTINE_UPDATE_TOOL,
  ) as unknown as { inputSchema: { required: string[] } };
  expect(definition.inputSchema.required).toEqual(["id"]);
});

test("routine_run_now's input schema requires only id", () => {
  const bundle = routinesTools(testEnv());
  const definition = bundle.definitions.find(
    (d) => d.name === ROUTINE_RUN_NOW_TOOL,
  ) as unknown as { inputSchema: { required: string[] } };
  expect(definition.inputSchema.required).toEqual(["id"]);
});

test("routine_create rejects a call missing a required field without calling out", async () => {
  const bundle = routinesTools(testEnv());
  const result = await bundle.run(
    callFor(ROUTINE_CREATE_TOOL, { name: "x" }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/invalid input/);
});

test("routine_create rejects an invalid trigger without calling out", async () => {
  const bundle = routinesTools(testEnv());
  const result = await bundle.run(
    callFor(ROUTINE_CREATE_TOOL, {
      name: "x",
      definitionId: "def_1",
      instruction: "do it",
      trigger: { kind: "yearly" },
    }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
});

test("routine_create rejects a genuinely invalid trigger with a correct example in the message", async () => {
  const bundle = routinesTools(testEnv());
  const result = await bundle.run(
    callFor(ROUTINE_CREATE_TOOL, {
      name: "x",
      definitionId: "def_1",
      instruction: "do it",
      trigger: { kind: "yearly" },
    }),
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(
    /Example of a valid trigger: \{"kind":"daily","hour":8,"minute":0\}/,
  );
});

test("routine_create decodes a JSON-string-encoded daily trigger with a bare time field", async () => {
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody()), { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_CREATE_TOOL, {
        name: "Morning digest",
        definitionId: "def_1",
        instruction: "Summarize overnight activity",
        trigger:
          '{"kind": "daily", "type": "daily", "time": "08:00", "hour": 8}',
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect((seenBody as { trigger: unknown }).trigger).toEqual({
      kind: "daily",
      hour: 8,
      minute: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routine_create decodes a JSON-string-encoded cron trigger using expr for expression", async () => {
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody()), { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_CREATE_TOOL, {
        name: "Morning digest",
        definitionId: "def_1",
        instruction: "Summarize overnight activity",
        trigger: '{"kind": "cron", "expr": "0 8 * * *"}',
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect((seenBody as { trigger: unknown }).trigger).toEqual({
      kind: "cron",
      expression: "0 8 * * *",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routine_update coerces a type field to kind on a plain-object trigger", async () => {
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody()));
  }) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_UPDATE_TOOL, {
        id: "rtn_1",
        trigger: { type: "daily", hour: 8, minute: 0 },
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect((seenBody as { trigger: unknown }).trigger).toEqual({
      kind: "daily",
      hour: 8,
      minute: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routine_list, on success, returns the listed routines as JSON", async () => {
  let seenUrl: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ items: [routineViewBody()] }));
  }) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_LIST_TOOL, {}),
      new AbortController().signal,
    );
    expect(seenUrl).toBe(
      "https://hub.example.com/api/workflow-routines/routines",
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(result.content))).toEqual({
      items: [routineViewBody()],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routine_create, on approval, posts the instruction as input.instruction and returns a plain success message", async () => {
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody()), { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_CREATE_TOOL, {
        name: "Morning digest",
        definitionId: "def_1",
        instruction: "Summarize overnight activity",
        trigger: { kind: "daily", hour: 9, minute: 0 },
      }),
      new AbortController().signal,
    );
    expect(seenBody).toEqual({
      name: "Morning digest",
      definitionId: "def_1",
      trigger: { kind: "daily", hour: 9, minute: 0 },
      input: { instruction: "Summarize overnight activity" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('Created "Morning digest" (rtn_1).');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routine_update, on approval, patches the routine and returns a plain success message", async () => {
  let seenUrl: string | undefined;
  let seenBody: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(routineViewBody({ enabled: false })));
  }) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_UPDATE_TOOL, { id: "rtn_1", enabled: false }),
      new AbortController().signal,
    );
    expect(seenUrl).toBe(
      "https://hub.example.com/api/workflow-routines/routines/rtn_1",
    );
    expect(seenBody).toEqual({ enabled: false });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('Updated "Morning digest" (rtn_1).');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("routine_run_now, on approval, calls run-now and returns the launched run id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ runId: "run_9" }), {
      status: 201,
    })) as unknown as typeof fetch;
  try {
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_RUN_NOW_TOOL, { id: "rtn_1" }),
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("Started run run_9.");
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
    const bundle = routinesTools(testEnv());
    const result = await bundle.run(
      callFor(ROUTINE_LIST_TOOL, {}),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown tool name returns an honest error, never a silent no-op", async () => {
  const bundle = routinesTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
