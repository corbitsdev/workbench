import { expect, test } from "bun:test";

import {
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL,
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(PAIN_POINT_COLLATERAL_FINALIZE_TOOL.definitions).toEqual([
    { name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(PAIN_POINT_COLLATERAL_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-pain-point-collateral/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(PAIN_POINT_COLLATERAL_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload marks real collateral as a text artifact and folds the targeted pain point into the body", () => {
  const payload = buildArtifactPayload({
    outcome: "collateral",
    title: "Faster onboarding for Acme Corp",
    painPoint: "Onboarding takes six weeks",
    content: "Our platform cuts onboarding to two weeks by...",
  });
  expect(payload).toEqual({
    title: "Faster onboarding for Acme Corp",
    kind: "text",
    content:
      "Targets: Onboarding takes six weeks\n\nOur platform cuts onboarding to two weeks by...",
  });
});

test("buildArtifactPayload marks a no-data teaching payload as status-note, not text", () => {
  const payload = buildArtifactPayload({
    outcome: "status-note",
    title: "No transcript available",
    painPoint: "none found",
    content: "Neither the transcript nor noteId field carried content.",
  });
  expect(payload).toEqual({
    title: "No transcript available",
    kind: "status-note",
    content:
      "Targets: none found\n\nNeither the transcript nor noteId field carried content.",
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
    const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "collateral",
          title: "Faster onboarding for Acme Corp",
          painPoint: "Onboarding takes six weeks",
          content: "Our platform cuts onboarding to two weeks by...",
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
      title: "Faster onboarding for Acme Corp",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run persists a teaching payload on the no-data path with a status-note kind, distinct from real collateral", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_2", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_2",
        name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "status-note",
          title: "No transcript available",
          painPoint: "none found",
          content: "Neither the transcript nor noteId field carried content.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      persisted: boolean;
      kind: string;
    };
    expect(parsed.persisted).toBe(true);
    expect(parsed.kind).toBe("status-note");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run returns an honest error result when persistence fails, never fabricating persisted: true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;

  try {
    const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "collateral",
          title: "Faster onboarding for Acme Corp",
          painPoint: "Onboarding takes six weeks",
          content: "Our platform cuts onboarding to two weeks by...",
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
  const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects an outcome value outside the two structural kinds", async () => {
  const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
      arguments: {
        outcome: "draft",
        title: "Faster onboarding for Acme Corp",
        painPoint: "Onboarding takes six weeks",
        content: "Our platform cuts onboarding to two weeks by...",
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
