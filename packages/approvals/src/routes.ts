import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import { authorize } from "@intx/authz";
import type { DB } from "@intx/db";
import { schema, parseApprovalRow } from "@intx/db";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import type { TenantEnv } from "@intx/hub-api";

import { hydrateNeedsYou } from "./view-model";

export type CreateNeedsYouRoutesDeps = {
  db: DB["db"];
  grantStore: GrantStore;
  conditionRegistry: ConditionRegistry;
};

/**
 * The one net-new domain concept this package adds: a display-ready read of
 * "what needs this tenant's attention right now." It never creates, resolves,
 * or claims anything -- approving and rejecting stay on Interchange's own
 * `/api/tenants/:tenantId/approvals/:approvalId/{approve,reject}` routes,
 * whose authorize + claimTerminal + approvalStore.resolve transaction is
 * already exactly-once and already grant-scoped. Reimplementing that
 * machinery here would be the parallel gate concept the design explicitly
 * rejects; this route only adds the naming layer that machinery has no
 * reason to own.
 */
export function createNeedsYouRoutes(
  deps: CreateNeedsYouRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");

    // Same grant and action the native list/resolve routes require --
    // whoever can resolve a tenant's approvals is who "needs you" is for.
    // Reusing this string keeps the two surfaces from drifting apart.
    const authz = await authorize(
      deps.grantStore,
      principal.id,
      tenant.id,
      "approval:*",
      "resolve",
      deps.conditionRegistry,
    );
    if (authz.effect !== "allow") {
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "You do not have permission to see this bench's approvals",
          },
        },
        403,
      );
    }

    const rows = await deps.db.query.approval.findMany({
      where: and(
        eq(schema.approval.tenantId, tenant.id),
        eq(schema.approval.status, "pending"),
      ),
      orderBy: (row, { asc }) => [asc(row.createdAt)],
    });

    const items = await hydrateNeedsYou(deps.db, rows.map(parseApprovalRow));
    return c.json({ items });
  });

  // A single approval's display-safe status, in any status (not just
  // pending) -- an in-chat approve card's live read. Gated by the same
  // tenant-wide `approval:*`/"resolve" grant as the list above, which is
  // deliberately coarser than the native routes' per-deployment
  // `approval:<deploymentId>`/"resolve" check: a principal scoped to one
  // deployment's approvals can still resolve them there even after a 403
  // here. Callers must treat that 403 as "could not determine," never as
  // "cannot act" -- see `packages/chat-ui/src/blocks/approve-card-state.ts`.
  //
  // Authorization runs before the existence lookup -- deliberately unlike
  // the native detail route's not-found-masks-cross-tenant precedent (that
  // route's grant is per-approval, so it must load the row first to know
  // which deployment to check). This grant is tenant-wide and independent
  // of the target id, so checking it first means an unauthorized caller
  // always sees 403, never learning from a 404-vs-403 split whether some
  // id exists in this tenant.
  app.get("/:approvalId", async (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const approvalId = c.req.param("approvalId");

    const authz = await authorize(
      deps.grantStore,
      principal.id,
      tenant.id,
      "approval:*",
      "resolve",
      deps.conditionRegistry,
    );
    if (authz.effect !== "allow") {
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "You do not have permission to see this approval",
          },
        },
        403,
      );
    }

    const row = await deps.db.query.approval.findFirst({
      where: and(
        eq(schema.approval.id, approvalId),
        eq(schema.approval.tenantId, tenant.id),
      ),
    });
    if (row === undefined) {
      return c.json(
        { error: { code: "not_found", message: "Approval not found" } },
        404,
      );
    }

    const [item] = await hydrateNeedsYou(deps.db, [parseApprovalRow(row)]);
    if (item === undefined) {
      return c.json(
        { error: { code: "not_found", message: "Approval not found" } },
        404,
      );
    }
    return c.json(item);
  });

  return app;
}
