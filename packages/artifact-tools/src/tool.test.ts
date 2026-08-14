import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { ARTIFACT_LIST_RECENT_TOOL, artifactTools } from "./tool";
import type { WorkflowArtifactEnv } from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: ARTIFACT_LIST_RECENT_TOOL,
  arguments: {},
};

function testEnv(): WorkflowArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowArtifactEnv;
}

test("declares the artifact_list_recent tool", () => {
  const bundle = artifactTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    ARTIFACT_LIST_RECENT_TOOL,
  ]);
});

test("requires the sanctioned workflow-artifacts env keys, not a per-user credential", () => {
  expect(artifactTools.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("returns the recent artifacts on a successful call", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "art_1",
            kind: "text",
            title: "Notes",
            createdAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      }),
    )) as unknown as typeof fetch;

  // The tool bundle doesn't accept a fetchImpl override on its own env
  // contract, so this exercises the real HTTP client through a global
  // fetch stub instead — matching how `defineTool` factories are meant
  // to be exercised (env-DI, not client-DI) while still proving the
  // wire-up end to end.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const bundle = artifactTools(testEnv());
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as {
      artifacts: { id: string }[];
    };
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0]?.id).toBe("art_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an honest error result on an unreachable hub, never fabricating artifacts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;
  try {
    const bundle = artifactTools(testEnv());
    const result = await bundle.run(CALL, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/connection refused/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
