import { expect, test } from "bun:test";

import {
  EXA_TOPIC_WATCH_FINALIZE_TOOL,
  EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(EXA_TOPIC_WATCH_FINALIZE_TOOL.definitions).toEqual([
    { name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(EXA_TOPIC_WATCH_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-exa-topic-watch/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(EXA_TOPIC_WATCH_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload marks a real digest as a text artifact", () => {
  const payload = buildArtifactPayload({
    outcome: "digest",
    title: "Web topic watch: agentic coding tools",
    content: "## What moved\n\nSomething happened",
  });
  expect(payload).toEqual({
    title: "Web topic watch: agentic coding tools",
    kind: "text",
    content: "## What moved\n\nSomething happened",
  });
});

test("buildArtifactPayload marks a quiet-run note as status-note, not text", () => {
  const payload = buildArtifactPayload({
    outcome: "status-note",
    title: "Web topic watch: agentic coding tools — quiet week",
    content: "Nothing new on this topic since the last run.",
  });
  expect(payload).toEqual({
    title: "Web topic watch: agentic coding tools — quiet week",
    kind: "status-note",
    content: "Nothing new on this topic since the last run.",
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
    const bundle = EXA_TOPIC_WATCH_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "digest",
          title: "Web topic watch: agentic coding tools",
          content: "## What moved\n\nSomething happened",
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
      title: "Web topic watch: agentic coding tools",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run persists a quiet-run note with a status-note kind, distinct from a real digest", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_2", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = EXA_TOPIC_WATCH_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_2",
        name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "status-note",
          title: "Web topic watch: agentic coding tools — quiet week",
          content:
            "Searched the web for this topic and found nothing new " +
            "since the last run.",
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
    const bundle = EXA_TOPIC_WATCH_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "digest",
          title: "Web topic watch: agentic coding tools",
          content: "## What moved\n\nSomething happened",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to publish");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run rejects malformed arguments without throwing", async () => {
  const bundle = EXA_TOPIC_WATCH_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects an outcome value outside the two structural kinds", async () => {
  const bundle = EXA_TOPIC_WATCH_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
      arguments: {
        outcome: "summary",
        title: "Web topic watch: agentic coding tools",
        content: "## What moved\n\nSomething happened",
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
