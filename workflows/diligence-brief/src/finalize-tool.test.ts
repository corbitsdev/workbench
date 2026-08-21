import { expect, test } from "bun:test";

import {
  DILIGENCE_BRIEF_FINALIZE_TOOL,
  DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
  buildArtifactPayload,
  type WorkflowArtifactEnv,
} from "./finalize-tool";

test("the tool's definition marks itself approval-gated", () => {
  expect(DILIGENCE_BRIEF_FINALIZE_TOOL.definitions).toEqual([
    { name: DILIGENCE_BRIEF_FINALIZE_TOOL_NAME, approval: "ask" },
  ]);
});

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(DILIGENCE_BRIEF_FINALIZE_TOOL.id).toBe(
    "@corbits/workflow-diligence-brief/finalize",
  );
});

test("requires the sanctioned workflow-artifacts env keys", () => {
  expect(DILIGENCE_BRIEF_FINALIZE_TOOL.requires).toEqual([
    "hubArtifactsUrl",
    "sidecarToken",
    "address",
  ]);
});

test("buildArtifactPayload marks a real brief as a text artifact", () => {
  const payload = buildArtifactPayload({
    outcome: "brief",
    title: "Diligence brief: Acme Corp",
    content: "## Overview\n\nAcme Corp sells widgets",
  });
  expect(payload).toEqual({
    title: "Diligence brief: Acme Corp",
    kind: "text",
    content: "## Overview\n\nAcme Corp sells widgets",
  });
});

test("buildArtifactPayload marks a no-data teaching payload as status-note, not text", () => {
  const payload = buildArtifactPayload({
    outcome: "status-note",
    title: "Diligence brief: Acme Corp — no results yet",
    content: "`exa` is not connected yet.",
  });
  expect(payload).toEqual({
    title: "Diligence brief: Acme Corp — no results yet",
    kind: "status-note",
    content: "`exa` is not connected yet.",
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
    const bundle = DILIGENCE_BRIEF_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "brief",
          title: "Diligence brief: Acme Corp",
          content: "## Overview\n\nAcme Corp sells widgets",
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
      title: "Diligence brief: Acme Corp",
      kind: "text",
      persisted: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("run persists a teaching payload on the no-data path with a status-note kind, distinct from a real brief", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: { id: "art_2", version: 1 } }), {
      status: 201,
    })) as unknown as typeof fetch;

  try {
    const bundle = DILIGENCE_BRIEF_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_2",
        name: DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "status-note",
          title: "Diligence brief: Acme Corp — no results yet",
          content:
            "This brief would have searched the web (`exa`) and firm " +
            "memory for this company. `exa` is not connected yet — " +
            "connect it in Settings to get a real brief next time.",
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
    const bundle = DILIGENCE_BRIEF_FINALIZE_TOOL(testEnv());
    const result = await bundle.run(
      {
        id: "call_1",
        name: DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
        arguments: {
          outcome: "brief",
          title: "Diligence brief: Acme Corp",
          content: "## Overview\n\nAcme Corp sells widgets",
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
  const bundle = DILIGENCE_BRIEF_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});

test("run rejects an outcome value outside the two structural kinds", async () => {
  const bundle = DILIGENCE_BRIEF_FINALIZE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: DILIGENCE_BRIEF_FINALIZE_TOOL_NAME,
      arguments: {
        outcome: "summary",
        title: "Diligence brief: Acme Corp",
        content: "## Overview\n\nAcme Corp sells widgets",
      },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid arguments");
});
