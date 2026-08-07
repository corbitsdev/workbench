import { describe, expect, test } from "bun:test";
import { CliError } from "@workbench/hub-client";
import type { SeedConfig } from "../src/config";
import { runSeed, type SeedDeps } from "../src/seed";
import {
  collector,
  fakeAPI,
  principalsResponse,
  signUpResponse,
  tenantRow,
  TENANT_ID,
  type FakeHandler,
} from "./helpers";

const CONFIG: SeedConfig = {
  hubUrl: "http://localhost:3000",
  adminDefaulted: false,
  adminEmail: "admin@example.com",
  adminPassword: "password123",
  orgSlug: "workbench",
  modelSource: {
    provider: "anthropic",
    model: "claude-sonnet-5",
    baseURL: "https://api.anthropic.com",
    apiKey: "placeholder-not-a-real-key",
  },
  anthropicApiKeyConfigured: false,
};

function deps(overrides: Partial<SeedDeps> & Pick<SeedDeps, "api">): SeedDeps {
  const { log } = collector();
  return {
    config: CONFIG,
    pushWorkflow: async () => "pushed",
    log,
    ...overrides,
  };
}

describe("runSeed", () => {
  test("authenticates, resolves the bench by slug, and starts seeding it", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return principalsResponse();
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`)
        return { status: 200, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      )
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    };

    // Resolving the bench succeeds and hands off into seedTenant; the
    // very next unhandled call (planting the first seed grant) proves
    // the handoff happened without re-testing seedTenant's own
    // mechanics, which belong to @workbench/hub-client.
    expect(runSeed(deps({ api: fakeAPI(handler), log }))).rejects.toThrow(
      /unexpected hub call/,
    );
    expect(lines.join("\n")).toContain(
      `seeding bench workbench (${TENANT_ID})`,
    );
  });

  test("seeds the tenant catalog's inference source after the tenant is seeded", async () => {
    const { lines, log } = collector();
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    let runsCalls = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return principalsResponse();
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`)
        return { status: 200, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      )
        return { status: 200, data: { data: [], nextCursor: null } };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`)
        return { status: 201, data: {} };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/git-tokens`)
        return { status: 201, data: { id: "tok_1", secret: "s3cret" } };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return {
          status: 201,
          data: {
            id: "ast_1",
            tenantId: TENANT_ID,
            kind: "workflow",
            name: "echo",
            displayName: null,
            creatorPrincipalId: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return {
          status: 201,
          data: {
            id: "dep_1",
            tenantId: TENANT_ID,
            definitionAssetId: "ast_1",
            status: "active",
            createdAt: TIMESTAMP,
          },
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_1",
            address: "ins_dep_1@workbench.localhost",
            messageId: "<m1@workbench.localhost>",
          },
        };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return {
          status: 201,
          data: {
            id: "prv_1",
            tenantId: TENANT_ID,
            name: "anthropic",
            plugin: "anthropic",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: {
            id: "cre_1",
            tenantId: TENANT_ID,
            providerId: "prv_1",
            name: "anthropic-default",
            type: "api_key",
            status: "active",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: {
            id: "mdl_1",
            tenantId: TENANT_ID,
            canonicalName: "claude-sonnet-5",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: {
            id: "cpv_1",
            tenantId: TENANT_ID,
            name: "anthropic",
            plugin: "anthropic",
            baseURL: "https://api.anthropic.com",
            credentialId: "cre_1",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
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
        };
      return undefined;
    };

    await runSeed(
      deps({
        api: fakeAPI(handler),
        pushWorkflow: async () => "pushed",
        log,
        sleep: async () => {},
        runStartTimeoutMs: 3,
        runPollIntervalMs: 1,
      }),
    );

    const output = lines.join("\n");
    expect(output).toContain(
      "ANTHROPIC_API_KEY is not set; the tenant catalog is seeded with data only",
    );
    expect(output).toContain("created catalog model claude-sonnet-5");
  });

  test("placeholderCredential opts into a launchable catalog without a real key", async () => {
    const { lines, log } = collector();
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    let runsCalls = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return principalsResponse();
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`)
        return { status: 200, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      )
        return { status: 200, data: { data: [], nextCursor: null } };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`)
        return { status: 201, data: {} };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/git-tokens`)
        return { status: 201, data: { id: "tok_1", secret: "s3cret" } };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return {
          status: 201,
          data: {
            id: "ast_1",
            tenantId: TENANT_ID,
            kind: "workflow",
            name: "echo",
            displayName: null,
            creatorPrincipalId: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      )
        return {
          status: 201,
          data: {
            id: "dep_1",
            tenantId: TENANT_ID,
            definitionAssetId: "ast_1",
            status: "active",
            createdAt: TIMESTAMP,
          },
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            deploymentId: "dep_1",
            address: "ins_dep_1@workbench.localhost",
            messageId: "<m1@workbench.localhost>",
          },
        };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return {
          status: 201,
          data: {
            id: "prv_1",
            tenantId: TENANT_ID,
            name: "anthropic",
            plugin: "anthropic",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: {
            id: "cre_1",
            tenantId: TENANT_ID,
            providerId: "prv_1",
            name: "anthropic-default",
            type: "api_key",
            status: "active",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: {
            id: "mdl_1",
            tenantId: TENANT_ID,
            canonicalName: "claude-sonnet-5",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: {
            id: "cpv_1",
            tenantId: TENANT_ID,
            name: "anthropic",
            plugin: "anthropic",
            baseURL: "https://api.anthropic.com",
            credentialId: "cre_1",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
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
        };
      return undefined;
    };

    await runSeed(
      deps({
        api: fakeAPI(handler),
        pushWorkflow: async () => "pushed",
        log,
        sleep: async () => {},
        runStartTimeoutMs: 3,
        runPollIntervalMs: 1,
        placeholderCredential: true,
      }),
    );

    const output = lines.join("\n");
    expect(output).not.toContain("seeded with data only");
    expect(output).toContain("catalog ready: anthropic/claude-sonnet-5");
  });

  test("a missing bench points at workbench setup", async () => {
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    };

    let caught: unknown;
    try {
      await runSeed(deps({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("workbench setup");
  });
});
