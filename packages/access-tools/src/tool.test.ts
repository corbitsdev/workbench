import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import { accessTools, GRANT_ACCESS_TOOL, LIST_GRANTS_TOOL, type WorkflowAccessEnv } from "./tool";

function testEnv(): WorkflowAccessEnv {
  return {
    hubAccessUrl: "https://hub.example.com",
    tenantId: "ten_1",
    principalId: "prin_caller",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as WorkflowAccessEnv;
}

function callFor(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: args };
}

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

test("a 403 from the stock grant route surfaces as a clear tool error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          message: "Myra can only grant room:read — she herself holds no room:write here",
        },
      }),
      { status: 403 },
    )) as unknown as typeof fetch;
  try {
    const bundle = accessTools(testEnv());
    const result = await bundle.run(
      callFor(GRANT_ACCESS_TOOL, {
        principalId: "prin_2",
        resource: "room:*",
        actions: ["write"],
      }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Myra can only grant room:read — she herself holds no room:write here",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a successful grant_access round-trips into list_grants", async () => {
  const originalFetch = globalThis.fetch;
  function nativeRow(id: string, action: string) {
    return {
      id,
      principalId: "prin_2",
      resource: "workflow-run:*",
      action,
      effect: "allow",
      origin: "invoker",
      conditions: null,
      expiresAt: null,
      roleId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
  }
  const posted: unknown[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "POST" && path.endsWith("/grants")) {
      const body = JSON.parse(String(init?.body)) as { action: string };
      posted.push(body);
      // Native `POST /grants` creates exactly one single-action grant and
      // returns the single `GrantResponse` object.
      return new Response(JSON.stringify(nativeRow(`grant_${posted.length}`, body.action)), {
        status: 201,
      });
    }
    if (path.endsWith("/grants")) {
      // The caller's own ceiling read: wide enough to delegate anything.
      if (String(url).includes("principalId=prin_caller")) {
        return new Response(
          JSON.stringify({
            data: [{ ...nativeRow("own_1", "*"), principalId: "prin_caller" }],
            nextCursor: null,
          }),
        );
      }
      // Stock `GET /grants` returns the `{data, nextCursor}` page envelope.
      return new Response(
        JSON.stringify({
          data:
            posted.length === 0
              ? []
              : posted.map((body, index) =>
                  nativeRow(`grant_${index + 1}`, (body as { action: string }).action),
                ),
          nextCursor: null,
        }),
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
        actions: ["read", "write"],
      }),
      new AbortController().signal,
    );
    expect(grantResult.isError).toBe(false);
    expect(grantResult.content).toContain("2 grants created");

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
