import { describe, expect, test } from "bun:test";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { Hono } from "hono";

import {
  createArtifactRoutes,
  type ArtifactRoutesStore,
  type ArtifactListPage,
} from "./artifact-routes";
import type { SerializedArtifact } from "@corbits/artifacts";

function listItem(
  id: string,
  tenantId: string,
): ArtifactListPage["data"][number] {
  return {
    id,
    kind: "document",
    title: `Title ${id}`,
    source: { origin: "manual" },
    version: 1,
    ownerPrincipalId: null,
    ownerName: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

function detail(id: string, tenantId: string): SerializedArtifact {
  return {
    ...listItem(id, tenantId),
    content: `body of ${id}`,
  };
}

function memoryStore(seed: {
  listByTenant: Record<string, ArtifactListPage["data"]>;
  details: Record<string, { tenantId: string; row: SerializedArtifact }>;
}): ArtifactRoutesStore {
  return {
    async list(tenantId, _opts) {
      const data = seed.listByTenant[tenantId] ?? [];
      return { data, nextCursor: null };
    },
    async get(tenantId, artifactId) {
      const hit = seed.details[artifactId];
      if (hit === undefined || hit.tenantId !== tenantId) return null;
      return hit.row;
    },
  };
}

/** Pass-through grant middleware for route unit tests (authz is hub-owned). */
const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

function appWith(
  store: ArtifactRoutesStore,
  tenantId: string,
): Hono<TenantEnv> {
  const routes = createArtifactRoutes({ store, requireGrant: allowAll });
  const outer = new Hono<TenantEnv>();
  outer.use("*", async (c, next) => {
    c.set("tenant", { id: tenantId } as TenantEnv["Variables"]["tenant"]);
    c.set("principal", {
      id: "principal_test",
    } as TenantEnv["Variables"]["principal"]);
    await next();
  });
  outer.route("/api/tenants/:tenantId/artifacts", routes);
  return outer;
}

describe("createArtifactRoutes", () => {
  test("lists artifacts for the tenant (happy path)", async () => {
    const store = memoryStore({
      listByTenant: {
        tenant_a: [
          listItem("art_1", "tenant_a"),
          listItem("art_2", "tenant_a"),
        ],
      },
      details: {},
    });
    const app = appWith(store, "tenant_a");
    const res = await app.request("/api/tenants/tenant_a/artifacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArtifactListPage;
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.id).toBe("art_1");
    expect(body.nextCursor).toBeNull();
  });

  test("empty list returns data: []", async () => {
    const store = memoryStore({ listByTenant: {}, details: {} });
    const app = appWith(store, "tenant_empty");
    const res = await app.request("/api/tenants/tenant_empty/artifacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ArtifactListPage;
    expect(body.data).toEqual([]);
  });

  test("get returns the artifact body for the owning tenant", async () => {
    const row = detail("art_9", "tenant_a");
    const store = memoryStore({
      listByTenant: {},
      details: { art_9: { tenantId: "tenant_a", row } },
    });
    const app = appWith(store, "tenant_a");
    const res = await app.request("/api/tenants/tenant_a/artifacts/art_9");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SerializedArtifact;
    expect(body.id).toBe("art_9");
    expect(body.content).toBe("body of art_9");
  });

  test("get returns 404 for a missing id", async () => {
    const store = memoryStore({ listByTenant: {}, details: {} });
    const app = appWith(store, "tenant_a");
    const res = await app.request("/api/tenants/tenant_a/artifacts/missing");
    expect(res.status).toBe(404);
  });

  test("get returns 404 when the artifact belongs to another tenant", async () => {
    const row = detail("art_x", "tenant_b");
    const store = memoryStore({
      listByTenant: {},
      details: { art_x: { tenantId: "tenant_b", row } },
    });
    // Request as tenant_a — store enforces tenant match.
    const app = appWith(store, "tenant_a");
    const res = await app.request("/api/tenants/tenant_a/artifacts/art_x");
    expect(res.status).toBe(404);
  });
});
