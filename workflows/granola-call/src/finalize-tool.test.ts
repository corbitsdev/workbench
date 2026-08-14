import { expect, test } from "bun:test";

import {
  GRANOLA_CALL_REPORT_STATUS_TOOL,
  GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
  buildStatusArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool carries no approval mark: a status report has nothing for a human to confirm", () => {
  expect(GRANOLA_CALL_REPORT_STATUS_TOOL.definitions).toEqual([
    { name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(GRANOLA_CALL_REPORT_STATUS_TOOL.id).toBe(
    "@corbits/workflow-granola-call/report-status",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(GRANOLA_CALL_REPORT_STATUS_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildStatusArtifactPayload names the reason, examined count, and next steps", () => {
  const payload = buildStatusArtifactPayload({
    reason: "No Granola connection is configured for this workspace.",
    callsExamined: 0,
    nextSteps:
      "Connect Granola in Settings > Connections, then re-run this Routine.",
  });
  expect(payload.kind).toBe("text");
  expect(payload.content).toContain(
    "No Granola connection is configured for this workspace.",
  );
  expect(payload.content).toContain("0");
  expect(payload.content).toContain(
    "Connect Granola in Settings > Connections, then re-run this Routine.",
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

test("run persists the status artifact and reports it persisted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_1", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = GRANOLA_CALL_REPORT_STATUS_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
        arguments: {
          reason: "No Granola connection is configured for this workspace.",
          callsExamined: 0,
          nextSteps: "Connect Granola in Settings > Connections.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      id: string;
      version: number;
      kind: string;
      persisted: boolean;
    };
    expect(parsed.id).toBe("art_1");
    expect(parsed.version).toBe(1);
    expect(parsed.persisted).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run returns an honest error result when persistence fails, never fabricating persisted: true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;

  try {
    const bundle = GRANOLA_CALL_REPORT_STATUS_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
        arguments: {
          reason: "No Granola connection is configured for this workspace.",
          callsExamined: 0,
          nextSteps: "Connect Granola in Settings > Connections.",
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
  const bundle = GRANOLA_CALL_REPORT_STATUS_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects a negative callsExamined", async () => {
  const bundle = GRANOLA_CALL_REPORT_STATUS_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
      arguments: {
        reason: "No Granola connection is configured for this workspace.",
        callsExamined: -1,
        nextSteps: "Connect Granola in Settings > Connections.",
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
