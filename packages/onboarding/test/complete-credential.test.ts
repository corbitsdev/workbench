import { describe, expect, test } from "bun:test";
import type {
  ApiCall,
  ToolRegistryPublisher,
  WorkflowPusher,
} from "@workbench/hub-client";
import {
  completeCredentialSetup,
  ensureSeeded,
  testAndPersistCredential,
} from "../src/complete-credential";

// A key that clears the free probe never needs to prove itself again
// with a billed call: seedTenant must run with confirmDeployments:
// false so a valid, credit-less account is not turned into a false
// "setup failed" by a workflow trigger it never asked for.
function expectNoConfirmation(
  seedTenantCalls: { confirmDeployments?: boolean }[],
) {
  expect(seedTenantCalls).toHaveLength(1);
  expect(seedTenantCalls[0]?.confirmDeployments).toBe(false);
}

const TENANT_ID = "ten_personal";
const PRINCIPAL_ID = "prn_personal";
const TENANT_SLUG = "alice-user1";

const noopPush: WorkflowPusher = async () => "pushed";
const noopPublishToolRegistry: ToolRegistryPublisher = async () => undefined;

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
      publishToolRegistry: noopPublishToolRegistry,
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
      publishToolRegistry: noopPublishToolRegistry,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
    });

    expect(result).toEqual({ kind: "no-personal-bench" });
  });

  test("a valid Anthropic key seeds the catalog, the tenant, and reports what ran", async () => {
    const seedCatalogCalls: unknown[] = [];
    const seedTenantCalls: {
      model: { provider: string; model: string };
      confirmDeployments?: boolean;
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
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      publishToolRegistry: noopPublishToolRegistry,
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
      workflows: ["echo", "assistant", "channel-digest", "recurring-task"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("anthropic");
    expectNoConfirmation(seedTenantCalls);
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
      publishToolRegistry: noopPublishToolRegistry,
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
      workflows: ["echo", "assistant", "channel-digest", "recurring-task"],
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
      publishToolRegistry: noopPublishToolRegistry,
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
      workflows: ["echo", "assistant", "channel-digest", "recurring-task"],
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
      publishToolRegistry: noopPublishToolRegistry,
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
      publishToolRegistry: noopPublishToolRegistry,
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

  test("a valid key seeds every default workflow without any deploy-confirmation trigger call", async () => {
    // No `seedTenantFn` override here: the real `seedTenant` runs, so
    // this is the actual code path a connect callback drives end to
    // end (only `seedCatalogFn` is stubbed — the catalog side is
    // unrelated to this defect and already covered above). A fake
    // `api` that throws on any workflow run-listing or mail-trigger
    // call proves `completeCredentialSetup` never asks seedTenant to
    // confirm a deployment by triggering real inference — the fix for
    // the false "setup failed" a credit-less but valid key used to get.
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        return {
          status: 201,
          data: {
            id: `ast_${name}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/git-tokens`
      ) {
        return {
          status: 201,
          data: { id: "tok_1", secret: "s3cret" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        const assetId = (body as { assetId: string }).assetId;
        return {
          status: 201,
          data: {
            id: `dep_${assetId}`,
            tenantId: TENANT_ID,
            definitionAssetId: assetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.includes("/workflows/") &&
        path.endsWith("/runs")
      ) {
        throw new Error(
          `unexpected run-listing call for a probe-verified key: ${method} ${path}`,
        );
      }
      if (
        method === "POST" &&
        path.includes("/workflows/") &&
        path.endsWith("/mail")
      ) {
        throw new Error(
          `unexpected workflow trigger call for a probe-verified key: ${method} ${path}`,
        );
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
      publishToolRegistry: noopPublishToolRegistry,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async () => {},
    });

    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") {
      expect(result.workflows).toEqual([
        "echo",
        "assistant",
        "channel-digest",
        "recurring-task",
      ]);
    }
  });

  test("a second credential save for the same account is idempotent — no duplicate assets, deployments, grants, or catalog rows", async () => {
    // Two credential saves racing (or a person resubmitting the same
    // provider) must not double-seed: seedCatalog and seedTenant's
    // ensure-then-create helpers already tolerate a 409 on the second
    // create by listing the existing row instead, and this proves that
    // tolerance holds end to end through `completeCredentialSetup`,
    // called twice, with the real (non-mocked) seedCatalog and
    // seedTenant driving a stateful fake hub.
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    type Row = { name: string; id: string };
    const grants: { resource: string; action: string }[] = [];
    const assets: Row[] = [];
    const deployments: { definitionAssetId: string; id: string }[] = [];
    const catalogModels: Row[] = [];
    const catalogProviders: Row[] = [];
    const catalogOfferings: { modelId: string; providerId: string }[] = [];
    const providers: Row[] = [];
    const credentials: Row[] = [];
    let assetCreatePosts = 0;
    let deploymentCreatePosts = 0;
    let catalogModelCreatePosts = 0;
    let catalogProviderCreatePosts = 0;
    let catalogOfferingCreatePosts = 0;
    let credentialCreatePosts = 0;

    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: {
            data: grants.map((g, index) => ({
              id: `grt_${index}`,
              tenantId: TENANT_ID,
              resource: g.resource,
              action: g.action,
              effect: "allow",
              principalId: PRINCIPAL_ID,
              origin: "creator",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const g = body as { resource: string; action: string };
        grants.push({ resource: g.resource, action: g.action });
        return { status: 201, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        const existing = assets.find((a) => a.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        assetCreatePosts += 1;
        const id = `ast_${name}`;
        assets.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: assets.map((a) => ({
            id: a.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: a.name,
            displayName: a.name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/git-tokens`
      ) {
        return {
          status: 201,
          data: { id: "tok_1", secret: "s3cret" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: deployments.map((d) => ({
            id: d.id,
            tenantId: TENANT_ID,
            definitionAssetId: d.definitionAssetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deploymentCreatePosts += 1;
        const assetId = (body as { assetId: string }).assetId;
        const id = `dep_${assetId}`;
        deployments.push({ definitionAssetId: assetId, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            definitionAssetId: assetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        const name = (body as { name: string }).name;
        const existing = providers.find((p) => p.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        const id = `prv_${name}`;
        providers.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            name,
            plugin: "anthropic",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return {
          status: 200,
          data: {
            data: providers.map((p) => ({
              id: p.id,
              tenantId: TENANT_ID,
              name: p.name,
              plugin: "anthropic",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        const name = (body as { name: string }).name;
        const existing = credentials.find((c) => c.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        credentialCreatePosts += 1;
        const id = `cre_${name}`;
        credentials.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            providerId: "prv_anthropic",
            name,
            type: "api_key",
            status: "active",
            metadata: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        return {
          status: 200,
          data: {
            data: credentials.map((c) => ({
              id: c.id,
              tenantId: TENANT_ID,
              providerId: "prv_anthropic",
              name: c.name,
              type: "api_key",
              status: "active",
              metadata: null,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        const existing = catalogModels.find((m) => m.name === canonicalName);
        if (existing) return { status: 409, data: {}, cookies: [] };
        catalogModelCreatePosts += 1;
        const id = `mdl_${canonicalName}`;
        catalogModels.push({ name: canonicalName, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            canonicalName,
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return {
          status: 200,
          data: {
            data: catalogModels.map((m) => ({
              id: m.id,
              tenantId: TENANT_ID,
              canonicalName: m.name,
              disabled: false,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        const name = (body as { name: string }).name;
        const existing = catalogProviders.find((p) => p.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        catalogProviderCreatePosts += 1;
        const id = `cpv_${name}`;
        catalogProviders.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            name,
            plugin: "anthropic",
            baseURL: "https://api.anthropic.com",
            credentialId: "cre_anthropic-default",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return {
          status: 200,
          data: {
            data: catalogProviders.map((p) => ({
              id: p.id,
              tenantId: TENANT_ID,
              name: p.name,
              plugin: "anthropic",
              baseURL: "https://api.anthropic.com",
              credentialId: "cre_anthropic-default",
              disabled: false,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const b = body as { modelId: string; providerId: string };
        const existing = catalogOfferings.find(
          (o) => o.modelId === b.modelId && o.providerId === b.providerId,
        );
        if (existing) return { status: 409, data: {}, cookies: [] };
        catalogOfferingCreatePosts += 1;
        catalogOfferings.push({ modelId: b.modelId, providerId: b.providerId });
        return {
          status: 201,
          data: {
            id: `off_${catalogOfferings.length}`,
            tenantId: TENANT_ID,
            modelId: b.modelId,
            providerId: b.providerId,
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

    const submitCredential = () =>
      completeCredentialSetup({
        api,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        userId: "user_1",
        userEmail: "alice@example.com",
        provider: "anthropic",
        apiKey: "sk-ant-good",
        pushWorkflow: noopPush,
        publishToolRegistry: noopPublishToolRegistry,
        log: collector().log,
        testCredential: async () => ({ ok: true }),
      });

    const first = await submitCredential();
    expect(first.kind).toBe("seeded");
    const second = await submitCredential();
    expect(second.kind).toBe("seeded");

    // Every ensure-then-create helper hit its 409 branch on the second
    // pass and listed the row it already created on the first — nothing
    // was ever created twice.
    expect(assetCreatePosts).toBe(4);
    expect(deploymentCreatePosts).toBe(4);
    expect(catalogModelCreatePosts).toBe(1);
    expect(catalogProviderCreatePosts).toBe(1);
    expect(catalogOfferingCreatePosts).toBe(1);
    expect(credentialCreatePosts).toBe(1);
    expect(assets.length).toBe(4);
    expect(deployments.length).toBe(4);
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
      publishToolRegistry: noopPublishToolRegistry,
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

describe("testAndPersistCredential (the fast half)", () => {
  test("proves and persists the key, but never deploys a workflow", async () => {
    let seedTenantCalled = false;
    const seedCatalogCalls: unknown[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      // Any workflow-shaped call proves this half reached past its
      // remit — `testAndPersistCredential` should never touch these.
      if (path.includes("/workflows/") || path.endsWith("/assets")) {
        throw new Error(`unexpected workflow-shaped call: ${method} ${path}`);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: async () => {
        seedTenantCalled = true;
        return "pushed";
      },
      log: collector().log,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
      },
    });

    expect(result).toEqual({
      kind: "connected",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: PRINCIPAL_ID,
      tenantDomain: "alice-user1.bench.local",
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalled).toBe(false);
  });

  test("an invalid key never touches the tenant", async () => {
    let apiCalls = 0;
    const api: ApiCall = async () => {
      apiCalls += 1;
      throw new Error("unexpected call with an invalid credential");
    };

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-bad",
      pushWorkflow: noopPush,
      publishToolRegistry: noopPublishToolRegistry,
      log: collector().log,
      testCredential: async () => ({ ok: false, message: "invalid x-api-key" }),
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

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      publishToolRegistry: noopPublishToolRegistry,
      log: collector().log,
      testCredential: async () => ({ ok: true }),
    });

    expect(result).toEqual({ kind: "no-personal-bench" });
  });
});

describe("ensureSeeded (the slow half)", () => {
  const TENANT: {
    tenantId: string;
    tenantSlug: string;
    principalId: string;
    tenantDomain: string;
  } = {
    tenantId: TENANT_ID,
    tenantSlug: TENANT_SLUG,
    principalId: PRINCIPAL_ID,
    tenantDomain: "alice-user1.bench.local",
  };

  test("deploys every default workflow against the connected provider's own model, unconfirmed", async () => {
    const seedTenantCalls: {
      model: { provider: string; model: string };
      confirmDeployments?: boolean;
    }[] = [];

    const result = await ensureSeeded({
      api: (async () => {
        throw new Error(
          "the real api must not be called — seedTenantFn is stubbed",
        );
      }) as ApiCall,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      pushWorkflow: noopPush,
      publishToolRegistry: noopPublishToolRegistry,
      log: collector().log,
      tenant: TENANT,
      provider: "anthropic",
      apiKey: "sk-ant-good",
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      workflows: ["echo", "assistant", "channel-digest", "recurring-task"],
    });
    expectNoConfirmation(seedTenantCalls);
    expect(seedTenantCalls[0]?.model.provider).toBe("anthropic");
  });

  test("two overlapping calls for the same tenant never double-deploy — the same 409-then-list tolerance seedTenant already has", async () => {
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    type Row = { name: string; id: string };
    const grants: { resource: string; action: string }[] = [];
    const assets: Row[] = [];
    const deployments: { definitionAssetId: string; id: string }[] = [];
    let assetCreatePosts = 0;
    let deploymentCreatePosts = 0;

    const api: ApiCall = async (method, path, body) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: {
            data: grants.map((g, index) => ({
              id: `grt_${index}`,
              tenantId: TENANT_ID,
              resource: g.resource,
              action: g.action,
              effect: "allow",
              principalId: PRINCIPAL_ID,
              origin: "creator",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const g = body as { resource: string; action: string };
        grants.push({ resource: g.resource, action: g.action });
        return { status: 201, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        const existing = assets.find((a) => a.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        assetCreatePosts += 1;
        const id = `ast_${name}`;
        assets.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: assets.map((a) => ({
            id: a.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: a.name,
            displayName: a.name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/git-tokens`
      ) {
        return {
          status: 201,
          data: { id: "tok_1", secret: "s3cret" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: deployments.map((d) => ({
            id: d.id,
            tenantId: TENANT_ID,
            definitionAssetId: d.definitionAssetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deploymentCreatePosts += 1;
        const assetId = (body as { assetId: string }).assetId;
        const id = `dep_${assetId}`;
        deployments.push({ definitionAssetId: assetId, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            definitionAssetId: assetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const runEnsureSeeded = () =>
      ensureSeeded({
        api,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        pushWorkflow: noopPush,
        publishToolRegistry: noopPublishToolRegistry,
        log: collector().log,
        tenant: TENANT,
        provider: "anthropic",
        apiKey: "sk-ant-good",
      });

    // Two overlapping calls, exactly like two concurrent
    // `/complete-setup` requests reading the same still-valid pending
    // token, running back to back against the same stateful fake hub.
    const [first, second] = await Promise.all([
      runEnsureSeeded(),
      runEnsureSeeded(),
    ]);

    expect(first.kind).toBe("seeded");
    expect(second.kind).toBe("seeded");
    expect(assetCreatePosts).toBe(4);
    expect(deploymentCreatePosts).toBe(4);
    expect(assets.length).toBe(4);
    expect(deployments.length).toBe(4);
  });
});
