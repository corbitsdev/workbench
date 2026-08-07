import { describe, expect, test } from "bun:test";
import type { ApiCall } from "@workbench/hub-client";
import type { WorkflowPusher } from "@workbench/hub-client";
import {
  personalTenantSlug,
  provisionPersonalTenantIfNeeded,
} from "../src/provision";

const TENANT_ID = "ten_new";
const PRINCIPAL_ID = "prn_new";
const TENANT_SLUG = "alice-user1";
const DEPLOYMENT_ID = "dep_1";

const MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.com/v1",
  apiKey: "sk-test",
};

const noopPush: WorkflowPusher = async () => "pushed";

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("personalTenantSlug", () => {
  test("derives a lowercase-kebab slug from the email and a user-id fragment", () => {
    expect(personalTenantSlug("Alice.Smith@example.com", "user_id_1")).toBe(
      "alice-smith-userid1",
    );
  });

  test("never produces an empty component", () => {
    expect(personalTenantSlug("@example.com", "")).toBe("bench-personal");
  });
});

describe("provisionPersonalTenantIfNeeded", () => {
  test("an existing member is left alone: no tenant is created", async () => {
    let tenantCreateCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: "ten_existing",
                tenantName: "Existing",
                tenantSlug: "existing",
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
      if (method === "POST" && path === "/api/tenants") {
        tenantCreateCalls += 1;
        throw new Error("unexpected tenant creation for an existing member");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "existing-member" });
    expect(tenantCreateCalls).toBe(0);
  });

  test("losing a concurrent-provisioning race returns the winner's membership instead of erroring", async () => {
    let principalsCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) {
          return {
            status: 200,
            data: { data: [], nextCursor: null },
            cookies: [],
          };
        }
        // The race's winner already created the bench by the time this
        // caller re-checks after its own create lost with a 409.
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 409,
          data: { error: { code: "conflict", message: "Slug already taken" } },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "existing-member" });
  });

  test("a slug conflict that still leaves the caller benchless is a real failure", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 409,
          data: { error: { code: "conflict", message: "Slug already taken" } },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await expect(
      provisionPersonalTenantIfNeeded({
        api,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        userId: "user_1",
        userEmail: "alice@example.com",
        pushWorkflow: noopPush,
        log: collector().log,
      }),
    ).rejects.toThrow(/slug conflict/);
  });

  test("zero principals with no seed model: provisions the bench and reports the seed skip loudly", async () => {
    let principalsCalls = 0;
    const { lines, log } = collector();
    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) {
          return {
            status: 200,
            data: { data: [], nextCursor: null },
            cookies: [],
          };
        }
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        const parsed = body as { parentId?: string; slug: string };
        expect(parsed.parentId).toBeUndefined();
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: parsed.slug,
            domain: `${parsed.slug}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      pushWorkflow: noopPush,
      log,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") throw new Error("unreachable");
    expect(result.seeded).toBe(false);
    expect(result.seedSkipReason).toContain("ANTHROPIC_API_KEY");
    expect(lines.some((line) => line.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  test("zero principals with a seed model configured: provisions under the operator tenant and seeds the default workflow", async () => {
    let principalsCalls = 0;
    let runsCalls = 0;
    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) {
          return {
            status: 200,
            data: { data: [], nextCursor: null },
            cookies: [],
          };
        }
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        const parsed = body as { parentId?: string; slug: string };
        expect(parsed.parentId).toBe("ten_operator");
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: parsed.slug,
            domain: `${parsed.slug}.localhost`,
            parentId: "ten_operator",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
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
        return {
          status: 201,
          data: {
            id: "ast_1",
            tenantId: TENANT_ID,
            kind: "workflow",
            name: "echo",
            displayName: null,
            creatorPrincipalId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
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
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      ) {
        return {
          status: 201,
          data: {
            id: DEPLOYMENT_ID,
            tenantId: TENANT_ID,
            definitionAssetId: "ast_1",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls <= 1 ? [] : ["run_1"] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        return {
          status: 202,
          data: {
            deploymentId: DEPLOYMENT_ID,
            address: "echo@x",
            messageId: "m1",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const { log } = collector();
    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      operatorTenantId: "ten_operator",
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log,
    });

    expect(result).toEqual({
      kind: "provisioned",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      seeded: true,
    });
  });

  test("a retry after tenant creation succeeded but seeding failed re-seeds instead of reporting a plain existing member", async () => {
    let assetCreateAttempts = 0;
    let runsCalls = 0;
    let tenantCreated = false;

    const membership = () => ({
      status: 200,
      data: {
        data: tenantCreated
          ? [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ]
          : [],
        nextCursor: null,
      },
      cookies: [],
    });

    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return membership();
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantCreated = true;
        const parsed = body as { slug: string };
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: parsed.slug,
            domain: `${parsed.slug}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
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
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/assets?kind=workflow`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        assetCreateAttempts += 1;
        if (assetCreateAttempts === 1) {
          // The first attempt's seeding fails right here, after the
          // tenant itself was already created above.
          return {
            status: 500,
            data: { error: "asset service unavailable" },
            cookies: [],
          };
        }
        return {
          status: 201,
          data: {
            id: "ast_1",
            tenantId: TENANT_ID,
            kind: "workflow",
            name: "echo",
            displayName: null,
            creatorPrincipalId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
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
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      ) {
        return {
          status: 201,
          data: {
            id: DEPLOYMENT_ID,
            tenantId: TENANT_ID,
            definitionAssetId: "ast_1",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls <= 1 ? [] : ["run_1"] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        return {
          status: 202,
          data: {
            deploymentId: DEPLOYMENT_ID,
            address: "echo@x",
            messageId: "m1",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const firstAttempt = provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log: collector().log,
    });
    await expect(firstAttempt).rejects.toThrow(/asset service unavailable/);
    expect(tenantCreated).toBe(true);

    const { log } = collector();
    const retry = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log,
    });

    expect(retry).toEqual({ kind: "existing-member", seeded: true });
    expect(assetCreateAttempts).toBe(2);
  });
});
