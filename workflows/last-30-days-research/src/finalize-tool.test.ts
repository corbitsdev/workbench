import { expect, test } from "bun:test";

import {
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL,
  LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(LAST_30_DAYS_RESEARCH_FINALIZE_TOOL.definitions).toEqual([
    { name: LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(LAST_30_DAYS_RESEARCH_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-last-30-days-research/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(LAST_30_DAYS_RESEARCH_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload passes the report through as a text artifact", () => {
  const payload = buildArtifactPayload({
    title: "Last 30 days: agentic coding tools",
    content: "## Overview\n\nSomething happened",
  });
  expect(payload).toEqual({
    title: "Last 30 days: agentic coding tools",
    kind: "text",
    content: "## Overview\n\nSomething happened",
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
    const bundle = LAST_30_DAYS_RESEARCH_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
        arguments: {
          title: "Last 30 days: agentic coding tools",
          content: "## Overview\n\nSomething happened",
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
      title: "Last 30 days: agentic coding tools",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run persists a teaching payload on the no-data path the same way as a real report", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_2", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = LAST_30_DAYS_RESEARCH_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_2",
        name: LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
        arguments: {
          title: "Last 30 days: agentic coding tools — no results yet",
          content:
            "This report would have searched the web (`exa`) and " +
            "GitHub activity for this topic. `exa` is not connected " +
            "yet — connect it in Settings to get a real report next " +
            "time.",
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
    const bundle = LAST_30_DAYS_RESEARCH_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
        arguments: {
          title: "Last 30 days: agentic coding tools",
          content: "## Overview\n\nSomething happened",
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
  const bundle = LAST_30_DAYS_RESEARCH_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: LAST_30_DAYS_RESEARCH_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
