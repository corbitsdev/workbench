// Fail-closed role assignment for created agents, over a stubbed stock API:
// names resolve against live roles, principals match run-anchored workflow
// rows, and every refusal aborts with nothing half-applied.
import { describe, expect, test } from "bun:test";

import { UnauthenticatedError } from "./lib/api-query";
import {
  AgentRolesError,
  assignAgentRoles,
  assignRolesToAgent,
  listTenantRoles,
  resolveAgentPrincipalId,
  resolveAgentRoleIds,
} from "./agent-roles";

type Route = {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: unknown;
};

function stubFetch(routes: readonly Route[], calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    const route = routes.find((candidate) => candidate.method === method && candidate.path === url);
    if (route === undefined) return new Response("no such route", { status: 404 });
    const body = route.body === undefined ? "" : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const TENANT = "tenant-1";

function roleRow(id: string, name: string, isSystem = false) {
  return {
    id,
    tenantId: TENANT,
    name,
    description: null,
    isSystem,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function rolesPage(names: readonly string[]) {
  return {
    data: names.map((name, index) => roleRow(`role-${index}`, name, name !== "custom")),
    nextCursor: null,
  };
}

function principalRow(id: string, refId: string, displayName: string, status = "active") {
  return { id, kind: "workflow", refId, displayName, status };
}

function principalsPage(
  rows: readonly ReturnType<typeof principalRow>[],
  nextCursor: string | null = null,
) {
  return { data: rows, nextCursor };
}

const PRINCIPALS_PATH = `/api/tenants/${TENANT}/principals?kind=workflow&limit=100`;
const ROLES_PATH = `/api/tenants/${TENANT}/roles?limit=100`;

describe("resolveAgentRoleIds", () => {
  test("maps names to per-tenant ids in selection order, dropping repeats", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [
        {
          method: "GET",
          path: ROLES_PATH,
          status: 200,
          body: rolesPage(["owner", "member", "custom"]),
        },
      ],
      calls,
    );
    const ids = await resolveAgentRoleIds(TENANT, ["member", "owner", "member"], fetchImpl);
    expect(ids).toEqual(["role-1", "role-0"]);
    expect(calls).toEqual([`GET ${ROLES_PATH}`]);
  });

  test("an empty selection reads nothing", async () => {
    const calls: string[] = [];
    const ids = await resolveAgentRoleIds(TENANT, [], stubFetch([], calls));
    expect(ids).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an unknown name fails closed naming the role", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [{ method: "GET", path: ROLES_PATH, status: 200, body: rolesPage(["owner"]) }],
      calls,
    );
    const error = await resolveAgentRoleIds(TENANT, ["owner", "auditor"], fetchImpl).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(AgentRolesError);
    expect((error as Error).message).toContain('"auditor"');
  });

  test("a signed-out read surfaces as unauthenticated", async () => {
    const fetchImpl = stubFetch([{ method: "GET", path: ROLES_PATH, status: 401 }], []);
    const error = await listTenantRoles(TENANT, fetchImpl).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UnauthenticatedError);
  });
});

describe("resolveAgentPrincipalId", () => {
  test("matches the anchor run principal by deployment id", async () => {
    const fetchImpl = stubFetch(
      [
        {
          method: "GET",
          path: PRINCIPALS_PATH,
          status: 200,
          body: principalsPage([principalRow("principal-1", "deployment-9", "Workflow (old@x)")]),
        },
      ],
      [],
    );
    const id = await resolveAgentPrincipalId(
      TENANT,
      { deploymentId: "deployment-9", address: "agent@t.localhost" },
      fetchImpl,
    );
    expect(id).toBe("principal-1");
  });

  test("matches a live run principal by address display name", async () => {
    const fetchImpl = stubFetch(
      [
        {
          method: "GET",
          path: PRINCIPALS_PATH,
          status: 200,
          body: principalsPage([
            principalRow("principal-2", "run-7", "Workflow (agent@t.localhost)"),
          ]),
        },
      ],
      [],
    );
    const id = await resolveAgentPrincipalId(
      TENANT,
      { deploymentId: "deployment-9", address: "agent@t.localhost" },
      fetchImpl,
    );
    expect(id).toBe("principal-2");
  });

  test("skips removed principals and returns null when none match", async () => {
    const fetchImpl = stubFetch(
      [
        {
          method: "GET",
          path: PRINCIPALS_PATH,
          status: 200,
          body: principalsPage([
            principalRow(
              "principal-gone",
              "deployment-9",
              "Workflow (agent@t.localhost)",
              "removed",
            ),
            principalRow("principal-other", "run-8", "Workflow (other@t.localhost)"),
          ]),
        },
      ],
      [],
    );
    const id = await resolveAgentPrincipalId(
      TENANT,
      { deploymentId: "deployment-9", address: "agent@t.localhost" },
      fetchImpl,
    );
    expect(id).toBeNull();
  });

  test("follows cursor pages to the match", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [
        {
          method: "GET",
          path: PRINCIPALS_PATH,
          status: 200,
          body: principalsPage(
            [principalRow("principal-other", "run-8", "Workflow (x)")],
            "cursor-1",
          ),
        },
        {
          method: "GET",
          path: `${PRINCIPALS_PATH}&cursor=cursor-1`,
          status: 200,
          body: principalsPage([principalRow("principal-3", "deployment-9", "Workflow (y)")]),
        },
      ],
      calls,
    );
    const id = await resolveAgentPrincipalId(TENANT, { deploymentId: "deployment-9" }, fetchImpl);
    expect(id).toBe("principal-3");
    expect(calls).toEqual([`GET ${PRINCIPALS_PATH}`, `GET ${PRINCIPALS_PATH}&cursor=cursor-1`]);
  });
});

