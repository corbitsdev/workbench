import { expect, test } from "bun:test";

import {
  COLLATERAL_GENERATION_FINALIZE_TOOL,
  COLLATERAL_GENERATION_FINALIZE_TOOL_NAME,
  buildArtifactPayloads,
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

// The factory ignores its env entirely (this tool needs nothing beyond
// BaseEnv), so an empty object stands in for it here rather than
// constructing a full BaseEnv fixture just to satisfy the type.
function emptyEnv(): Parameters<typeof COLLATERAL_GENERATION_FINALIZE_TOOL>[0] {
  return {} as Parameters<typeof COLLATERAL_GENERATION_FINALIZE_TOOL>[0];
}

test("run finalizes every approved piece on real invocation (i.e. after approval re-dispatches the call)", async () => {
  const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(emptyEnv());
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
  const parsed = JSON.parse(result.content as string) as {
    artifacts: { title: string; persisted: boolean }[];
  };
  expect(parsed.artifacts).toHaveLength(2);
  // Honest about the current platform gap: nothing runs from here that
  // can reach the Library engine yet (see finalize-tool.ts's header).
  for (const artifact of parsed.artifacts) {
    expect(artifact.persisted).toBe(false);
  }
});

test("run rejects an empty pieces array without throwing", async () => {
  const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(emptyEnv());
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
  const bundle = COLLATERAL_GENERATION_FINALIZE_TOOL(emptyEnv());
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
