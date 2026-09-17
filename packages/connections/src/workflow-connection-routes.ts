// What is left of the workflow-run connections mirror: the MCP-server
// registry `@corbits/mcp-tools` resolves a `mcp:<slug>` server's URL
// through. MCP servers are not a stock Interchange concept, so there is no
// stock route to read them from; CL-8164 moves MCP server configuration into
// the connections/OAuth library and retires this mount with it.
//
// `GET /connections` is gone: `@corbits/connections-tools` now reads live
// connections from the stock tenant provider and credential routes with the
// run bearer (CL-8159).
//
// A workflow child has no browser session, only its sidecar bearer token and
// its own run address, so it authenticates through a
// `WorkflowRunAuthenticator`. Mounted OUTSIDE the tenant prefix for that
// reason, at `/api/workflow-connections`. Identity NEVER rides in a request
// body: the tenant the read is scoped to comes from the authenticated run
// alone.
import { Hono } from "hono";

import type { McpServerConnection } from "./mcp-server-store";

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

export type CreateWorkflowConnectionRoutesDeps = {
  readonly authenticator: WorkflowRunAuthenticator;
  /** Backs `GET /mcp-servers` (`@corbits/mcp-tools`' `mcp_list_servers`):
   * every `mcp:<slug>` server this tenant has connected. `apps/hub`
   * supplies `@corbits/connections`' own `listMcpServerConnections`
   * (`mcp-server-store.ts`) — a direct DB read, since this route has no
   * tenant-session cookies to reuse `./mcp-server-routes.ts`'s hub-HTTP
   * listing. */
  readonly listMcpServers: (
    tenantId: string,
  ) => Promise<readonly McpServerConnection[]>;
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

  app.get("/mcp-servers", async (c) => {
    const scope = c.get("workflowConnectionScope");
    const servers = await deps.listMcpServers(scope.tenantId);
    return c.json({ data: servers }, 200);
  });

  return app;
}
