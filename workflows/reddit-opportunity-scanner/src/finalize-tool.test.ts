import { expect, test } from "bun:test";

import {
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL,
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
  buildArtifactPayloads,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL.definitions).toEqual([
    { name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-reddit-opportunity-scanner/finalize",
  );
});

test("buildArtifactPayloads fixes every opportunity's kind and folds context into the body", () => {
  const payloads = buildArtifactPayloads({
    opportunities: [
      {
        title: "Founder asking for an onboarding tool",
        subreddit: "startups",
        url: "https://reddit.com/r/startups/comments/abc123/onboarding",
        score: 4,
        whyItMatters: "Explicit buying signal, actively comparing tools",
        content: "Reply with a plain comparison of options, no pitching.",
      },
    ],
  });
  expect(payloads).toEqual([
    {
      title: "Founder asking for an onboarding tool",
      kind: "reddit-opportunity-scan",
      content:
        "Subreddit: r/startups\n" +
        "Score: 4/5\n" +
        "URL: https://reddit.com/r/startups/comments/abc123/onboarding\n" +
        "\n" +
        "Why it matters: Explicit buying signal, actively comparing tools\n" +
        "\n" +
        "Reply with a plain comparison of options, no pitching.",
    },
  ]);
});

// The factory ignores its env entirely (this tool needs nothing beyond
// BaseEnv), so an empty object stands in for it here rather than
// constructing a full BaseEnv fixture just to satisfy the type.
function emptyEnv(): Parameters<
  typeof REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL
>[0] {
  return {} as Parameters<typeof REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL>[0];
}

test("run finalizes every selected opportunity on real invocation (i.e. after approval re-dispatches the call)", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(emptyEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
      arguments: {
        opportunities: [
          {
            title: "Founder asking for an onboarding tool",
            subreddit: "startups",
            url: "https://reddit.com/r/startups/comments/abc123/onboarding",
            score: 4,
            whyItMatters: "Explicit buying signal",
            content: "Reply with a plain comparison of options.",
          },
          {
            title: "Complaint about slow onboarding",
            subreddit: "smallbusiness",
            url: "https://reddit.com/r/smallbusiness/comments/def456/slow",
            score: 3,
            whyItMatters: "Named pain point, no vendor mentioned yet",
            content: "Reply with empathy and one concrete tip.",
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

test("run rejects an empty opportunities array without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(emptyEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
      arguments: { opportunities: [] },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("at least one selected opportunity");
});

test("run rejects malformed arguments without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(emptyEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects a score outside 1-5 without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(emptyEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
      arguments: {
        opportunities: [
          {
            title: "Off-scale score",
            subreddit: "startups",
            url: "https://reddit.com/r/startups/comments/xyz/off-scale",
            score: 9,
            whyItMatters: "n/a",
            content: "n/a",
          },
        ],
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
