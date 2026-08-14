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

test("buildArtifactPayload folds the targeted pain point into the artifact body", () => {
  const payload = buildArtifactPayload({
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
