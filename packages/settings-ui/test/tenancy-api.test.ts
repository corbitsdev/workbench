// The tenancy API client, tested the same way `settings-ui/test/api.test.ts`
// tests the account/bench client: stub global fetch, call the exported
// function, assert both the request it made and how it parses the response.

import { afterEach, describe, expect, test } from "bun:test";

import {
  TenancyApiError,
  assignRole,
  createGrant,
  createRole,
  evaluate,
  invitePrincipal,
  listGrants,
  listPrincipals,
  listRoles,
  removePrincipal,
  revokeGrant,
  unassignRole,
  updatePrincipalStatus,
} from "../src/tenancy-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("listPrincipals", () => {
  test("fetches the tenant's principals page", async () => {
    const calls = stubFetch(() =>
      json({
        data: [
          {
            id: "prn_1",
            tenantId: "tnt_1",
            kind: "user",
            refId: "user_1",
            displayName: "Ada Lovelace",
            status: "active",
            roles: [],
            ...timestamps,
          },
        ],
        nextCursor: null,
      }),
    );
    const principals = await listPrincipals("tnt_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/principals");
    expect(principals).toHaveLength(1);
  });
});

describe("invitePrincipal", () => {
  test("POSTs the invite email", async () => {
    const calls = stubFetch(() =>
      json({
        id: "prn_2",
        tenantId: "tnt_1",
        kind: "user",
        refId: "user_2",
        displayName: "Grace Hopper",
        status: "invited",
        roles: [],
        ...timestamps,
      }),
    );
    await invitePrincipal("tnt_1", "grace@example.com");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/members/invite");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "grace@example.com",
    });
  });

  test("surfaces a 404 (no matching account) as a TenancyApiError", async () => {
    stubFetch(() => json({ error: { code: "not_found" } }, 404));
    await expect(
      invitePrincipal("tnt_1", "nobody@example.com"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      invitePrincipal("tnt_1", "nobody@example.com"),
    ).rejects.toBeInstanceOf(TenancyApiError);
  });
});

describe("updatePrincipalStatus and removePrincipal", () => {
  test("PATCHes status", async () => {
    const calls = stubFetch(() =>
      json({
        id: "prn_1",
        tenantId: "tnt_1",
        kind: "user",
        refId: "user_1",
        displayName: "Ada",
        status: "suspended",
        roles: [],
        ...timestamps,
      }),
    );
    await updatePrincipalStatus("tnt_1", "prn_1", "suspended");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      status: "suspended",
    });
  });

  test("DELETEs a principal", async () => {
    const calls = stubFetch(() => json(undefined, 204));
    await removePrincipal("tnt_1", "prn_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/principals/prn_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("roles", () => {
  test("createRole POSTs name and description", async () => {
    const calls = stubFetch(() =>
      json({
        id: "role_1",
        tenantId: "tnt_1",
        name: "Billing",
        isSystem: false,
        ...timestamps,
      }),
    );
    await createRole("tnt_1", { name: "Billing" });
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/roles");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Billing",
    });
  });

  test("assignRole and unassignRole hit the principal/role pairing route", async () => {
    const calls = stubFetch(() => json(undefined, 204));
    await assignRole("tnt_1", "prn_1", "role_1");
    await unassignRole("tnt_1", "prn_1", "role_1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/principals/prn_1/roles/role_1",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.method).toBe("DELETE");
  });

  test("listRoles fetches the tenant's roles page", async () => {
    const calls = stubFetch(() => json({ data: [], nextCursor: null }));
    await listRoles("tnt_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/roles");
  });
});

describe("grants", () => {
  test("listGrants encodes filters as a query string", async () => {
    const calls = stubFetch(() => json({ data: [], nextCursor: null }));
    await listGrants("tnt_1", { resource: "workflow", effect: "allow" });
    expect(calls[0]?.path).toContain("resource=workflow");
    expect(calls[0]?.path).toContain("effect=allow");
  });

  test("createGrant POSTs exactly the fields given", async () => {
    const calls = stubFetch(() =>
      json({
        id: "grant_1",
        tenantId: "tnt_1",
        roleId: "role_1",
        resource: "workflow",
        action: "read",
        effect: "allow",
        origin: "role",
        ...timestamps,
      }),
    );
    await createGrant("tnt_1", {
      roleId: "role_1",
      resource: "workflow",
      action: "read",
      effect: "allow",
      origin: "role",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      roleId: "role_1",
      resource: "workflow",
      action: "read",
      effect: "allow",
      origin: "role",
    });
  });

  test("revokeGrant DELETEs by id", async () => {
    const calls = stubFetch(() => json(undefined, 204));
    await revokeGrant("tnt_1", "grant_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/grants/grant_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("evaluate", () => {
  test("POSTs resource/action and returns the resolved effect", async () => {
    const calls = stubFetch(() =>
      json({ effect: "allow", matchingGrants: [] }),
    );
    const result = await evaluate("tnt_1", "prn_1", "principal", "read");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/principals/prn_1/evaluate");
    expect(result.effect).toBe("allow");
  });
});
