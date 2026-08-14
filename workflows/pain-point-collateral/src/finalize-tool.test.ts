import { expect, test } from "bun:test";

import {
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL,
  PAIN_POINT_COLLATERAL_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
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

// The factory ignores its env entirely (this tool needs nothing beyond
// BaseEnv), so an empty object stands in for it here rather than
// constructing a full BaseEnv fixture just to satisfy the type.
function emptyEnv(): Parameters<typeof PAIN_POINT_COLLATERAL_FINALIZE_TOOL>[0] {
  return {} as Parameters<typeof PAIN_POINT_COLLATERAL_FINALIZE_TOOL>[0];
}

test("run finalizes on real invocation (i.e. after approval re-dispatches the call)", async () => {
  const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(emptyEnv());
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
  const parsed = JSON.parse(result.content as string) as {
    title: string;
    persisted: boolean;
  };
  expect(parsed.title).toBe("Faster onboarding for Acme Corp");
  // Honest about the current platform gap: nothing runs from here that
  // can reach the Library engine yet (see finalize-tool.ts's header).
  expect(parsed.persisted).toBe(false);
});

test("run rejects malformed arguments without throwing", async () => {
  const bundle = PAIN_POINT_COLLATERAL_FINALIZE_TOOL(emptyEnv());
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
