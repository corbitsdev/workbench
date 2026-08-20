import { expect, test } from "bun:test";

import {
  ATTIO_TASK_AGENT_FINALIZE_TOOL,
  ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(ATTIO_TASK_AGENT_FINALIZE_TOOL.definitions).toEqual([
    { name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(ATTIO_TASK_AGENT_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-attio-task-agent/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(ATTIO_TASK_AGENT_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload keeps the draft kind readable in the body, not only in the run", () => {
  const payload = buildArtifactPayload({
    outcome: "draft",
    title: "Intro to Northwind Robotics",
    draftKind: "cold-email",
    content: "Subject: A faster path to your pilot",
  });
  expect(payload).toEqual({
    title: "Intro to Northwind Robotics",
    kind: "text",
    content: "Kind: cold-email\n\nSubject: A faster path to your pilot",
  });
});

test("buildArtifactPayload marks a nothing-to-draft note as status-note, with no kind prefix", () => {
  const payload = buildArtifactPayload({
    outcome: "status-note",
    title: "Northwind Robotics task — nothing to draft",
    draftKind: "task-explanation",
    content: "The task was already closed out on the record.",
  });
  expect(payload).toEqual({
    title: "Northwind Robotics task — nothing to draft",
    kind: "status-note",
    content: "The task was already closed out on the record.",
  });
});

function testEnv(): WorkflowArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowArtifactEnv;
}

test("run persists the draft on real invocation (i.e. after approval re-dispatches the call)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_1", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = ATTIO_TASK_AGENT_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "draft",
          title: "Intro to Northwind Robotics",
          draftKind: "cold-email",
          content: "Subject: A faster path to your pilot",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(String(result.content)) as {
      id: string;
      kind: string;
      persisted: boolean;
    };
    expect(parsed).toMatchObject({
      id: "art_1",
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
    const bundle = ATTIO_TASK_AGENT_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "draft",
          title: "Intro to Northwind Robotics",
          draftKind: "cold-email",
          content: "Subject: A faster path to your pilot",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Failed to save");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run rejects malformed arguments without throwing", async () => {
  const bundle = ATTIO_TASK_AGENT_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects a draft kind the prompt never taught", async () => {
  const bundle = ATTIO_TASK_AGENT_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
      arguments: {
        outcome: "draft",
        title: "Intro to Northwind Robotics",
        draftKind: "gamma-presentation",
        content: "Slide 1",
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
