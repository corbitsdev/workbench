// Two-tenant isolation suite. Boots the real hub against a real
// Postgres, provisions two tenants through the native routes — one
// user in each — and proves by direct request that neither tenant's
// principal can read or act on the other's surfaces. Cross-tenant
// requests must yield the platform's forbidden/not-found envelopes and
// never data; the member controls prove those refusals are the tenant
// gate working rather than dead routes.
//
// To extend coverage to a new extension, see the registry note in
// surfaces.ts and the "chat workbench move" describe block below for
// the pattern of an extension-specific assertion.

import { afterAll, describe, expect, test } from "bun:test";
import {
  bootIsolationHub,
  prepareDatabase,
  provisionTenant,
  resolveDatabaseUrl,
  signUpUser,
  listItems,
  type AppLike,
  type ProvisionedTenant,
} from "./setup.ts";
import { tenantSurfaces, type TenantSurface } from "./surfaces.ts";

function surfaceInit(
  surface: TenantSurface,
  cookie?: string,
): RequestInit | undefined {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  if (surface.contentType) headers["content-type"] = surface.contentType;
  if (surface.method === "GET" && !cookie && !surface.contentType) {
    return undefined;
  }
  const init: RequestInit = { method: surface.method, headers };
  if (surface.body !== undefined) init.body = surface.body;
  return init;
}

