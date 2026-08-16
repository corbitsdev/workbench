// The bench API client, tested at our wiring the same way
// packages/chat-ui/test/api.test.ts tests its client: stub global fetch,
// call the exported function, assert both the request it made and how it
// parses the response.

import { afterEach, describe, expect, test } from "bun:test";

import { UnauthenticatedError } from "@corbits/api-query";
import {
  BenchApiError,
  createBench,
  inviteMember,
  listChannelTenantIds,
  listMembers,
  listMyMemberships,
} from "../src/api";

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
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("listMyMemberships", () => {
  test("fetches the caller's principals and unwraps the paginated envelope", async () => {
    const calls = stubFetch(() =>
      json({
        data: [
          {
            principalId: "prn_1",
            tenantId: "tnt_1",
            tenantName: "Acme",
            tenantSlug: "acme",
            kind: "user",
            status: "active",
            roles: [{ id: "role_1", name: "owner" }],
          },
        ],
        nextCursor: null,
      }),
    );
    const memberships = await listMyMemberships();
    expect(calls[0]?.path).toBe("/api/me/principals");
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenantName).toBe("Acme");
  });

  test("throws a BenchApiError on a malformed response", async () => {
    stubFetch(() => json({ data: [{ tenantId: "tnt_1" }], nextCursor: null }));
    await expect(listMyMemberships()).rejects.toBeInstanceOf(BenchApiError);
  });

  test("throws an UnauthenticatedError on 401", async () => {
    stubFetch(() => json(null, 401));
    await expect(listMyMemberships()).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe("createBench", () => {
  test("posts the name and derived slug and returns the created bench", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "tnt_2",
          name: "Launch team",
          slug: "launch-team",
          domain: "launch-team.localhost",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        201,
      ),
    );
    const bench = await createBench({
      name: "Launch team",
      slug: "launch-team",
    });
    expect(calls[0]?.path).toBe("/api/tenants");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Launch team",
      slug: "launch-team",
    });
    expect(bench.slug).toBe("launch-team");
  });

  test("throws a BenchApiError with status 409 on a slug conflict", async () => {
    stubFetch(() => json({ error: { code: "conflict" } }, 409));
    await expect(
      createBench({ name: "Acme", slug: "acme" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("listMembers", () => {
  test("fetches the tenant's principals and unwraps the paginated envelope", async () => {
    const calls = stubFetch(() =>
      json({
        data: [
          {
            id: "prn_1",
            tenantId: "tnt_1",
            kind: "user",
            refId: "user_1",
            displayName: "Ada Lovelace",
            email: "ada@example.com",
            status: "active",
            roles: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
    const members = await listMembers("tnt_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/principals");
    expect(members).toHaveLength(1);
    expect(members[0]?.displayName).toBe("Ada Lovelace");
  });
});

describe("inviteMember", () => {
  test("posts the email and returns the invited principal", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "prn_2",
          tenantId: "tnt_1",
          kind: "user",
          refId: "user_2",
          displayName: "Grace Hopper",
          email: "grace@example.com",
          status: "invited",
          roles: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        201,
      ),
    );
    const invited = await inviteMember("tnt_1", "grace@example.com");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/members/invite");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "grace@example.com",
    });
    expect(invited.status).toBe("invited");
  });

  test("throws a BenchApiError with status 404 when no account matches the email", async () => {
    stubFetch(() => json({ error: { code: "not_found" } }, 404));
    await expect(
      inviteMember("tnt_1", "nobody@example.com"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("listChannelTenantIds", () => {
  test("posts the tenant ids and returns them as a set", async () => {
    const calls = stubFetch(() => json({ channelTenantIds: ["tnt_2"] }));
    const result = await listChannelTenantIds(["tnt_1", "tnt_2"]);
    expect(calls[0]?.path).toBe("/api/channel-tenancies/kinds");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      tenantIds: ["tnt_1", "tnt_2"],
    });
    expect(result).toEqual(new Set(["tnt_2"]));
  });

  test("never round-trips for an empty request", async () => {
    const calls = stubFetch(() => json({ channelTenantIds: [] }));
    const result = await listChannelTenantIds([]);
    expect(calls).toHaveLength(0);
    expect(result).toEqual(new Set());
  });
});
