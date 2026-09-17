import { expect, test } from "bun:test";

import {
  AccessForbiddenError,
  AccessNotFoundError,
  DelegationCeilingError,
  grantAccess,
  listGrants,
  listPrincipals,
  revokeAccess,
  type AccessToolClientConfig,
} from "./client";

const TENANT_BASE = "https://hub.example.com/api/tenants/ten_1";

function testConfig(fetchImpl: typeof fetch): AccessToolClientConfig {
  return {
    hubAccessUrl: "https://hub.example.com",
    tenantId: "ten_1",
    principalId: "prin_caller",
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

function nativeGrant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    principalId: "prin_2",
    resource: "workflow-run:*",
    action: "read",
    effect: "allow",
    origin: "invoker",
    conditions: null,
    expiresAt: null,
    roleId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The caller's own ceiling: whatever `firstActionOutsideCeiling` reads back
 * for `principalId=prin_caller`. */
function ceilingPage(grants: readonly unknown[]) {
  return Response.json({ data: grants, nextCursor: null });
}

test("listPrincipals reads the stock page envelope and follows nextCursor", async () => {
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
  expect(seen[0]).toStartWith(`${TENANT_BASE}/principals?`);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain("cursor=prin_2");
});

test("listGrants passes filters through and reads the stock page envelope", async () => {
  let seenUrl = "";
  const fetchImpl = (async (url: string | URL | Request) => {
    seenUrl = String(url);
    return Response.json({ data: [nativeGrant("grant_1")], nextCursor: null });
  }) as unknown as typeof fetch;

  const grants = await listGrants(testConfig(fetchImpl), {
    principalId: "prin_2",
    resource: "workflow-run:*",
  });
  expect(seenUrl).toContain(`${TENANT_BASE}/grants?`);
  expect(seenUrl).toContain("principalId=prin_2");
  expect(seenUrl).toContain("resource=workflow-run%3A*");
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    id: "grant_1",
    principalId: "prin_2",
    resource: "workflow-run:*",
    action: "read",
    effect: "allow",
  });
});

test("listGrants follows nextCursor so a full page plus one all return", async () => {
  const all = Array.from({ length: 51 }, (_, i) => nativeGrant(`grant_${i + 1}`));
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const raw = String(url);
    seen.push(raw);
    if (raw.includes("cursor=page_2")) {
      return Response.json({ data: all.slice(50), nextCursor: null });
    }
    return Response.json({ data: all.slice(0, 50), nextCursor: "page_2" });
  }) as unknown as typeof fetch;

  const grants = await listGrants(testConfig(fetchImpl), {
    principalId: "prin_2",
  });
  expect(grants).toHaveLength(51);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain("cursor=page_2");
});

test("grantAccess reads the caller's own grants first, then posts one stock single-action body per action", async () => {
  const posted: unknown[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") {
      expect(String(url)).toContain("principalId=prin_caller");
      return ceilingPage([nativeGrant("own_1", { principalId: "prin_caller", action: "*" })]);
    }
    expect(String(url)).toBe(`${TENANT_BASE}/grants`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
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

test("grantAccess refuses a pair outside the caller's own authority, before any write", async () => {
  const methods: (string | undefined)[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method);
    return ceilingPage([nativeGrant("own_1", { principalId: "prin_caller", action: "read" })]);
  }) as unknown as typeof fetch;

  await expect(
    grantAccess(testConfig(fetchImpl), {
      principalId: "prin_2",
      resource: "workflow-run:*",
      actions: ["read", "write"],
    }),
  ).rejects.toThrow(DelegationCeilingError);
  expect(methods).toEqual([undefined]);
});

test("a 403 from the stock route surfaces as AccessForbiddenError with the hub's message", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "forbidden", message: "Not a member of this tenant" },
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

test("a 404 looking up the grant to revoke surfaces as AccessNotFoundError", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "no such grant" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  await expect(revokeAccess(testConfig(fetchImpl), "grant_missing")).rejects.toThrow(
    AccessNotFoundError,
  );
});

test("revokeAccess checks the ceiling against the grant it read back, then deletes", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (String(url).includes("principalId=prin_caller")) {
      return ceilingPage([nativeGrant("own_1", { principalId: "prin_caller", action: "*" })]);
    }
    return Response.json(nativeGrant("grant_1"));
  }) as unknown as typeof fetch;

  await revokeAccess(testConfig(fetchImpl), "grant_1");
  expect(calls[0]).toBe(`GET ${TENANT_BASE}/grants/grant_1`);
  expect(calls.at(-1)).toBe(`DELETE ${TENANT_BASE}/grants/grant_1`);
});

test("revokeAccess refuses a grant outside the caller's own authority", async () => {
  const methods: (string | undefined)[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method);
    if (String(url).includes("principalId=prin_caller")) {
      return ceilingPage([]);
    }
    return Response.json(nativeGrant("grant_1"));
  }) as unknown as typeof fetch;

  await expect(revokeAccess(testConfig(fetchImpl), "grant_1")).rejects.toThrow(
    DelegationCeilingError,
  );
  expect(methods).not.toContain("DELETE");
});

test("a grant body missing principalId is a shape error, never a null-linked grant", async () => {
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
