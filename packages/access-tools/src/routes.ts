// The workflow-run-authenticated counterpart of Interchange's native
// tenant principal/grant routes (`@intx/hub-api`'s `createPrincipalRoutes`
// / `createGrantRoutes`, served at `/api/tenants/:tenantId/principals` and
// `/grants`) — the server half of `@corbits/access-tools`'
// `list_principals`, `list_grants`, `grant_access`, and `revoke_access`
// tools. A workflow child has no browser session, only its sidecar bearer
// token and its own run address, so it authenticates through a
// `WorkflowRunAuthenticator` rather than the tenant-session pipeline —
// the same reasoning `@corbits/agent-directory`'s
// workflow-capability-routes and `@corbits/chat`'s
// workflow-participant-routes give for their own bearer-authenticated
// mirrors. Mounted OUTSIDE the tenant prefix for that reason, at
// `/api/workflow-access`. Every write is scoped to the authenticated
// run's own tenant/principal alone — identity never rides in a request
// body.
//
// Same contract as the native routes: `{data, nextCursor}` cursor pages
// for the two `GET` lists (same cursor algorithm, so cursors stay
// interchangeable), the native `CreateGrant` single-action body for
// `POST /grants` returning the single native `GrantResponse` object,
// `204` deletes, and the canonical `{error: {code, message}}` envelope on
// every failure. The ONLY deliberate deltas from native are the run-bearer
// auth above and the delegation ceiling below: a caller may only grant
// (or revoke) authority it already holds itself — otherwise
// `grant:*`/`create` alone would let any principal escalate past its own
// ceiling. That check reuses `@intx/authz`'s own `authorize` against the
// SAME grant store `requireGrant` checks against, per requested pair.
//
// Authorization for every route runs through `@intx/hub-api`'s own
// `createRequireGrant` against that same store and condition registry,
// resolved for the caller's real principal row (fetched once here,
// exactly like `@intx/hub-api`'s own `createWorkflowRunDeployAuth`
// resolves the deploy route's bearer mirror). A principal the tenant
// hasn't granted `principal:*`/`grant:*` gets a real 403 from the real
// grant store, not a bundle-local approximation.
import { and, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type } from "arktype";

import { parseGrantRow, type DB } from "@intx/db";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import {
  createRequireGrant,
  idResource,
  resolveWorkflowPrincipalLabels,
  type RequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import { authorize } from "@intx/authz";
import { base64urlDecode, base64urlEncode, CreateGrant } from "@intx/types";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";

export type WorkflowAccessRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowAccessRunScope | null>;
};

