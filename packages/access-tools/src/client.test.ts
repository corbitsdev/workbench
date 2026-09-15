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

function nativePrincipal(id: string) {
  return {
    id,
    kind: "workflow",
    refId: `${id}@example.test`,
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function nativeGrant(id: string) {
  return {
    id,
    principalId: "prin_2",
    resource: "workflow-run:*",
    action: "read",
    effect: "allow",
    origin: "invoker",
    conditions: null,
    expiresAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

test("listPrincipals reads the native page envelope and follows nextCursor", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const raw = String(url);
    seen.push(raw);
    if (raw.includes("cursor=prin_2")) {
      return Response.json({
        data: [nativePrincipal("prin_3")],
        nextCursor: null,
      });
    }
    return Response.json({
      data: [nativePrincipal("prin_1"), nativePrincipal("prin_2")],
      nextCursor: "prin_2",
    });
  }) as unknown as typeof fetch;

  const principals = await listPrincipals(testConfig(fetchImpl));
  expect(principals.map((p) => p.id)).toEqual(["prin_1", "prin_2", "prin_3"]);
  expect(principals[0]).toMatchObject({
    kind: "workflow",
    refId: "prin_1@example.test",
    status: "active",
  });
  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain("cursor=prin_2");
});

test("listGrants passes filters through and reads the native page envelope", async () => {
  let seenUrl = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    seenUrl = String(url);
    return Response.json({ data: [nativeGrant("grant_1")], nextCursor: null });
  }) as unknown as typeof fetch;

  const grants = await listGrants(testConfig(fetchImpl), {
    principalId: "prin_2",
    resource: "workflow-run:*",
  });
  expect(seenUrl).toContain(
    "/grants?principalId=prin_2&resource=workflow-run%3A*",
  );
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    id: "grant_1",
    principalId: "prin_2",
    resource: "workflow-run:*",
    action: "read",
    effect: "allow",
  });
});

test("grantAccess posts one native single-action body per action and parses single GrantResponse objects", async () => {
  const posted: unknown[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    expect(String(url)).toBe(
      "https://hub.example.com/api/workflow-access/grants",
    );
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posted.push(body);
    return new Response(
      JSON.stringify({
        ...nativeGrant(`grant_${posted.length}`),
        action: body["action"],
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const grants = await grantAccess(testConfig(fetchImpl), {
    principalId: "prin_2",
    resource: "workflow-run:*",
    actions: ["read", "write"],
  });
  expect(posted).toEqual([
    {
      principalId: "prin_2",
      resource: "workflow-run:*",
      action: "read",
      effect: "allow",
      origin: "invoker",
    },
    {
      principalId: "prin_2",
      resource: "workflow-run:*",
      action: "write",
      effect: "allow",
      origin: "invoker",
    },
  ]);
  expect(grants.map((g) => g.action)).toEqual(["read", "write"]);
});

test("a 403 with the native error envelope surfaces as AccessForbiddenError with the hub's message", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          message: "Not a member of this tenant",
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
  await expect(
    grantAccess(testConfig(fetchImpl), {
      principalId: "prin_2",
      resource: "workflow-run:*",
      actions: ["read"],
    }),
  ).rejects.toThrow("Not a member of this tenant");
});

test("a 404 with the native error envelope from revokeAccess surfaces as AccessNotFoundError", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "Grant not found" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(
    revokeAccess(testConfig(fetchImpl), "grant_missing"),
  ).rejects.toThrow(AccessNotFoundError);
});

test("revokeAccess treats a native 204 with no body as success", async () => {
  const fetchImpl = (async () =>
    new Response(null, { status: 204 })) as unknown as typeof fetch;

  await revokeAccess(testConfig(fetchImpl), "grant_1");
});

test("a grant body without principalId is a shape error, never a null-linked grant", async () => {
  const { principalId: _link, ...linkless } = nativeGrant("grant_1");
  void _link;
  const fetchImpl = (async () =>
    Response.json({
      data: [linkless],
      nextCursor: null,
    })) as unknown as typeof fetch;

  await expect(listGrants(testConfig(fetchImpl), {})).rejects.toThrow(
    "did not match the expected shape",
  );
});
