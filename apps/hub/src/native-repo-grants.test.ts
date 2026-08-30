// Repo grants for GitHub start-reviewing go through native tenant HTTP,
// never a SQL insert into Interchange grant/role tables.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureSync, resetSync } from "@intx/log";
import type { ApiCall } from "@workbench/hub-client";

import {
  hasRepoGrantViaHttp,
  mintRepoGrantViaHttp,
} from "./native-repo-grants";

let records: { properties: Record<string, unknown> }[];

function installCapturingSink(): void {
  records = [];
  configureSync({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record as { properties: Record<string, unknown> });
      },
    },
    loggers: [
      { category: ["errors"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

beforeEach(() => installCapturingSink());
afterEach(() => resetSync());

const REPO = { id: "1", name: "acme/widgets" };
const TENANT_ID = "tnt_bench";
const MEMBER_ROLE_ID = "rol_member";
const COOKIES = ["session=alice"];

function rolesPage() {
  return {
    data: [
      {
        id: MEMBER_ROLE_ID,
        tenantId: TENANT_ID,
        name: "member",
        description: "System member role",
        isSystem: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  };
}

describe("mintRepoGrantViaHttp", () => {
  test("POSTs /api/tenants/:id/grants for repo:<name> read and never needs SQL", async () => {
    const posts: {
      path: string;
      body: unknown;
      cookies: string[] | undefined;
    }[] = [];
    const api: ApiCall = async (method, path, body, cookies) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      ) {
        return { status: 200, data: rolesPage(), cookies: cookies ?? [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        posts.push({ path, body, cookies });
        return { status: 201, data: { id: "grt_1" }, cookies: cookies ?? [] };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    await mintRepoGrantViaHttp(api, TENANT_ID, REPO, COOKIES);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.cookies).toEqual(COOKIES);
    expect(posts[0]?.body).toEqual({
      roleId: MEMBER_ROLE_ID,
      resource: "repo:acme/widgets",
      action: "read",
      effect: "allow",
      origin: "creator",
    });
    expect(records).toHaveLength(0);
  });

  test("reports and rethrows when POST /grants is rejected", async () => {
    const api: ApiCall = async (method, path, _body, cookies) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      ) {
        return { status: 200, data: rolesPage(), cookies: cookies ?? [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return {
          status: 403,
          data: { error: { code: "forbidden", message: "nope" } },
          cookies: cookies ?? [],
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    await expect(
      mintRepoGrantViaHttp(api, TENANT_ID, REPO, COOKIES),
    ).rejects.toThrow(
      "POST /api/tenants/tnt_bench/grants failed with status 403",
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.properties).toEqual(
      expect.objectContaining({
        operation: "mintRepoGrant",
        tenantId: TENANT_ID,
        extra: { repo: "acme/widgets" },
      }),
    );
  });
});

describe("hasRepoGrantViaHttp", () => {
  test("is true when GET /grants already lists repo:<name> read allow", async () => {
    const api: ApiCall = async (method, path, _body, cookies) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?resource=`)
      ) {
        return {
          status: 200,
          data: {
            data: [
              {
                id: "grt_1",
                tenantId: TENANT_ID,
                roleId: MEMBER_ROLE_ID,
                roleName: "member",
                principalId: null,
                principalName: null,
                resource: "repo:acme/widgets",
                action: "read",
                effect: "allow",
                conditions: null,
                origin: "creator",
                expiresAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
          cookies: cookies ?? [],
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    expect(await hasRepoGrantViaHttp(api, TENANT_ID, REPO, COOKIES)).toBe(true);
  });

  test("is false when GET /grants lists no matching row", async () => {
    const api: ApiCall = async (method, path, _body, cookies) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants`)
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: cookies ?? [],
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };

    expect(await hasRepoGrantViaHttp(api, TENANT_ID, REPO, COOKIES)).toBe(
      false,
    );
  });
});
