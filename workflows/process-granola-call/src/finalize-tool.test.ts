import { expect, test } from "bun:test";

import {
  PROCESS_GRANOLA_CALL_FINALIZE_TOOL,
  PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(PROCESS_GRANOLA_CALL_FINALIZE_TOOL.definitions).toEqual([
    { name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(PROCESS_GRANOLA_CALL_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-process-granola-call/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(PROCESS_GRANOLA_CALL_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload formats a notes artifact with all five sections", () => {
  const payload = buildArtifactPayload({
    status: "notes",
    callId: "call_123",
    title: "Acme kickoff call",
    participants: "Jane Doe (Acme), John Smith (Corbits)",
    summary: "Discussed onboarding timeline and pricing.",
    painPoints: "Existing tool is too slow to configure.",
    decisions: "Move forward with a pilot.",
    actionItems: "Corbits to send pilot agreement by Friday.",
  });
  expect(payload.title).toBe("Acme kickoff call");
  expect(payload.kind).toBe("text");
  expect(payload.content).toContain("call_123");
  expect(payload.content).toContain("Participants");
  expect(payload.content).toContain("Jane Doe (Acme), John Smith (Corbits)");
  expect(payload.content).toContain("Summary");
  expect(payload.content).toContain("Pain points");
  expect(payload.content).toContain("Decisions");
  expect(payload.content).toContain("Action items");
});

test("buildArtifactPayload formats a teaching artifact for the no-data case", () => {
  const payload = buildArtifactPayload({
    status: "no-data",
    callId: "call_456",
    title: "Call call_456 could not be processed",
    reason: "The Granola connection returned no transcript for this call id.",
    nextSteps:
      "Check the granola connector's status in Settings > Connections and reconnect if needed.",
  });
  expect(payload.kind).toBe("text");
  expect(payload.content).toContain("call_456");
  expect(payload.content).toContain(
    "The Granola connection returned no transcript for this call id.",
  );
  expect(payload.content).toContain("granola connector");
});

function testEnv(): WorkflowArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowArtifactEnv;
}

test("run persists a notes artifact on real invocation and reports it persisted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_1", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = PROCESS_GRANOLA_CALL_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
        arguments: {
          status: "notes",
          callId: "call_123",
          title: "Acme kickoff call",
          participants: "Jane Doe (Acme)",
          summary: "Discussed onboarding.",
          painPoints: "None noted",
          decisions: "None noted",
          actionItems: "None noted",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      id: string;
      version: number;
      title: string;
      kind: string;
      persisted: boolean;
    };
    expect(parsed).toEqual({
      id: "art_1",
      version: 1,
      title: "Acme kickoff call",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run persists a teaching artifact for the no-data case, still chip-visible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_2", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = PROCESS_GRANOLA_CALL_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_2",
        name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
        arguments: {
          status: "no-data",
          callId: "call_456",
          title: "Call call_456 could not be processed",
          reason: "No Granola connection for this workspace.",
          nextSteps: "Reconnect Granola in Settings > Connections.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      id: string;
      version: number;
      title: string;
      kind: string;
      persisted: boolean;
    };
    expect(parsed).toEqual({
      id: "art_2",
      version: 1,
      title: "Call call_456 could not be processed",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run returns an honest error result when persistence fails, never fabricating persisted: true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;

  try {
    const bundle = PROCESS_GRANOLA_CALL_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
        arguments: {
          status: "notes",
          callId: "call_123",
          title: "Acme kickoff call",
          participants: "Jane Doe (Acme)",
          summary: "Discussed onboarding.",
          painPoints: "None noted",
          decisions: "None noted",
          actionItems: "None noted",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to persist");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run rejects malformed arguments without throwing", async () => {
  const bundle = PROCESS_GRANOLA_CALL_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects a notes payload missing a required section", async () => {
  const bundle = PROCESS_GRANOLA_CALL_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PROCESS_GRANOLA_CALL_FINALIZE_TOOL_NAME,
      arguments: {
        status: "notes",
        callId: "call_123",
        title: "Acme kickoff call",
        participants: "Jane Doe (Acme)",
        summary: "Discussed onboarding.",
        painPoints: "None noted",
        decisions: "None noted",
        // actionItems missing
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
