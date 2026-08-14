import { expect, test } from "bun:test";

import {
  COLLATERAL_GENERATION_FINALIZE_TOOL,
  COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
  buildArtifactPayloads,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(COLLATERAL_GENERATION_FINALIZE_TOOL.definitions).toEqual([
    { name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(COLLATERAL_GENERATION_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-collateral-generation/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(COLLATERAL_GENERATION_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayloads maps each piece's content type to the artifact kind", () => {
  const payloads = buildArtifactPayloads({
    pieces: [
      {
        title: "Faster onboarding, in plain terms",
        contentType: "linkedin-post",
        content: "Our platform cuts onboarding time by...",
      },
      {
        title: "Why teams switch",
        contentType: "blog-short",
        content: "Teams switch when the old workflow costs more than...",
      },
    ],
  });
  expect(payloads).toEqual([
    {
      title: "Faster onboarding, in plain terms",
      kind: "linkedin-post",
      content: "Our platform cuts onboarding time by...",
    },
    {
      title: "Why teams switch",
      kind: "blog-short",
      content: "Teams switch when the old workflow costs more than...",
    },
  ]);
});

function testEnv(): WorkflowArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowArtifactEnv;
}

test("run persists every approved piece on real invocation (i.e. after approval re-dispatches the call)", async () => {
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    call += 1;
    return new Response(
      JSON.stringify({ data: { id: `art_${call}`, version: 1 } }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  try {
    const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
        arguments: {
          pieces: [
            {
              title: "Faster onboarding, in plain terms",
              contentType: "linkedin-post",
              content: "Our platform cuts onboarding time by...",
            },
            {
              title: "Why teams switch",
              contentType: "blog-short",
              content: "Teams switch when the old workflow costs more than...",
            },
          ],
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      artifacts: { id: string; title: string; persisted: boolean }[];
    };
    expect(parsed.artifacts).toHaveLength(2);
    expect(parsed.artifacts.map((a) => a.id)).toEqual(["art_1", "art_2"]);
    for (const artifact of parsed.artifacts) {
      expect(artifact.persisted).toBe(true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run reports a partial failure honestly, naming how many pieces already persisted", async () => {
  let call = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({ data: { id: "art_1", version: 1 } }),
        { status: 201 },
      );
    }
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  try {
    const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
        arguments: {
          pieces: [
            {
              title: "Faster onboarding, in plain terms",
              contentType: "linkedin-post",
              content: "Our platform cuts onboarding time by...",
            },
            {
              title: "Why teams switch",
              contentType: "blog-short",
              content: "Teams switch when the old workflow costs more than...",
            },
          ],
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("persisting 1 of 2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run rejects an empty pieces array without throwing", async () => {
  const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
      arguments: { pieces: [] },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("at least one approved piece");
});

test("run rejects malformed arguments without throwing", async () => {
  const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
