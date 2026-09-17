// The post-credential Myra driver: after the credential step seeds the
// catalog, the client itself brings Myra up on the tenant over stock
// routes — no hub-side kick, no new routes.

import { afterEach, describe, expect, test } from "bun:test";

import {
  driveMyraDeployAfterCredential,
  ensureMyraDeployed,
  resolveTenantIdForSlug,
} from "./myra-deploy";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(respond: (path: string, init?: RequestInit) => Response) {
  const calls: { path: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path, init));
  }) as typeof fetch;
  return calls;
}

const assistantAsset = [{ id: "ast_1", name: "assistant" }];

describe("ensureMyraDeployed", () => {
  test("an empty catalog is pending, not an error and not a deploy", async () => {
    const calls = stubFetch((path) => {
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json([]);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const outcome = await ensureMyraDeployed("tnt_1");
    expect(outcome).toEqual({
      kind: "pending",
      reason: "the tenant catalog has no assistant asset yet",
    });
    expect(
      calls.some((call) => call.path.endsWith("/workflows/deployments")),
    ).toBe(false);
  });

  test("a seeded catalog with no deployment posts the resolved body", async () => {
    const calls = stubFetch((path, init) => {
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json(assistantAsset);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        (init?.method ?? "GET") === "GET"
      ) {
        return json([]);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        init?.method === "POST"
      ) {
        return json({ id: "run_1" }, 201);
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`);
    });
    const outcome = await ensureMyraDeployed("tnt_1");
    expect(outcome).toEqual({ kind: "deployed" });
    const post = calls.find(
      (call) =>
        call.path === "/api/tenants/tnt_1/workflows/deployments" &&
        call.init?.method === "POST",
    );
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      definitionAssetId: "ast_1",
      confirmDeployments: false,
    });
  });

  test("an existing live deployment is left alone", async () => {
    const calls = stubFetch((path, init) => {
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json(assistantAsset);
      }
      if (path === "/api/tenants/tnt_1/workflows/deployments") {
        return json([
          {
            id: "run_1",
            tenantId: "tnt_1",
            definitionAssetId: "ast_1",
            status: "deployed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]);
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`);
    });
    const outcome = await ensureMyraDeployed("tnt_1");
    expect(outcome).toEqual({ kind: "already-running" });
    expect(
      calls.some(
        (call) =>
          call.path === "/api/tenants/tnt_1/workflows/deployments" &&
          call.init?.method === "POST",
      ),
    ).toBe(false);
  });

  test("a released or failed deployment is replaced, not mistaken for live", async () => {
    const calls = stubFetch((path, init) => {
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json(assistantAsset);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        (init?.method ?? "GET") === "GET"
      ) {
        return json([
          {
            id: "run_old",
            tenantId: "tnt_1",
            definitionAssetId: "ast_1",
            status: "failed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        init?.method === "POST"
      ) {
        return json({ id: "run_new" }, 201);
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`);
    });
    const outcome = await ensureMyraDeployed("tnt_1");
    expect(outcome).toEqual({ kind: "deployed" });
    expect(
      calls.some(
        (call) =>
          call.path === "/api/tenants/tnt_1/workflows/deployments" &&
          call.init?.method === "POST",
      ),
    ).toBe(true);
  });

  test("a deployments-list failure surfaces instead of deploying blind", async () => {
    stubFetch((path) => {
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json(assistantAsset);
      }
      if (path === "/api/tenants/tnt_1/workflows/deployments") {
        return json({ error: "boom" }, 500);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    await expect(ensureMyraDeployed("tnt_1")).rejects.toThrow(
      /deployments.*500|500.*deployments/,
    );
  });
});

describe("resolveTenantIdForSlug", () => {
  test("finds the tenant id across membership pages", async () => {
    stubFetch((path) => {
      if (path === "/api/me/principals") {
        return json({
          data: [
            {
              principalId: "prn_1",
              tenantId: "tnt_1",
              tenantName: "Ada",
              tenantSlug: "ada",
              kind: "user",
              status: "active",
              roles: [],
            },
          ],
          nextCursor: "cursor_2",
        });
      }
      if (path === "/api/me/principals?cursor=cursor_2") {
        return json({
          data: [
            {
              principalId: "prn_2",
              tenantId: "tnt_2",
              tenantName: "Atlas",
              tenantSlug: "ada-atlas",
              kind: "user",
              status: "active",
              roles: [],
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    await expect(resolveTenantIdForSlug("ada-atlas")).resolves.toBe("tnt_2");
    await expect(resolveTenantIdForSlug("missing")).resolves.toBe(null);
  });
});

describe("driveMyraDeployAfterCredential", () => {
  test("uses the outcome tenant id directly when present", async () => {
    const calls = stubFetch((path, init) => {
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json(assistantAsset);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        (init?.method ?? "GET") === "GET"
      ) {
        return json([]);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        init?.method === "POST"
      ) {
        return json({ id: "run_1" }, 201);
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`);
    });
    const outcome = await driveMyraDeployAfterCredential({
      tenantId: "tnt_1",
      tenantSlug: "ada",
    });
    expect(outcome).toEqual({ kind: "deployed" });
    expect(calls.some((call) => call.path === "/api/me/principals")).toBe(
      false,
    );
  });

  test("an older response without a tenant id resolves it from the slug", async () => {
    const calls = stubFetch((path, init) => {
      if (path === "/api/me/principals") {
        return json({
          data: [
            {
              principalId: "prn_1",
              tenantId: "tnt_1",
              tenantName: "Ada",
              tenantSlug: "ada",
              kind: "user",
              status: "active",
              roles: [],
            },
          ],
          nextCursor: null,
        });
      }
      if (path === "/api/tenants/tnt_1/assets?kind=workflow&inherited=true") {
        return json(assistantAsset);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        (init?.method ?? "GET") === "GET"
      ) {
        return json([]);
      }
      if (
        path === "/api/tenants/tnt_1/workflows/deployments" &&
        init?.method === "POST"
      ) {
        return json({ id: "run_1" }, 201);
      }
      throw new Error(`unexpected fetch: ${path} ${init?.method}`);
    });
    const outcome = await driveMyraDeployAfterCredential({
      tenantSlug: "ada",
    });
    expect(outcome).toEqual({ kind: "deployed" });
    expect(calls.some((call) => call.path === "/api/me/principals")).toBe(true);
  });

  test("an unresolvable slug is pending, not a crash", async () => {
    stubFetch((path) => {
      if (path === "/api/me/principals") {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    const outcome = await driveMyraDeployAfterCredential({
      tenantSlug: "gone",
    });
    expect(outcome).toEqual({
      kind: "pending",
      reason: "no membership on tenant slug gone",
    });
  });
});