describe("assignAgentRoles", () => {
  const assignPath = (principalId: string, roleId: string) =>
    `/api/tenants/${TENANT}/principals/${principalId}/roles/${roleId}`;

  test("posts each role in order", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: assignPath("principal-1", "role-0"), status: 204 },
        { method: "POST", path: assignPath("principal-1", "role-1"), status: 204 },
      ],
      calls,
    );
    await assignAgentRoles(TENANT, "principal-1", ["role-0", "role-1"], fetchImpl);
    expect(calls).toEqual([
      `POST ${assignPath("principal-1", "role-0")}`,
      `POST ${assignPath("principal-1", "role-1")}`,
    ]);
  });

  test("a refused write stops the apply with the hub's message", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [
        { method: "POST", path: assignPath("principal-1", "role-0"), status: 204 },
        {
          method: "POST",
          path: assignPath("principal-1", "role-9"),
          status: 404,
          body: {
            error: {
              code: "not_found",
              message: "Role not found",
              userMessage: "That role is gone.",
            },
          },
        },
        { method: "POST", path: assignPath("principal-1", "role-1"), status: 204 },
      ],
      calls,
    );
    const error = await assignAgentRoles(
      TENANT,
      "principal-1",
      ["role-0", "role-9", "role-1"],
      fetchImpl,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentRolesError);
    expect((error as Error).message).toContain("That role is gone.");
    expect(calls).toEqual([
      `POST ${assignPath("principal-1", "role-0")}`,
      `POST ${assignPath("principal-1", "role-9")}`,
    ]);
  });
});

describe("assignRolesToAgent", () => {
  test("an empty id list touches nothing", async () => {
    const calls: string[] = [];
    await assignRolesToAgent(
      { tenantId: TENANT, roleIds: [], principalRef: { deploymentId: "deployment-9" } },
      stubFetch([], calls),
    );
    expect(calls).toEqual([]);
  });

  test("a principal that does not exist yet fails with nothing assigned", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [{ method: "GET", path: PRINCIPALS_PATH, status: 200, body: principalsPage([]) }],
      calls,
    );
    const error = await assignRolesToAgent(
      {
        tenantId: TENANT,
        roleIds: ["role-0"],
        principalRef: { deploymentId: "deployment-9", address: "agent@t.localhost" },
      },
      fetchImpl,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentRolesError);
    expect((error as Error).message).toContain("hasn't run yet");
    expect(calls).toEqual([`GET ${PRINCIPALS_PATH}`]);
  });

  test("resolves the principal, then assigns every id", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [
        {
          method: "GET",
          path: PRINCIPALS_PATH,
          status: 200,
          body: principalsPage([principalRow("principal-1", "deployment-9", "Workflow (z)")]),
        },
        {
          method: "POST",
          path: `/api/tenants/${TENANT}/principals/principal-1/roles/role-0`,
          status: 204,
        },
      ],
      calls,
    );
    await assignRolesToAgent(
      {
        tenantId: TENANT,
        roleIds: ["role-0"],
        principalRef: { deploymentId: "deployment-9" },
      },
      fetchImpl,
    );
    expect(calls).toEqual([
      `GET ${PRINCIPALS_PATH}`,
      `POST /api/tenants/${TENANT}/principals/principal-1/roles/role-0`,
    ]);
  });
});
