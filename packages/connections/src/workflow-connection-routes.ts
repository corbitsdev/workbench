// The sanctioned path for a workflow-process child (Myra, or any
// conversational agent) to see which third-party connections this
// workbench has live, and to hand a human a link to connect one that
// isn't — CL-myra-manager-tools. Mirrors `@corbits/agent-directory`'s
// `createWorkflowCapabilityRoutes` and `@corbits/skills`'
// `createWorkflowSkillRoutes`: a workflow child has no browser session,
// only its sidecar bearer token and its own run address, so it
// authenticates through a `WorkflowRunAuthenticator` rather than the
// tenant-session pipeline `./routes.ts` uses.
//
// Mounted OUTSIDE the tenant prefix for that reason, at
// `/api/workflow-connections`. Identity NEVER rides in a request body:
// the tenant every read is scoped to come from the authenticated run
// alone.
//
// No `requireGrant` on `GET /connections`, unlike `./routes.ts`'s
// tenant-session routes: this endpoint is read-only (it derives its
// answer from `CONNECTOR_REGISTRY`, a static catalog, and
// `listConnectedProviders`, itself a read) and mutates nothing, so there
// is no write to gate. The companion `request_connection` tool
// (`@corbits/connections-tools`) needs no route at all — it validates a
// connector id against the same `CONNECTOR_REGISTRY` and builds a
// deep-link string, entirely in-process, never touching the network or
// completing OAuth itself — so this file only ever grows the one
// endpoint below.
import { Hono } from "hono";

import { CONNECTOR_REGISTRY } from "./registry";

/**
 * The tenant + principal + run a presented sidecar token and run
 * address resolve to. Declared structurally (mirroring
 * `@corbits/agent-directory`'s `WorkflowCapabilityRunScope` and
 * `@corbits/skills`' `WorkflowRunScope`) rather than importing
 * `@corbits/artifacts-hub`'s concrete type, so this package carries no
 * dependency on the artifacts plane; `apps/hub` supplies
 * `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`, which
 * satisfies this shape exactly (it resolves a superset: `runId` too).
 * Only `tenantId` is read below — `principalId`/`runId` are kept on the
 * shape purely for consistency with the other workflow-run routes.
 */
export type WorkflowConnectionRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowConnectionRunScope | null>;
};

export type WorkflowConnectionsEnv = {
  Variables: { workflowConnectionScope: WorkflowConnectionRunScope };
};

export type ConnectionSummary = {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl: string;
  readonly connected: boolean;
};

export type CreateWorkflowConnectionRoutesDeps = {
  readonly authenticator: WorkflowRunAuthenticator;
  /** A port, not a raw `db` handle — keeps this package decoupled from
   * the credentials schema, mirroring `@corbits/routines`' routes.ts
   * taking ports rather than reaching for database access directly.
   * `apps/hub` supplies `packages/chat/src/inference-preferences.ts`'s
   * `listConnectedProviders(db, tenantId)`, curried over `db`, the same
   * function `listMyraUsableToolPackages` (apps/hub/src/index.ts) is
   * built on. */
  readonly listConnectedProviders: (
    tenantId: string,
  ) => Promise<readonly string[]>;
};

export function createWorkflowConnectionRoutes(
  deps: CreateWorkflowConnectionRoutesDeps,
): Hono<WorkflowConnectionsEnv> {
  const app = new Hono<WorkflowConnectionsEnv>();

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "Missing or unrecognized sidecar bearer token / run address",
          },
        },
        401,
      );
    }
    c.set("workflowConnectionScope", scope);
    await next();
  });

  app.get("/connections", async (c) => {
    const scope = c.get("workflowConnectionScope");
    const connectedIds = new Set(
      await deps.listConnectedProviders(scope.tenantId),
    );
    const connections: ConnectionSummary[] = Object.values(
      CONNECTOR_REGISTRY,
    ).map((descriptor) => ({
      id: descriptor.id,
      displayName: descriptor.displayName,
      docsUrl: descriptor.docsUrl,
      connected: connectedIds.has(descriptor.id),
    }));
    return c.json({ data: connections }, 200);
  });

  return app;
}
