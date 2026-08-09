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
  baseURL: "https://api.anthropic.com",
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
    const startedRuns: string[] = [];
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
        return {
          status: 200,
          data: { runIds: [...startedRuns] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        const runId = `run_${startedRuns.length + 1}`;
        startedRuns.push(runId);
        return {
          status: 202,
          data: {
            deploymentId: DEPLOYMENT_ID,
            address: "echo@x",
            messageId: `m${startedRuns.length}`,
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
    const startedRuns: string[] = [];
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
        path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
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
        return {
          status: 200,
          data: { runIds: [...startedRuns] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        const runId = `run_${startedRuns.length + 1}`;
        startedRuns.push(runId);
        return {
          status: 202,
          data: {
            deploymentId: DEPLOYMENT_ID,
            address: "echo@x",
            messageId: `m${startedRuns.length}`,
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
    // Attempt 1 fails creating the echo asset. The retry re-runs from
    // scratch: one create call per default workflow — echo, assistant,
    // channel-digest — on top of the one failed attempt.
    expect(assetCreateAttempts).toBe(4);
  });

  test("half-provisioned personal bench without a seed model returns existing-member (not stuck)", async () => {
    // Without ANTHROPIC_API_KEY the server has no seed model. Membership of a
    // personal bench must still resolve — recovery of "I have a bench" must
    // not depend on a seed credential that may never exist. Seeding itself is
    // skipped (nothing to seed with); the user is not stranded in a loop.
    let assetListCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
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
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        assetListCalls += 1;
        // Tenant-local assets empty — not fully seeded.
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/instances`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      // No seedModel — hub without ANTHROPIC_API_KEY.
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "existing-member" });
    // Completeness was checked (tenant-local assets listed) even without a
    // seed model — membership recovery does not short-circuit before that.
    expect(assetListCalls).toBe(1);
  });

  test("isFullySeeded lists tenant-local assets only (inherited=false)", async () => {
    // OPERATOR_TENANT_ID trees can surface the parent's workflow assets when
    // listing with inherited=true. Those must not satisfy the seed check —
    // only tenant-local assets count. Assert the query uses inherited=false
    // and that empty local assets trigger a re-seed when a seed model exists.
    let listedInherited = false;
    let listedLocal = false;
    let assetCreateCount = 0;
    const startedRuns: string[] = [];

    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
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
        path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        listedLocal = true;
        return { status: 200, data: [], cookies: [] };
      }
      if (method === "GET" && path.includes("inherited=true")) {
        listedInherited = true;
        throw new Error("must not list inherited assets for seed completeness");
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        assetCreateCount += 1;
        const name =
          typeof body === "object" &&
          body !== null &&
          "name" in body &&
          typeof (body as { name: unknown }).name === "string"
            ? (body as { name: string }).name
            : `wf_${assetCreateCount}`;
        return {
          status: 201,
          data: {
            id: `ast_${assetCreateCount}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
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
            definitionAssetId: `ast_${assetCreateCount}`,
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
        return {
          status: 200,
          data: { runIds: [...startedRuns] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        startedRuns.push("run_1");
        return {
          status: 200,
          data: { ok: true, runId: "run_1" },
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
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(listedLocal).toBe(true);
    expect(listedInherited).toBe(false);
    // Empty tenant-local assets must re-seed, not claim "already seeded"
    // from an ancestor's inherited catalog.
    expect(result).toEqual({ kind: "existing-member", seeded: true });
    expect(assetCreateCount).toBeGreaterThan(0);
  });
});