/** Asserts a response is an error envelope carrying none of the markers. */
async function expectRefusal(
  response: Response,
  status: number,
  code: string,
  foreignMarkers: string[],
): Promise<void> {
  const text = await response.text();
  expect(response.status).toBe(status);
  const parsed = JSON.parse(text) as {
    error?: { code?: string; message?: string };
  };
  expect(parsed.error?.code).toBe(code);
  for (const marker of foreignMarkers) {
    expect(text).not.toContain(marker);
  }
}

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  // Without a database there is nothing meaningful to assert; skipping
  // loudly beats a vacuous pass. CI runs this suite with DATABASE_URL
  // set, where every test below executes.
  test.skip("two-tenant isolation (set DATABASE_URL or ISOLATION_DATABASE_URL to run)", () => {});
} else {
  await prepareDatabase(databaseUrl);
  const hub = await bootIsolationHub(databaseUrl);
  const app: AppLike = hub.app;
  afterAll(async () => {
    await hub.shutdown();
  });

  // Unique suffix so the suite can rerun against a database that
  // already holds rows from a previous run.
  const nonce = Date.now().toString(36);
  const cookieA = await signUpUser(
    app,
    `owner-a-${nonce}@isolation.test`,
    "Owner A",
  );
  const cookieB = await signUpUser(
    app,
    `owner-b-${nonce}@isolation.test`,
    "Owner B",
  );
  const tenantA: ProvisionedTenant = await provisionTenant(
    app,
    cookieA,
    "a",
    nonce,
  );
  const tenantB: ProvisionedTenant = await provisionTenant(
    app,
    cookieB,
    "b",
    nonce,
  );

  const pairs: [string, ProvisionedTenant, ProvisionedTenant][] = [
    ["A against B", tenantA, tenantB],
    ["B against A", tenantB, tenantA],
  ];

  describe("member controls", () => {
    for (const surface of tenantSurfaces) {
      test(`${surface.name}: a member's request reaches the handler`, async () => {
        for (const own of [tenantA, tenantB]) {
          const response = await app.request(
            surface.path(own.tenantId),
            surfaceInit(surface, own.cookie),
          );
          expect(response.status).toBe(surface.memberStatus);
        }
      });
    }

    test("each tenant's reads return its own rows", async () => {
      for (const [, own, other] of pairs) {
        const response = await app.request(
          `/api/tenants/${own.tenantId}/credentials`,
          { headers: { cookie: own.cookie } },
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(own.credentialId);
        const ids = listItems(JSON.parse(text)).map(
          (item) => (item as { id: string }).id,
        );
        expect(ids).not.toContain(other.credentialId);
        for (const marker of other.markers) {
          expect(text).not.toContain(marker);
        }
      }
    });
  });

  describe("cross-tenant requests are refused without data", () => {
    for (const surface of tenantSurfaces) {
      test(`${surface.name}: foreign principal is forbidden`, async () => {
        for (const [, actor, victim] of pairs) {
          const response = await app.request(
            surface.path(victim.tenantId),
            surfaceInit(surface, actor.cookie),
          );
          await expectRefusal(response, 403, "forbidden", victim.markers);
        }
      });
    }
  });

  describe("foreign resource ids under your own tenant path resolve as not found", () => {
    const detailReads: [
      string,
      (own: string, foreign: ProvisionedTenant) => string,
    ][] = [
      [
        "credential",
        (own, f) => `/api/tenants/${own}/credentials/${f.credentialId}`,
      ],
      [
        "principal",
        (own, f) => `/api/tenants/${own}/principals/${f.principalId}`,
      ],
      ["grant", (own, f) => `/api/tenants/${own}/grants/${f.grantId}`],
    ];
    for (const [name, buildPath] of detailReads) {
      test(`${name} detail read never crosses the boundary`, async () => {
        for (const [, actor, victim] of pairs) {
          const response = await app.request(
            buildPath(actor.tenantId, victim),
            { headers: { cookie: actor.cookie } },
          );
          await expectRefusal(response, 404, "not_found", victim.markers);
        }
      });
    }
  });

  describe("unauthenticated and unknown-tenant requests", () => {
    for (const surface of tenantSurfaces) {
      test(`${surface.name}: anonymous request is unauthorized`, async () => {
        const response = await app.request(
          surface.path(tenantA.tenantId),
          surfaceInit(surface),
        );
        await expectRefusal(response, 401, "unauthorized", tenantA.markers);
      });
    }

    test("a tenant id that does not exist is not found", async () => {
      const response = await app.request(
        "/api/tenants/tnt_does_not_exist/principals",
        { headers: { cookie: tenantA.cookie } },
      );
      await expectRefusal(response, 404, "not_found", tenantB.markers);
    });
  });

  // Extension-specific block — the pattern every future extension
  // copies: the generic sweep above already covers its surface entry;
  // a block like this asserts the behavior only that extension has (the
  // echo demo agent that used to live here was deleted in CL-7381).

  describe("chat workbench move", () => {
    /** The `tenancy` annotation `GET .../chat/workbenches` carries for one
     * workbench id, or `undefined` if the id is absent from the list —
     * the actual, current `workbench_tenancy` state, read fresh on every
     * call rather than trusted from an earlier response. */
    async function readWorkbenchTenancy(
      tenantId: string,
      cookie: string,
      workbenchId: string,
    ): Promise<{ tenantId: string; parentTenantId: string } | undefined> {
      const response = await app.request(
        `/api/tenants/${tenantId}/chat/workbenches`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: {
          id: string;
          tenancy: { tenantId: string; parentTenantId: string } | null;
        }[];
      };
      const item = body.items.find((entry) => entry.id === workbenchId);
      return item?.tenancy ?? undefined;
    }

    /** The native `tenant.parentId` for a tenant, read straight from
     * `GET /api/tenants/:id` rather than trusted from a prior write —
     * the same route `provisionTenant` itself calls to prove a create
     * landed. */
    async function readTenantParentId(
      tenantId: string,
      cookie: string,
    ): Promise<string | null> {
      const response = await app.request(`/api/tenants/${tenantId}`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { parentId: string | null };
      return body.parentId;
    }

    test("a member of A cannot move A's workbench under B without standing in B", async () => {
      const createResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches`,
        {
          method: "POST",
          headers: {
            cookie: tenantA.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ kind: "workbench", name: "Movable" }),
        },
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        id: string;
        tenancy: { tenantId: string };
      };

      // Tenant A's own member holds no principal at all in tenant B —
      // the destination-authorization check must refuse this before
      // either the workbench_tenancy link or tenant.parentId is touched,
      // even though the caller has full authority over the workbench in
      // its own bench.
      const moveResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches/${created.id}/move`,
        {
          method: "POST",
          headers: {
            cookie: tenantA.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ newParentTenantId: tenantB.tenantId }),
        },
      );
      await expectRefusal(moveResponse, 403, "forbidden", tenantB.markers);

      const settingsResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches/${created.id}/settings`,
        { headers: { cookie: tenantA.cookie } },
      );
      expect(settingsResponse.status).toBe(200);

      // A denied move must leave no trace in either place it would
      // have written: re-read both the chat-owned link and the native
      // tenant row, straight from the database, rather than trusting
      // the 403 response alone — a write-then-deny implementation
      // would still return 403 here but would fail these reads.
      const link = await readWorkbenchTenancy(
        tenantA.tenantId,
        tenantA.cookie,
        created.id,
      );
      expect(link?.parentTenantId).toBe(tenantA.tenantId);
      const parentId = await readTenantParentId(
        created.tenancy.tenantId,
        tenantA.cookie,
      );
      expect(parentId).toBe(tenantA.tenantId);
    });

    test("a member of A holding only a read-only principal in B still cannot move A's workbench into B", async () => {
      const createResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches`,
        {
          method: "POST",
          headers: {
            cookie: tenantA.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "workbench",
            name: "Movable Read Only",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        id: string;
        tenancy: { tenantId: string };
      };

      // Give tenant A's owner a real, active foothold in tenant B —
      // invited onto B's own "member" system role (read-only grants
      // only) and activated by B's owner, entirely through native
      // routes and the real database. This is the case a fake grant
      // store can't exercise: the caller is no longer a stranger to
      // the destination tenant, so the check must fall through to a
      // real `@intx/authz` evaluation of B's live grant rows and find
      // no manage grant among them, rather than short-circuiting on
      // "no principal at all" as the sibling test above does.
      const rolesResponse = await app.request(
        `/api/tenants/${tenantB.tenantId}/roles`,
        { headers: { cookie: tenantB.cookie } },
      );
      expect(rolesResponse.status).toBe(200);
      const roles = listItems(await rolesResponse.json()) as {
        id: string;
        name: string;
      }[];
      const memberRole = roles.find((role) => role.name === "member");
      if (!memberRole) {
        throw new Error("expected a system member role in tenant B");
      }

      const inviteResponse = await app.request(
        `/api/tenants/${tenantB.tenantId}/members/invite`,
        {
          method: "POST",
          headers: {
            cookie: tenantB.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: `owner-a-${nonce}@isolation.test`,
            roleId: memberRole.id,
          }),
        },
      );
      expect(inviteResponse.status).toBe(201);
      const invited = (await inviteResponse.json()) as { id: string };

      const activateResponse = await app.request(
        `/api/tenants/${tenantB.tenantId}/principals/${invited.id}`,
        {
          method: "PATCH",
          headers: {
            cookie: tenantB.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ status: "active" }),
        },
      );
      expect(activateResponse.status).toBe(200);

      const moveResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches/${created.id}/move`,
        {
          method: "POST",
          headers: {
            cookie: tenantA.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ newParentTenantId: tenantB.tenantId }),
        },
      );
      await expectRefusal(moveResponse, 403, "forbidden", tenantB.markers);

      const settingsResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches/${created.id}/settings`,
        { headers: { cookie: tenantA.cookie } },
      );
      expect(settingsResponse.status).toBe(200);

      // Same non-negotiable as the sibling test: a real, active
      // principal in the destination is still not a manage grant, and
      // the denial must leave the actual rows untouched.
      const link = await readWorkbenchTenancy(
        tenantA.tenantId,
        tenantA.cookie,
        created.id,
      );
      expect(link?.parentTenantId).toBe(tenantA.tenantId);
      const parentId = await readTenantParentId(
        created.tenancy.tenantId,
        tenantA.cookie,
      );
      expect(parentId).toBe(tenantA.tenantId);
    });

    test("a member of A who genuinely manages tenant C can move A's workbench there, and the write actually lands", async () => {
      const createResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches`,
        {
          method: "POST",
          headers: {
            cookie: tenantA.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ kind: "workbench", name: "Movable To Own" }),
        },
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        id: string;
        tenancy: { tenantId: string; parentTenantId: string };
      };
      expect(created.tenancy.parentTenantId).toBe(tenantA.tenantId);

      // A second, real tenant owned by the same user as tenant A — a
      // genuine manage grant in the destination, not a fake store's
      // `Set`. `createDrizzleWorkbenchTenancyStore` is the only
      // implementation that takes the `SELECT ... FOR UPDATE` locks
      // and calls the real `evaluateGrants`, so this is the only test
      // that instantiates it end to end.
      const tenantC: ProvisionedTenant = await provisionTenant(
        app,
        tenantA.cookie,
        "c",
        nonce,
      );

      const moveResponse = await app.request(
        `/api/tenants/${tenantA.tenantId}/chat/workbenches/${created.id}/move`,
        {
          method: "POST",
          headers: {
            cookie: tenantA.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ newParentTenantId: tenantC.tenantId }),
        },
      );
      expect(moveResponse.status).toBe(200);
      const moved = (await moveResponse.json()) as {
        tenancy: { tenantId: string; parentTenantId: string };
      };
      expect(moved.tenancy.parentTenantId).toBe(tenantC.tenantId);

      // The response body alone proves nothing about what actually
      // landed — re-read both places the move writes, fresh, to
      // confirm the transaction really committed both halves: the
      // chat-owned link row, and the native `tenant.parentId` column.
      const link = await readWorkbenchTenancy(
        tenantA.tenantId,
        tenantA.cookie,
        created.id,
      );
      expect(link?.parentTenantId).toBe(tenantC.tenantId);
      const parentId = await readTenantParentId(
        created.tenancy.tenantId,
        tenantA.cookie,
      );
      expect(parentId).toBe(tenantC.tenantId);
    });
  });
}
