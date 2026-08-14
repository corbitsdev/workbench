import { expect, test } from "bun:test";

import {
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL,
  REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME,
  REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
  buildArtifactPayloads,
  buildNoResultsArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the finalize call is approval-gated; the no-results report is not", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL.definitions).toEqual([
    { name: REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL_NAME, approval: "ask" },
    { name: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-reddit-opportunity-scanner/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
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

test("buildNoResultsArtifactPayload honestly reports the attempt, missing connector, and next step", () => {
  const payload = buildNoResultsArtifactPayload({
    targetUrl: "https://example.com",
    attemptedSearches: ['keyword "onboarding tool" in r/startups: unreachable'],
    missingConnectors: ["scrapecreators"],
    nextSteps: "Connect the ScrapeCreators connector, then re-run this scan.",
  });
  expect(payload.kind).toBe("reddit-opportunity-scan-no-results");
  expect(payload.title).toContain("https://example.com");
  expect(payload.content).toContain(
    'keyword "onboarding tool" in r/startups: unreachable',
  );
  expect(payload.content).toContain("scrapecreators");
  expect(payload.content).toContain(
    "Connect the ScrapeCreators connector, then re-run this scan.",
  );
});

test("buildNoResultsArtifactPayload is honest when no search was ever reachable", () => {
  const payload = buildNoResultsArtifactPayload({
    targetUrl: "https://example.com",
    attemptedSearches: [],
    missingConnectors: ["scrapecreators"],
    nextSteps: "Connect the ScrapeCreators connector, then re-run this scan.",
  });
  expect(payload.content).toMatch(/no searches were reachable/i);
});

function testEnv(): WorkflowArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowArtifactEnv;
}

test("finalize persists every selected opportunity as a recognized batch result", async () => {
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
    const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
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

test("finalize reports a partial failure honestly, naming how many opportunities already persisted", async () => {
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
    const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
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

    expect(result.isError).toBe(true);
    expect(result.content).toContain("persisting 1 of 2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finalize rejects an empty opportunities array without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
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

test("finalize rejects malformed arguments without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
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

test("finalize rejects a score outside 1-5 without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
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

test("the no-results report persists one honest teaching artifact on real invocation", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_teach", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;
  const originalFetch = globalThis.fetch;

  try {
    const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
        arguments: {
          targetUrl: "https://example.com",
          attemptedSearches: [
            'keyword "onboarding tool" in r/startups: unreachable',
          ],
          missingConnectors: ["scrapecreators"],
          nextSteps:
            "Connect the ScrapeCreators connector, then re-run this scan.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content as string) as {
      id: string;
      title: string;
      kind: string;
      persisted: boolean;
    };
    expect(parsed.persisted).toBe(true);
    expect(parsed.id).toBe("art_teach");
    expect(parsed.kind).toBe("reddit-opportunity-scan-no-results");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the no-results report surfaces a failed persist honestly", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;

  try {
    const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
        arguments: {
          targetUrl: "https://example.com",
          attemptedSearches: [],
          missingConnectors: ["scrapecreators"],
          nextSteps: "Connect the ScrapeCreators connector.",
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

test("the no-results report rejects malformed arguments without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: REDDIT_OPPORTUNITY_SCANNER_REPORT_NO_RESULTS_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects a call for an unrecognized tool name without throwing", async () => {
  const bundle = REDDIT_OPPORTUNITY_SCANNER_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: "not_a_real_tool",
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("not_a_real_tool");
});
