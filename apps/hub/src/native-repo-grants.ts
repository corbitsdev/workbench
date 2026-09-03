// Repo grants for GitHub start-reviewing: GET/POST the native
// `/api/tenants/:id/grants` surface as the requesting user. Never
// SQL-inserts Interchange grant/role rows.
import { GrantResponse, RoleResponse, paginatedSchema } from "@intx/types";
import { parseAs, type ApiCall } from "@corbits/hub-api-client";
import { reportError } from "@corbits/error-sink";

type RepoName = { name: string };

function throwHttp(label: string, status: number, data: unknown): never {
  throw new Error(
    `${label} failed with status ${status}: ${JSON.stringify(data)}`,
  );
}

export async function hasRepoGrantViaHttp(
  api: ApiCall,
  tenantId: string,
  repo: RepoName,
  cookies: string[],
): Promise<boolean> {
  const resource = `repo:${repo.name}`;
  const listed = await api(
    "GET",
    `/api/tenants/${tenantId}/grants?resource=${encodeURIComponent(resource)}&limit=200`,
    undefined,
    cookies,
  );
  if (listed.status !== 200) {
    throwHttp(
      `GET /api/tenants/${tenantId}/grants`,
      listed.status,
      listed.data,
    );
  }
  const grants = parseAs(
    paginatedSchema(GrantResponse),
    listed.data,
    "grants response",
  ).data;
  return grants.some(
    (g) =>
      g.resource === resource && g.action === "read" && g.effect === "allow",
  );
}

export async function mintRepoGrantViaHttp(
  api: ApiCall,
  tenantId: string,
  repo: RepoName,
  cookies: string[],
): Promise<void> {
  try {
    const rolesResponse = await api(
      "GET",
      `/api/tenants/${tenantId}/roles?limit=200`,
      undefined,
      cookies,
    );
    if (rolesResponse.status !== 200) {
      throwHttp(
        `GET /api/tenants/${tenantId}/roles`,
        rolesResponse.status,
        rolesResponse.data,
      );
    }
    const roles = parseAs(
      paginatedSchema(RoleResponse),
      rolesResponse.data,
      "roles response",
    ).data;
    const memberRole = roles.find((r) => r.name === "member");
    if (memberRole === undefined) {
      throw new Error(
        `tenant ${tenantId} has no system "member" role to scope a repo grant to`,
      );
    }
    const posted = await api(
      "POST",
      `/api/tenants/${tenantId}/grants`,
      {
        roleId: memberRole.id,
        resource: `repo:${repo.name}`,
        action: "read",
        effect: "allow",
        origin: "creator",
      },
      cookies,
    );
    if (posted.status !== 201) {
      throwHttp(
        `POST /api/tenants/${tenantId}/grants`,
        posted.status,
        posted.data,
      );
    }
  } catch (cause) {
    reportError(cause, {
      operation: "mintRepoGrant",
      tenantId,
      extra: { repo: repo.name },
    });
    throw cause;
  }
}
