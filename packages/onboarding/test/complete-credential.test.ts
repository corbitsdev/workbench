import { describe, expect, test } from "bun:test";
import type { ApiCall, WorkflowPusher } from "@workbench/hub-client";
import { completeCredentialSetup } from "../src/complete-credential";

const TENANT_ID = "ten_personal";
const PRINCIPAL_ID = "prn_personal";
const TENANT_SLUG = "alice-user1";

const noopPush: WorkflowPusher = async () => "pushed";

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function principalsResponse() {
  return {
    status: 200,
    data: {
      data: [
        {
          principalId: PRINCIPAL_ID,
          tenantId: TENANT_ID,
          tenantName: "Alice's workbench",
          tenantSlug: TENANT_SLUG,
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    },
    cookies: [],
  };
}

function tenantResponse() {
  return {
    status: 200,
    data: {
      id: TENANT_ID,
      name: "Alice's workbench",
      slug: TENANT_SLUG,
      domain: "alice-user1.bench.local",
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    cookies: [],
  };
}

describe("completeCredentialSetup", () => {
  test("an invalid key never touches the tenant", async () => {
    let apiCalls = 0;
    const api: ApiCall = async () => {
      apiCalls += 1;
      throw new Error("unexpected call with an invalid credential");
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      apiKey: "sk-ant-bad",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({
        ok: false,
        message: "invalid x-api-key",
      }),
      seedCatalogFn: async () => {
        throw new Error("seedCatalog must not run for an invalid credential");
      },
      seedTenantFn: async () => {
        throw new Error("seedTenant must not run for an invalid credential");
      },
    });

    expect(result).toEqual({
      kind: "invalid-credential",
      message: "invalid x-api-key",
    });
    expect(apiCalls).toBe(0);
  });

  test("a valid key with no personal bench yet is reported, not guessed at", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
    });

    expect(result).toEqual({ kind: "no-personal-bench" });
  });

  test("a valid key seeds the caller's own personal bench and reports what ran", async () => {
    const seedCatalogCalls: unknown[] = [];
    const seedTenantCalls: unknown[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["echo", "assistant"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalls).toHaveLength(1);
  });
});
