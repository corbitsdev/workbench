// Unit gates for `bun run publish-tools`: a stub hub API proves the
// command signs in (never signs up), resolves the target tenant from
// `--tenant` or the admin's sole membership, and invokes the existing
// publisher with the signed-in cookies. The publisher itself is proven
// by `packages/tool-registry-publish`'s suite and the local-rip e2e hop.
import { describe, expect, test } from "bun:test";
import { runPublishTools, type PublishToolsArgs } from "./publish-tools.ts";

type ApiStub = (
  method: string,
  path: string,
) => Promise<{ status: number; data: unknown; cookies: string[] }>;

function principalsRow(tenant: {
  id: string;
  slug: string;
  name: string;
}): unknown {
  return {
    principalId: `principal_${tenant.id}`,
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    kind: "user",
    status: "active",
    roles: [{ id: "role_owner", name: "owner" }],
  };
}

function stubApi(principals: unknown[]): {
  api: ApiStub;
  calls: { method: string; path: string }[];
} {
  const calls: { method: string; path: string }[] = [];
  const api: ApiStub = (method, path) => {
    calls.push({ method, path });
    if (path === "/api/auth/sign-in/email") {
      return Promise.resolve({
        status: 200,
        data: { user: { id: "user_admin" } },
        cookies: ["better-auth.session_token=stub"],
      });
    }
    if (path === "/api/me/principals") {
      return Promise.resolve({
        status: 200,
        data: { data: principals, nextCursor: null },
        cookies: [],
      });
    }
    if (path.includes("/assets?")) {
      return Promise.resolve({ status: 200, data: [], cookies: [] });
    }
    if (method === "POST" && path === "/api/tenants/tenant_genesis/assets") {
      return Promise.resolve({
        status: 201,
        data: {
          id: "asset_registry",
          kind: "package-registry",
          name: "corbits-tools",
          displayName: null,
          tenantId: "tenant_genesis",
          creatorPrincipalId: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        cookies: [],
      });
    }
    if (path.includes("/tarballs/")) {
      return Promise.resolve({
        status: 200,
        data: { commit: "sha_stub", integrity: "sha512-stub" },
        cookies: [],
      });
    }
    return Promise.resolve({ status: 404, data: null, cookies: [] });
  };
  return { api, calls };
}

function args(
  api: ApiStub,
  tenant?: string,
  calls?: { method: string; path: string }[],
): PublishToolsArgs {
  return {
    hubUrl: "http://localhost:3000",
    email: "admin@example.com",
    password: "password123",
    ...(tenant !== undefined ? { tenant } : {}),
    log: () => undefined,
    checkFreshness: () => Promise.resolve(),
    packageDirs: ["/stub/package"],
    fetchImpl: (input, init) => {
      calls?.push({
        method: init.method ?? "GET",
        path: new URL(input).pathname,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({ commit: "sha_stub", integrity: "sha512-stub" }),
          { status: 200 },
        ),
      );
    },
    pack: () =>
      Promise.resolve({
        name: "@corbits/memory-tools",
        version: "0.0.1",
        filename: "corbits-memory-tools-0.0.1.tgz",
        bytes: new TextEncoder().encode("tarball-bytes"),
      }),
    api: api as never,
  };
}

describe("runPublishTools", () => {
  test("signs in, resolves the sole membership, and publishes onto it", async () => {
    const { api, calls } = stubApi([
      principalsRow({ id: "tenant_genesis", slug: "genesis-root", name: "Genesis Root" }),
    ]);
    const puts: { method: string; path: string }[] = [];
    const result = await runPublishTools(args(api, undefined, puts));
    expect(result.success).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/auth/sign-in/email",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/tenants/tenant_genesis/assets",
      ),
    ).toBe(true);
    expect(
      puts.some(
        (call) =>
          call.method === "PUT" &&
          call.path ===
            "/api/tenants/tenant_genesis/assets/asset_registry/tarballs/corbits-memory-tools-0.0.1.tgz",
      ),
    ).toBe(true);
  });

  test("honors --tenant by slug", async () => {
    const { api, calls } = stubApi([
      principalsRow({ id: "tenant_genesis", slug: "genesis-root", name: "Genesis Root" }),
    ]);
    await runPublishTools(args(api, "genesis-root"));
    expect(
      calls.some((call) => call.path.includes("tenant_genesis")),
    ).toBe(true);
  });

  test("fails when --tenant matches no membership", async () => {
    const { api } = stubApi([
      principalsRow({ id: "tenant_genesis", slug: "genesis-root", name: "Genesis Root" }),
    ]);
    await expect(runPublishTools(args(api, "nope"))).rejects.toThrow(
      /no tenant matching "nope"/,
    );
  });

  test("fails when the admin belongs to several tenants and no --tenant is given", async () => {
    const { api } = stubApi([
      principalsRow({ id: "tenant_genesis", slug: "genesis-root", name: "Genesis Root" }),
      principalsRow({ id: "tenant_other", slug: "other", name: "Other" }),
    ]);
    await expect(runPublishTools(args(api))).rejects.toThrow(
      /--tenant is required/,
    );
  });
});
