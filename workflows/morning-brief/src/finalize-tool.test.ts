import { expect, test } from "bun:test";

import {
  MORNING_BRIEF_FINALIZE_TOOL,
  MORNING_BRIEF_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(MORNING_BRIEF_FINALIZE_TOOL.definitions).toEqual([
    { name: MORNING_BRIEF_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(MORNING_BRIEF_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-morning-brief/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(MORNING_BRIEF_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload passes the brief through as a text artifact", () => {
  const payload = buildArtifactPayload({
    title: "Morning brief — Tuesday",
    content: "## What happened\n\n- Shipped the thing",
  });
  expect(payload).toEqual({
    title: "Morning brief — Tuesday",
    kind: "text",
    content: "## What happened\n\n- Shipped the thing",
  });
});

function testEnv(): WorkflowArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowArtifactEnv;
}

test("run persists the artifact on real invocation (i.e. after approval re-dispatches the call) and reports it persisted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_1", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = MORNING_BRIEF_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: MORNING_BRIEF_FINALIZE_TOOL_NAME,
        arguments: {
          title: "Morning brief — Tuesday",
          content: "## What happened\n\n- Shipped the thing",
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
      title: "Morning brief — Tuesday",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run persists a teaching payload on the no-data path the same way as a real brief", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_2", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = MORNING_BRIEF_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_2",
        name: MORNING_BRIEF_FINALIZE_TOOL_NAME,
        arguments: {
          title: "Morning brief — no connected sources yet",
          content:
            "This brief would have looked for recent Granola call " +
            "notes and recently updated Linear issues. Neither `granola` " +
            "nor `linear` is connected yet — connect them in Settings to " +
            "get a real brief tomorrow.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as { persisted: boolean };
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
    const bundle = MORNING_BRIEF_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: MORNING_BRIEF_FINALIZE_TOOL_NAME,
        arguments: {
          title: "Morning brief — Tuesday",
          content: "## What happened\n\n- Shipped the thing",
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
  const bundle = MORNING_BRIEF_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: MORNING_BRIEF_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
