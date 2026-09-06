import { expect, test } from "bun:test";

import {
  AccessForbiddenError,
  AccessNotFoundError,
  grantAccess,
  listGrants,
  listPrincipals,
  revokeAccess,
  type AccessToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): AccessToolClientConfig {
  return {
    hubAccessUrl: "https://hub.example.com/api/workflow-access",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("listPrincipals sends sidecar auth and parses the response", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    return new Response(
      JSON.stringify({
        principals: [
          { id: "prin_1", kind: "workflow", refId: "run_1", status: "active" },
        ],
      }),
    );
  }) as unknown as typeof fetch;

  const result = await listPrincipals(testConfig(fetchImpl));

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-access/principals",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(result).toEqual([
    { id: "prin_1", kind: "workflow", refId: "run_1", status: "active" },
  ]);
});

test("listGrants filters by principalId and resource", async () => {
  let seenUrl: string | undefined;
  const fetchImpl = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ grants: [] }));
  }) as unknown as typeof fetch;

  await listGrants(testConfig(fetchImpl), {
    principalId: "prin_1",
    resource: "workflow-run:*",
  });

  const parsed = new URL(seenUrl ?? "");
  expect(parsed.searchParams.get("principalId")).toBe("prin_1");
  expect(parsed.searchParams.get("resource")).toBe("workflow-run:*");
});

test("grantAccess round-trips the created grants", async () => {
  let seenBody: unknown;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        grants: [
          {
            id: "grant_1",
            principalId: "prin_2",
            resource: "workflow-run:*",
            action: "read",
            effect: "allow",
          },
        ],
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await grantAccess(testConfig(fetchImpl), {
    principalId: "prin_2",
    resource: "workflow-run:*",
    actions: ["read"],
  });

  expect(seenBody).toEqual({
    principalId: "prin_2",
    resource: "workflow-run:*",
    actions: ["read"],
  });
  expect(result).toEqual([
    {
      id: "grant_1",
      principalId: "prin_2",
      resource: "workflow-run:*",
      action: "read",
      effect: "allow",
    },
  ]);
});

test("a 403 from grantAccess surfaces as AccessForbiddenError with the hub's userMessage", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          userMessage: "You do not have permission to perform this action",
        },
      }),
      { status: 403 },
    )) as unknown as typeof fetch;

  await expect(
    grantAccess(testConfig(fetchImpl), {
      principalId: "prin_2",
      resource: "workflow-run:*",
      actions: ["read"],
    }),
  ).rejects.toThrow(AccessForbiddenError);
});

test("a 404 from revokeAccess surfaces as AccessNotFoundError", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", userMessage: "No grant here" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(
    revokeAccess(testConfig(fetchImpl), "grant_missing"),
  ).rejects.toThrow(AccessNotFoundError);
});

test("revokeAccess sends a DELETE to the grant's own path", async () => {
  let seenUrl: string | undefined;
  let seenMethod: string | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenMethod = init?.method;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  await revokeAccess(testConfig(fetchImpl), "grant_1");

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-access/grants/grant_1",
  );
  expect(seenMethod).toBe("DELETE");
});
