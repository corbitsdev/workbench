import { expect, test } from "bun:test";

import type { ConditionRegistry, GrantStore } from "@intx/types/authz";

import {
  createWorkflowCatalogAdminRoutes,
  type WorkflowRunAuthenticator,
} from "./routes";

const ACTIVE_TENANT = {
  id: "tenant_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example.com",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ACTIVE_PRINCIPAL = {
  id: "prin_1",
  tenantId: "tenant_1",
  kind: "workflow" as const,
  refId: "run_1",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fakeDb(overrides?: {
  tenant?: typeof ACTIVE_TENANT | undefined;
  principal?:
    (Omit<typeof ACTIVE_PRINCIPAL, "status"> & { status: string }) | undefined;
}) {
  return {
    query: {
      tenant: {
        findFirst: async () =>
          overrides && "tenant" in overrides ? overrides.tenant : ACTIVE_TENANT,
      },
      principal: {
        findFirst: async () =>
          overrides && "principal" in overrides
            ? overrides.principal
            : ACTIVE_PRINCIPAL,
      },
      model: { findMany: async () => [] },
    },
  } as unknown as import("@intx/db").DB["db"];
}

function allowAllGrantStore(): GrantStore {
  return {
    collectGrants: async () => [
      {
        id: "grant_1",
        resource: "model:*",
        action: "read",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: null,
      },
    ],
    collectGrantsInChain: async () => [],
  };
}

function denyAllGrantStore(): GrantStore {
  return {
    collectGrants: async () => [],
    collectGrantsInChain: async () => [],
  };
}

function resolvingAuthenticator(): WorkflowRunAuthenticator {
  return {
    resolve: async (token, address) =>
      token === "sc-token" && address === "run_1@workflow"
        ? { tenantId: "tenant_1", principalId: "prin_1" }
        : null,
  };
}

function requestModels(
  app: ReturnType<typeof createWorkflowCatalogAdminRoutes>,
) {
  return app.request("/models", {
    headers: {
      authorization: "Bearer sc-token",
      "x-workflow-run-address": "run_1@workflow",
    },
  });
}

test("rejects a request with no sidecar bearer token", async () => {
  const app = createWorkflowCatalogAdminRoutes({
    db: fakeDb(),
    authenticator: resolvingAuthenticator(),
    grantStore: allowAllGrantStore(),
    conditionRegistry: {} as ConditionRegistry,
    sidecarRouter: {} as never,
    credentialCipher: {} as never,
  });
  const response = await app.request("/models");
  expect(response.status).toBe(401);
});

test("rejects a request whose run address the authenticator does not resolve", async () => {
  const app = createWorkflowCatalogAdminRoutes({
    db: fakeDb(),
    authenticator: { resolve: async () => null },
    grantStore: allowAllGrantStore(),
    conditionRegistry: {} as ConditionRegistry,
    sidecarRouter: {} as never,
    credentialCipher: {} as never,
  });
  const response = await requestModels(app);
  expect(response.status).toBe(401);
});

test("rejects a resolved run whose principal row is not active", async () => {
  const app = createWorkflowCatalogAdminRoutes({
    db: fakeDb({ principal: { ...ACTIVE_PRINCIPAL, status: "suspended" } }),
    authenticator: resolvingAuthenticator(),
    grantStore: allowAllGrantStore(),
    conditionRegistry: {} as ConditionRegistry,
    sidecarRouter: {} as never,
    credentialCipher: {} as never,
  });
  const response = await requestModels(app);
  expect(response.status).toBe(401);
});

test("an authenticated principal with no model:read grant gets a real 403, not a bundle-local approximation", async () => {
  const app = createWorkflowCatalogAdminRoutes({
    db: fakeDb(),
    authenticator: resolvingAuthenticator(),
    grantStore: denyAllGrantStore(),
    conditionRegistry: {} as ConditionRegistry,
    sidecarRouter: {} as never,
    credentialCipher: {} as never,
  });
  const response = await requestModels(app);
  expect(response.status).toBe(403);
});

test("an authenticated, granted principal lists this tenant's own models", async () => {
  const app = createWorkflowCatalogAdminRoutes({
    db: fakeDb(),
    authenticator: resolvingAuthenticator(),
    grantStore: allowAllGrantStore(),
    conditionRegistry: {} as ConditionRegistry,
    sidecarRouter: {} as never,
    credentialCipher: {} as never,
  });
  const response = await requestModels(app);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown[]; nextCursor: null };
  expect(body).toEqual({ data: [], nextCursor: null });
});
