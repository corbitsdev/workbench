// Two-tenant isolation suite. Boots the real hub against a real
// Postgres, provisions two tenants through the native routes — one
// user in each — and proves by direct request that neither tenant's
// principal can read or act on the other's surfaces. Cross-tenant
// requests must yield the platform's forbidden/not-found envelopes and
// never data; the member controls prove those refusals are the tenant
// gate working rather than dead routes.
//
// To extend coverage to a new extension, see the registry note in
// surfaces.ts and the echo describe block below.

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
  // this block asserts the behavior only that extension has.
  describe("echo extension", () => {
    test("echoes for a member of the tenant it is mounted under", async () => {
      const response = await app.request(
        `/api/tenants/${tenantA.tenantId}/echo`,
        {
          method: "POST",
          headers: { cookie: tenantA.cookie, "content-type": "text/plain" },
          body: "hello from tenant a",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello from tenant a");
    });

    test("refuses a foreign principal before the handler runs", async () => {
      const response = await app.request(
        `/api/tenants/${tenantB.tenantId}/echo`,
        {
          method: "POST",
          headers: { cookie: tenantA.cookie, "content-type": "text/plain" },
          body: "should never be echoed",
        },
      );
      await expectRefusal(response, 403, "forbidden", tenantB.markers);
      // The refusal must come from the platform's tenant gate, not the
      // extension: the body is the error envelope, never the echo.
    });
  });
}