export type CreateWorkflowAccessRoutesDeps = {
  db: DB["db"];
  authenticator: WorkflowRunAuthenticator;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

/** Cursor paging identical to the native tenant lists
 * (`vendor/intx/hub-api/src/pagination.ts`, reimplemented here because
 * that module is not part of `@intx/hub-api`'s published surface):
 * keyset on `(createdAt, id)` descending, opaque base64url cursor, default
 * limit 50, max 100. Cursors minted here decode on the native routes and
 * vice versa. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const CursorData = type({
  t: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  id: "string",
});

function parsePageParams(query: {
  cursor: string | undefined;
  limit: string | undefined;
}): { limit: number; cursor: { t: string; id: string } | null } {
  const raw = query.limit !== undefined ? Number(query.limit) : DEFAULT_LIMIT;
  const limit = Number.isNaN(raw)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(1, raw), MAX_LIMIT);
  let cursor: { t: string; id: string } | null = null;
  if (query.cursor !== undefined) {
    try {
      const data = CursorData(
        JSON.parse(new TextDecoder().decode(base64urlDecode(query.cursor))),
      );
      cursor = data instanceof type.errors ? null : data;
    } catch {
      cursor = null;
    }
  }
  return { limit, cursor };
}

function encodeCursor(createdAt: Date, id: string): string {
  return base64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ t: createdAt.toISOString(), id }),
    ),
  );
}

function pageResponse<T>(
  items: T[],
  rows: { createdAt: Date; id: string }[],
  limit: number,
): { data: T[]; nextCursor: string | null } {
  const hasMore = items.length === limit;
  const lastRow = hasMore ? rows[rows.length - 1] : undefined;
  return {
    data: items,
    nextCursor:
      lastRow !== undefined ? encodeCursor(lastRow.createdAt, lastRow.id) : null,
  };
}

// A caller may only grant (or revoke) authority it already holds itself —
// otherwise `grant:*`/`create` alone would let any principal escalate past
// its own ceiling. Reuses `@intx/authz`'s own `authorize` against the same
// grant store `requireGrant` checks against, per requested pair.
async function pairOutsideCeiling(
  deps: Pick<
    CreateWorkflowAccessRoutesDeps,
    "grantStore" | "conditionRegistry"
  >,
  callerPrincipalId: string,
  tenantId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  const result = await authorize(
    deps.grantStore,
    callerPrincipalId,
    tenantId,
    resource,
    action,
    deps.conditionRegistry,
  );
  return result.effect !== "allow";
}

function nativeError(code: string, message: string) {
  return { error: { code, message } };
}

type ResolvedNames = {
  roleNames: Map<string, string>;
  principalNames: Map<string, string>;
};

async function resolveGrantNames(
  db: DB["db"],
  grants: (typeof grant.$inferSelect)[],
): Promise<ResolvedNames> {
  const roleIds = [
    ...new Set(
      grants.map((g) => g.roleId).filter((id): id is string => id !== null),
    ),
  ];
  const principalIds = [
    ...new Set(
      grants
        .map((g) => g.principalId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const roleNames = new Map<string, string>();
  if (roleIds.length > 0) {
    const roles = await db.query.role.findMany({
      where: (r, { inArray }) => inArray(r.id, roleIds),
    });
    for (const r of roles) {
      roleNames.set(r.id, r.name);
    }
  }

  const principalNames = new Map<string, string>();
  if (principalIds.length > 0) {
    const principals = await db.query.principal.findMany({
      where: (p, { inArray }) => inArray(p.id, principalIds),
    });
    const userRefIds = principals
      .filter((p) => p.kind === "user")
      .map((p) => p.refId);
    const workflowRefIds = principals
      .filter((p) => p.kind === "workflow")
      .map((p) => p.refId);

    const refToName = new Map<string, string>();
    if (userRefIds.length > 0) {
      const users = await db.query.user.findMany({
        where: (u, { inArray }) => inArray(u.id, userRefIds),
      });
      for (const u of users) {
        refToName.set(u.id, u.name);
      }
    }
    if (workflowRefIds.length > 0) {
      const wfNames = await resolveWorkflowPrincipalLabels(db, workflowRefIds);
      for (const [refId, name] of wfNames) {
        refToName.set(refId, name);
      }
    }
    for (const p of principals) {
      const name = refToName.get(p.refId);
      if (name) principalNames.set(p.id, name);
    }
  }

  return { roleNames, principalNames };
}

/** The native `GrantResponse` item shape for one grant row. */
function formatGrant(row: typeof grant.$inferSelect, names?: ResolvedNames) {
  const parsed = parseGrantRow(row);
  const ts = (d: Date): string => d.toISOString();
  return {
    id: parsed.id,
    tenantId: parsed.tenantId,
    roleId: parsed.roleId ?? null,
    roleName: (parsed.roleId && names?.roleNames.get(parsed.roleId)) ?? null,
    principalId: parsed.principalId ?? null,
    principalName:
      (parsed.principalId && names?.principalNames.get(parsed.principalId)) ??
      null,
    resource: parsed.resource,
    action: parsed.action,
    effect: parsed.effect,
    conditions: parsed.conditions,
    origin: parsed.origin,
    expiresAt: parsed.expiresAt ? ts(parsed.expiresAt) : null,
    createdAt: ts(parsed.createdAt),
    updatedAt: ts(parsed.updatedAt),
  };
}

export function createWorkflowAccessRoutes(
  deps: CreateWorkflowAccessRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const requireGrant: RequireGrant = createRequireGrant({
    grantStore: deps.grantStore,
    conditionRegistry: deps.conditionRegistry,
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        nativeError(
          "unauthorized",
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }

    // Resolve the real tenant + principal rows, exactly like
    // `@intx/hub-api`'s own `createWorkflowRunDeployAuth` does for the
    // deploy route's bearer mirror — `createRequireGrant`'s middleware
    // reads `c.get("principal")`/`c.get("tenant")` as full rows, not a
    // bare id pair.
    const [tenantRow, principalRow] = await Promise.all([
      deps.db.query.tenant.findFirst({ where: eq(tenant.id, scope.tenantId) }),
      deps.db.query.principal.findFirst({
        where: and(
          eq(principal.id, scope.principalId),
          eq(principal.tenantId, scope.tenantId),
        ),
      }),
    ]);
    if (
      tenantRow === undefined ||
      principalRow === undefined ||
      principalRow.status !== "active"
    ) {
      return c.json(
        nativeError(
          "unauthorized",
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }
    c.set("tenant", tenantRow);
    c.set("principal", principalRow);
    await next();
  });

  app.get("/principals", requireGrant("principal:*", "read"), async (c) => {
    const tenantCtx = c.get("tenant");
    const kind = c.req.query("kind");
    const status = c.req.query("status");
    const { limit, cursor } = parsePageParams({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });

    const conditions = [eq(principal.tenantId, tenantCtx.id)];
    if (kind === "user" || kind === "agent" || kind === "workflow") {
      conditions.push(eq(principal.kind, kind));
    }
    if (
      status === "active" ||
      status === "suspended" ||
      status === "invited" ||
      status === "deactivated"
    ) {
      conditions.push(eq(principal.status, status));
    } else {
      // Exclude deactivated principals by default, like the native list.
      conditions.push(ne(principal.status, "deactivated"));
    }
    if (cursor) {
      conditions.push(
        or(
          lt(principal.createdAt, new Date(cursor.t)),
          and(
            eq(principal.createdAt, new Date(cursor.t)),
            lt(principal.id, cursor.id),
          ),
        ) ?? sql`false`,
      );
    }

    const rows = await deps.db.query.principal.findMany({
      where: and(...conditions),
      orderBy: [desc(principal.createdAt), desc(principal.id)],
      limit,
    });

    const assignments =
      rows.length > 0
        ? await deps.db.query.principalRole.findMany({
            where: (pr, { inArray }) =>
              inArray(
                pr.principalId,
                rows.map((p) => p.id),
              ),
          })
        : [];
    const assignedRoleIds = [...new Set(assignments.map((a) => a.roleId))];
    const assignedRoles =
      assignedRoleIds.length > 0
        ? await deps.db.query.role.findMany({
            where: (r, { inArray }) => inArray(r.id, assignedRoleIds),
          })
        : [];
    const roleMap = new Map(assignedRoles.map((r) => [r.id, r]));
    const rolesByPrincipal = new Map<string, { id: string; name: string }[]>();
    for (const a of assignments) {
      const r = roleMap.get(a.roleId);
      if (!r) continue;
      const list = rolesByPrincipal.get(a.principalId) ?? [];
      list.push({ id: r.id, name: r.name });
      rolesByPrincipal.set(a.principalId, list);
    }

    const userRefIds = rows.filter((p) => p.kind === "user").map((p) => p.refId);
    const workflowRefIds = rows
      .filter((p) => p.kind === "workflow")
      .map((p) => p.refId);
    const identities = new Map<string, { displayName: string; email?: string }>();
    if (userRefIds.length > 0) {
      const users = await deps.db.query.user.findMany({
        where: (u, { inArray }) => inArray(u.id, userRefIds),
      });
      for (const u of users) {
        identities.set(u.id, { displayName: u.name, email: u.email });
      }
    }
    if (workflowRefIds.length > 0) {
      const wfNames = await resolveWorkflowPrincipalLabels(
        deps.db,
        workflowRefIds,
      );
      for (const [refId, displayName] of wfNames) {
        identities.set(refId, { displayName });
      }
    }

    const items = rows.map((p) => {
      const identity = identities.get(p.refId);
      return {
        id: p.id,
        tenantId: p.tenantId,
        kind: p.kind,
        refId: p.refId,
        displayName: identity?.displayName ?? p.refId,
        ...(identity?.email ? { email: identity.email } : {}),
        status: p.status,
        roles: rolesByPrincipal.get(p.id) ?? [],
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      };
    });

    return c.json(pageResponse(items, rows, limit));
  });

  app.get("/grants", requireGrant("grant:*", "read"), async (c) => {
    const tenantCtx = c.get("tenant");
    const principalId = c.req.query("principalId");
    const roleId = c.req.query("roleId");
    const resource = c.req.query("resource");
    const effect = c.req.query("effect");
    const { limit, cursor } = parsePageParams({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });

    const conditions = [eq(grant.tenantId, tenantCtx.id)];
    if (principalId) conditions.push(eq(grant.principalId, principalId));
    if (roleId) conditions.push(eq(grant.roleId, roleId));
    if (resource) conditions.push(eq(grant.resource, resource));
    if (effect === "allow" || effect === "deny" || effect === "ask") {
      conditions.push(eq(grant.effect, effect));
    }
    if (cursor) {
      conditions.push(
        or(
          lt(grant.createdAt, new Date(cursor.t)),
          and(
            eq(grant.createdAt, new Date(cursor.t)),
            lt(grant.id, cursor.id),
          ),
        ) ?? sql`false`,
      );
    }

    const rows = await deps.db.query.grant.findMany({
      where: and(...conditions),
      orderBy: [desc(grant.createdAt), desc(grant.id)],
      limit,
    });

    const names = await resolveGrantNames(deps.db, rows);
    return c.json(
      pageResponse(
        rows.map((g) => formatGrant(g, names)),
        rows,
        limit,
      ),
    );
  });

  app.post("/grants", requireGrant("grant:*", "create"), async (c) => {
    const tenantCtx = c.get("tenant");
    const callerPrincipal = c.get("principal");
    // The native `CreateGrant` body: exactly one target, one action.
    const body = CreateGrant(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(nativeError("bad_request", body.summary), 400);
    }

    const outside = await pairOutsideCeiling(
      deps,
      callerPrincipal.id,
      tenantCtx.id,
      body.resource,
      body.action,
    );
    if (outside) {
      return c.json(
        nativeError(
          "forbidden",
          `Cannot grant "${body.resource}" "${body.action}": exceeds the caller's own authority`,
        ),
        403,
      );
    }

    if (body.principalId != null) {
      const target = await deps.db.query.principal.findFirst({
        where: and(
          eq(principal.id, body.principalId),
          eq(principal.tenantId, tenantCtx.id),
        ),
      });
      if (target === undefined) {
        return c.json(
          nativeError(
            "not_found",
            `No principal "${body.principalId}" in this tenant`,
          ),
          404,
        );
      }
    }

    const now = new Date();
    const [row] = await deps.db
      .insert(grant)
      .values({
        id: generateId("grant"),
        tenantId: tenantCtx.id,
        roleId: body.roleId ?? null,
        principalId: body.principalId ?? null,
        resource: body.resource,
        action: body.action,
        effect: body.effect,
        conditions: body.conditions ?? null,
        // The invoking human's authority delegated this grant: the
        // tool declares `approval: "ask"`, so a human already
        // approved this exact principal/resource/action triple
        // before this route ever ran.
        origin: body.origin,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (row === undefined) {
      return c.json(nativeError("not_found", "Grant not found"), 404);
    }

    const names = await resolveGrantNames(deps.db, [row]);
    return c.json(formatGrant(row, names), 201);
  });

  app.delete(
    "/grants/:grantId",
    requireGrant(idResource("grant", "grantId"), "manage"),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const callerPrincipal = c.get("principal");
      const grantId = c.req.param("grantId");
      const target = await deps.db.query.grant.findFirst({
        where: and(eq(grant.id, grantId), eq(grant.tenantId, tenantCtx.id)),
      });
      if (target === undefined) {
        return c.json(nativeError("not_found", "Grant not found"), 404);
      }

      const outside = await pairOutsideCeiling(
        deps,
        callerPrincipal.id,
        tenantCtx.id,
        target.resource,
        target.action,
      );
      if (outside) {
        return c.json(
          nativeError(
            "forbidden",
            `Cannot revoke "${target.resource}" "${target.action}": exceeds the caller's own authority`,
          ),
          403,
        );
      }

      const deleted = await deps.db
        .delete(grant)
        .where(and(eq(grant.id, grantId), eq(grant.tenantId, tenantCtx.id)))
        .returning();
      if (deleted.length === 0) {
        return c.json(nativeError("not_found", "Grant not found"), 404);
      }
      return c.body(null, 204);
    },
  );

  return app;
}
