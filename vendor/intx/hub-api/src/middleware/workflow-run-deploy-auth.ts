// WORKBENCH DELTA (see VENDORED.md): a bearer-authenticated mirror of the
// session-cookie path onto the SAME `/api/tenants/:tenantId/workflows/deployments`
// route `../routes/workflows.ts` already mounts. A workflow-run agent has no
// browser session -- only its sidecar bearer token and its own run address,
// exactly the credential every other workflow-run write surface (skills,
// capabilities, routines, agent-directory) already authenticates with via a
// `WorkflowRunAuthenticator`.
//
// Mounted ahead of `createResolveTenant` in `../app.ts` (which short-circuits
// once `principal`+`tenant` are already set on the context -- see that
// module's own bearer-mount comments for the asset/git-token routes this
// mirrors). A bearer-authenticated request therefore reaches the EXACT SAME
// deploy handler as a human session: same `requireGrant("workflow:*",
// "create")` check, same install/probe/gate/freeze path. No deploy logic is
// duplicated here -- this file only resolves identity.
//
// A request with no bearer credential falls through unchanged to the session
// path (`await next()` with nothing set); only a PRESENT-but-invalid bearer
// credential fails closed with 401, rather than silently retrying as a
// session.
//
// The `:tenantId` path segment is never trusted here. The resolved run's own
// tenant is set unconditionally from the authenticated scope, exactly like
// every other workflow-run write route binds to `run.tenantId` alone. A
// caller cannot widen its own scope by putting a different tenantId in the
// URL: nothing downstream reads that segment once `tenant`/`principal` are
// set from this middleware.
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";

import type { DB } from "@intx/db";
import { principal, tenant } from "@intx/db/schema";

import type { TenantEnv } from "../context";

/**
 * The tenant + principal a presented sidecar token and run address resolve
 * to. Declared structurally, matching `@corbits/skills`' and
 * `@corbits/agent-directory`'s own `WorkflowRunAuthenticator` shapes, so this
 * vendored package carries no dependency on the workbench artifacts plane;
 * `apps/hub` supplies `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`,
 * which satisfies this shape exactly (its extra `runId` field is ignored).
 */
export type WorkflowRunDeployScope = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowRunDeployScope | null>;
};

export type CreateWorkflowRunDeployAuthDeps = {
  db: DB["db"];
  authenticator: WorkflowRunAuthenticator;
};

function unauthorized(message: string) {
  return {
    error: { code: "unauthorized" as const, message },
  };
}

export function createWorkflowRunDeployAuth({
  db,
  authenticator,
}: CreateWorkflowRunDeployAuthDeps): MiddlewareHandler<TenantEnv> {
  return createMiddleware<TenantEnv>(async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const address = c.req.header("x-workflow-run-address");

    // No bearer credential presented at all: this is a session-cookie
    // request, unchanged. Let it fall through to `createResolveTenant`.
    if (!authHeader.startsWith("Bearer ") || address === undefined) {
      await next();
      return;
    }

    const token = authHeader.slice("Bearer ".length);
    const scope = await authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        unauthorized(
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }

    const [tenantRow, principalRow] = await Promise.all([
      db.query.tenant.findFirst({ where: eq(tenant.id, scope.tenantId) }),
      db.query.principal.findFirst({
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
        unauthorized(
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }

    c.set("tenant", tenantRow);
    c.set("principal", principalRow);
    await next();
  });
}
