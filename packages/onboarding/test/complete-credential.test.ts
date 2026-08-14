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
      provider: "anthropic",
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
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
    });

    expect(result).toEqual({ kind: "no-personal-bench" });
  });

  test("a valid Anthropic key seeds the catalog, the tenant, and reports what ran", async () => {
    const seedCatalogCalls: unknown[] = [];
    const seedTenantCalls: { model: { provider: string; model: string } }[] =
      [];
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
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["echo", "assistant", "channel-digest"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("anthropic");
  });

  test("a valid OpenAI key seeds its own catalog and routines", async () => {
    const seedCatalogCalls: unknown[] = [];
    const seedTenantCalls: { model: { provider: string; model: string } }[] =
      [];
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
      provider: "openai",
      apiKey: "sk-good",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["echo", "assistant", "channel-digest"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("openai");
  });

  test("a valid Groq key seeds the shared OpenAI-compatible catalog and routines", async () => {
    const seedCatalogCalls: { provider?: string }[] = [];
    const seedTenantCalls: { model: { provider: string; model: string } }[] =
      [];
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
      provider: "groq",
      apiKey: "gsk-good",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args as never);
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["echo", "assistant", "channel-digest"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedCatalogCalls[0]?.provider).toBe("groq");
    expect(seedTenantCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("openai-compatible");
  });

  test("a Hugging Face connect token stores its expiry as oauth_token credential metadata", async () => {
    const seedCatalogCalls: {
      provider?: string;
      credentialType?: string;
      credentialMetadata?: Record<string, unknown>;
    }[] = [];
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
      provider: "huggingface",
      apiKey: "hf_oauth_minted",
      credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args as never);
      },
      seedTenantFn: async () => {},
    });

    expect(result.kind).toBe("seeded");
    expect(seedCatalogCalls).toEqual([
      expect.objectContaining({
        provider: "huggingface",
        credentialType: "oauth_token",
        credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      }),
    ]);
  });

  test("a reconnect against an expired Hugging Face credential rotates it and still reports seeded", async () => {
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    const staleCredentialRow = () => ({
      id: "cre_old",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "huggingface-default",
      type: "oauth_token",
      status: "expired",
      metadata: { expiresAt: "2026-01-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    let patchCalls = 0;
    let patchBody: unknown;

    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        return {
          status: 201,
          data: {
            id: "prv_1",
            tenantId: TENANT_ID,
            name: "huggingface",
            plugin: "openai-compatible",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        return { status: 409, data: { error: "name taken" }, cookies: [] };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        return {
          status: 200,
          data: { data: [staleCredentialRow()], nextCursor: null },
          cookies: [],
        };
      }
      if (
        method === "PATCH" &&
        path === `/api/tenants/${TENANT_ID}/credentials/cre_old`
      ) {
        patchCalls += 1;
        patchBody = body;
        return {
          status: 200,
          data: {
            ...staleCredentialRow(),
            status: "active",
            metadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return {
          status: 201,
          data: {
            id: "mdl_1",
            tenantId: TENANT_ID,
            canonicalName: "deepseek-ai/DeepSeek-V4-Flash",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return {
          status: 201,
          data: {
            id: "cpv_1",
            tenantId: TENANT_ID,
            name: "huggingface",
            plugin: "openai-compatible",
            baseURL: "https://router.huggingface.co/v1",
            credentialId: "cre_old",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        return {
          status: 201,
          data: {
            id: "off_1",
            tenantId: TENANT_ID,
            modelId: "mdl_1",
            providerId: "cpv_1",
            priority: 0,
            deploymentTags: [],
            capabilities: [],
            quirks: null,
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
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
      provider: "huggingface",
      apiKey: "hf_freshly_minted_token",
      credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      // The real seedCatalog runs here (not mocked) so the rotation
      // actually happens through ensureCredential; only the workflow
      // deploy side is stubbed, since it is not this defect's concern.
      seedTenantFn: async () => {},
    });

    expect(result.kind).toBe("seeded");
    expect(patchCalls).toBe(1);
    expect(patchBody).toEqual({
      secret: "hf_freshly_minted_token",
      status: "active",
      metadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
    });
  });

  test("a pasted key with no metadata stays an ordinary api_key credential", async () => {
    const seedCatalogCalls: { credentialType?: string }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "huggingface",
      apiKey: "hf_pasted_pat",
      pushWorkflow: noopPush,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args as never);
      },
      seedTenantFn: async () => {},
    });

    expect(seedCatalogCalls).toEqual([
      expect.objectContaining({ credentialType: "api_key" }),
    ]);
  });
});
