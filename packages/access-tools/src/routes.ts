// Workflow-run-authenticated principal + grant surface: the execution
// half of `@corbits/access-tools`' `list_principals`, `list_grants`,
// `grant_access`, and `revoke_access` tools. A workflow child has no
// browser session, only its sidecar bearer token and its own run
// address, so it authenticates through a `WorkflowRunAuthenticator`
// rather than the tenant-session pipeline `@intx/hub-api`'s own
// `/api/tenants/:tenantId/principals` and `/grants` routes use — the
// same reasoning `@corbits/agent-directory`'s workflow-capability-routes
// and `@corbits/chat`'s workflow-participant-routes give for their own
// bearer-authenticated mirrors.
//
// Mounted OUTSIDE the tenant prefix for that reason, at
// `/api/workflow-access`. Every write is scoped to the authenticated
// run's own tenant/principal alone — identity never rides in a request
// body.
//
// This is a thin wrapper, not a reimplementation: authorization for
// every route below runs through `@intx/hub-api`'s own
// `createRequireGrant` against the SAME grant store and condition
// registry the tenant-session routes gate on, resolved for the caller's
// real principal row (fetched once here, exactly like
// `@intx/hub-api`'s own `createWorkflowRunDeployAuth` resolves the
// deploy route's bearer mirror). A principal the tenant hasn't granted
// `principal:*`/`grant:*` gets a real 403 from the real grant store, not
// a bundle-local approximation.
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type } from "arktype";

import type { DB } from "@intx/db";
import { grant, principal, tenant } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import {
  createRequireGrant,
  idResource,
  type RequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import { authorize } from "@intx/authz";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import { makeErrorEnvelope } from "@corbits/error-sink";

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

export interface ListedPrincipal {
  readonly id: string;
  readonly kind: "user" | "agent" | "workflow";
  readonly refId: string;
  readonly status: "active" | "suspended" | "invited" | "deactivated";
}

export interface ListedGrant {
  readonly id: string;
  readonly principalId: string | null;
  readonly resource: string;
  readonly action: string;
  readonly effect: "allow" | "deny" | "ask";
}

function formatPrincipal(row: typeof principal.$inferSelect): ListedPrincipal {
  return {
    id: row.id,
    kind: row.kind,
    refId: row.refId,
    status: row.status,
  };
}

function formatGrant(row: typeof grant.$inferSelect): ListedGrant {
  return {
    id: row.id,
    principalId: row.principalId ?? null,
    resource: row.resource,
    action: row.action,
    effect: row.effect,
  };
}

const GrantAccessInput = type({
  principalId: "string > 0",
  resource: "string > 0",
  actions: type("string > 0").array().atLeastLength(1),
});

export type CreateWorkflowAccessRoutesDeps = {
  db: DB["db"];
  authenticator: WorkflowRunAuthenticator;
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

// A caller may only grant (or revoke) authority it already holds itself —
// otherwise `grant:*`/`create` alone would let any principal escalate past
// its own ceiling. Reuses `@intx/authz`'s own `authorize` against the same
// grant store `requireGrant` checks against, per requested pair.
async function firstPairOutsideCeiling(
  deps: Pick<
    CreateWorkflowAccessRoutesDeps,
    "grantStore" | "conditionRegistry"
  >,
  callerPrincipalId: string,
  tenantId: string,
  resource: string,
  actions: readonly string[],
): Promise<string | null> {
  for (const action of actions) {
    const result = await authorize(
      deps.grantStore,
      callerPrincipalId,
      tenantId,
      resource,
      action,
      deps.conditionRegistry,
    );
    if (result.effect !== "allow") {
      return action;
    }
  }
  return null;
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
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
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
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("tenant", tenantRow);
    c.set("principal", principalRow);
    await next();
  });

  app.get("/principals", requireGrant("principal:*", "read"), async (c) => {
    const tenantCtx = c.get("tenant");
    const rows = await deps.db.query.principal.findMany({
      where: eq(principal.tenantId, tenantCtx.id),
    });
    return c.json({ principals: rows.map(formatPrincipal) });
  });

  app.get("/grants", requireGrant("grant:*", "read"), async (c) => {
    const tenantCtx = c.get("tenant");
    const principalId = c.req.query("principalId");
    const resource = c.req.query("resource");
    const conditions = [eq(grant.tenantId, tenantCtx.id)];
    if (principalId) conditions.push(eq(grant.principalId, principalId));
    if (resource) conditions.push(eq(grant.resource, resource));
    const rows = await deps.db.query.grant.findMany({
      where: and(...conditions),
    });
    return c.json({ grants: rows.map(formatGrant) });
  });

  app.post("/grants", requireGrant("grant:*", "create"), async (c) => {
    const tenantCtx = c.get("tenant");
    const callerPrincipal = c.get("principal");
    const body = GrantAccessInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid grant request: ${body.summary}`,
        }),
        400,
      );
    }

    const disallowedAction = await firstPairOutsideCeiling(
      deps,
      callerPrincipal.id,
      tenantCtx.id,
      body.resource,
      body.actions,
    );
    if (disallowedAction !== null) {
      return c.json(
        makeErrorEnvelope({
          code: "forbidden",
          userMessage: `Cannot grant "${body.resource}" "${disallowedAction}": exceeds the caller's own authority`,
        }),
        403,
      );
    }

    const target = await deps.db.query.principal.findFirst({
      where: and(
        eq(principal.id, body.principalId),
        eq(principal.tenantId, tenantCtx.id),
      ),
    });
    if (target === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: `No principal "${body.principalId}" in this tenant`,
        }),
        404,
      );
    }

    const now = new Date();
    const rows = await deps.db
      .insert(grant)
      .values(
        body.actions.map((action) => ({
          id: generateId("grant"),
          tenantId: tenantCtx.id,
          roleId: null,
          principalId: body.principalId,
          resource: body.resource,
          action,
          effect: "allow" as const,
          conditions: null,
          // The invoking human's authority delegated this grant: the
          // tool declares `approval: "ask"`, so a human already
          // approved this exact principal/resource/actions triple
          // before this route ever ran.
          origin: "invoker" as const,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();

    return c.json({ grants: rows.map(formatGrant) }, 201);
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
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `No grant "${grantId}" in this tenant`,
          }),
          404,
        );
      }

      const disallowedAction = await firstPairOutsideCeiling(
        deps,
        callerPrincipal.id,
        tenantCtx.id,
        target.resource,
        [target.action],
      );
      if (disallowedAction !== null) {
        return c.json(
          makeErrorEnvelope({
            code: "forbidden",
            userMessage: `Cannot revoke "${target.resource}" "${target.action}": exceeds the caller's own authority`,
          }),
          403,
        );
      }

      const deleted = await deps.db
        .delete(grant)
        .where(and(eq(grant.id, grantId), eq(grant.tenantId, tenantCtx.id)))
        .returning();
      if (deleted.length === 0) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `No grant "${grantId}" in this tenant`,
          }),
          404,
        );
      }
      return c.body(null, 204);
    },
  );

  return app;
}
