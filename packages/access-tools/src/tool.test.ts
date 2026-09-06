import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  accessTools,
  GRANT_ACCESS_TOOL,
  LIST_GRANTS_TOOL,
  LIST_PRINCIPALS_TOOL,
  REVOKE_ACCESS_TOOL,
  type WorkflowAccessEnv,
} from "./tool";

function testEnv(): WorkflowAccessEnv {
  return {
    hubAccessUrl: "https://hub.example.com/api/workflow-access",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowAccessEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

test("declares exactly the four access tools", () => {
  const bundle = accessTools(testEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    LIST_PRINCIPALS_TOOL,
    LIST_GRANTS_TOOL,
    GRANT_ACCESS_TOOL,
    REVOKE_ACCESS_TOOL,
  ]);
});

test("requires the sanctioned env keys", () => {
  expect(accessTools.requires).toEqual([
    "hubAccessUrl",
    "sidecarToken",
    "address",
  ]);
});

test("grant_access and revoke_access declare approval: ask; the reads do not", () => {
  expect(accessTools.definitions).toEqual([
    { name: LIST_PRINCIPALS_TOOL },
    { name: LIST_GRANTS_TOOL },
    { name: GRANT_ACCESS_TOOL, approval: "ask" },
    { name: REVOKE_ACCESS_TOOL, approval: "ask" },
  ]);
});

test("list_grants rejects invalid input before ever calling fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called");
  }) as unknown as typeof fetch;
  try {
    const bundle = accessTools(testEnv());
    const result = await bundle.run(
      callFor(LIST_GRANTS_TOOL, { principalId: "" }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a 403 from grant_access surfaces as a clear tool error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          userMessage: "You do not have permission to perform this action",
        },
      }),
      { status: 403 },
    )) as unknown as typeof fetch;
  try {
    const bundle = accessTools(testEnv());
    const result = await bundle.run(
      callFor(GRANT_ACCESS_TOOL, {
        principalId: "prin_2",
        resource: "workflow-run:*",
        actions: ["read"],
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "You do not have permission to perform this action",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a successful grant_access round-trips into list_grants", async () => {
  const originalFetch = globalThis.fetch;
  const grantRow = {
    id: "grant_1",
    principalId: "prin_2",
    resource: "workflow-run:*",
    action: "read",
    effect: "allow",
  };
  let grantCreated = false;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST" && path.endsWith("/grants")) {
      grantCreated = true;
      return new Response(JSON.stringify({ grants: [grantRow] }), {
        status: 201,
      });
    }
    if (path.endsWith("/grants")) {
      return new Response(
        JSON.stringify({ grants: grantCreated ? [grantRow] : [] }),
      );
    }
    throw new Error(`unexpected request: ${String(url)}`);
  }) as unknown as typeof fetch;

  try {
    const bundle = accessTools(testEnv());
    const grantResult = await bundle.run(
      callFor(GRANT_ACCESS_TOOL, {
        principalId: "prin_2",
        resource: "workflow-run:*",
        actions: ["read"],
      }),
      new AbortController().signal,
    );
    expect(grantResult.isError).toBe(false);

    const listResult = await bundle.run(
      callFor(LIST_GRANTS_TOOL, { principalId: "prin_2" }),
      new AbortController().signal,
    );
    expect(listResult.isError).toBe(false);
    expect(listResult.content).toContain("grant_1");
    expect(listResult.content).toContain("workflow-run:*");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
