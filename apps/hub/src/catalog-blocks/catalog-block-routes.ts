// The on-demand catalog-workflow deploy surface (CL-6405, generalized by
// CL-7073 to any catalog entry — CL-8156 dropped the "template" naming
// once workbench template picking was deleted): `POST /:assetName/deploy`
// deploys a `workflows/<name>` package's block as a real `workflow`-kind
// asset on the requesting tenant, the same surface the "Available"
// catalog-workflows section (`apps/web`'s routines page) drives.
// Mounted per-tenant inside the platform's native tenant middleware,
// mirroring `./connect-github-routes.ts`: every side effect a host needs
// — the tenant's default inference preferences, and the actual
// source-form asset write + `workflow_definition` projection — arrives
// as an injected port, so `apps/hub` is the only place drizzle and the
// `AssetService` are touched and this stays testable with plain fakes.
import { Hono } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope } from "@corbits/error-sink";

import {
  buildBlockWorkflowSource,
  type BlockWorkflowBuildInput,
} from "./block-workflows";

const DEPLOY_FAILED_MESSAGE =
  "Couldn't set up this workflow. Try again in a moment.";

export type CatalogBlockRoutesDeps = {
  requireGrant: RequireGrant;
  /** Where a failure's real cause goes — the same CL-6360 idiom
   * `./connect-github-routes.ts` documents: the client sees one honest
   * `userMessage`, the raw detail lands here. */
  log: (line: string) => void;
  /** The tenant's default inference preferences — the same resolution a
   * fresh agent launch resolves against, so a deployed block runs on the
   * model the bench actually connected. */
  inferencePreferences(
    tenantId: string,
  ): Promise<BlockWorkflowBuildInput["inferencePreferences"]>;
  /** The source-form deploy itself: renders `workflowJson` into a
   * `@corbits/workflows`'s `./source` tree on a `workflow`-kind asset and
   * projects it onto a `workflow_definition` row — the exact
   * materialization `createAgentDefinitionCore` runs for a participant
   * agent, minus its agent-only prompt/skills machinery. `created` is
   * `false` when the tenant already carries a deployed definition under
   * `assetName` (the port skips instead of double-deploying). */
  deployWorkflowSource(args: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly assetName: string;
    readonly displayName: string;
    readonly workflowJson: string;
  }): Promise<{ readonly id: string; readonly created: boolean }>;
};

export function createCatalogBlockRoutes(
  deps: CatalogBlockRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post(
    "/:assetName/deploy",
    deps.requireGrant("workflow:*", "create"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const assetName = c.req.param("assetName");

      const source = buildBlockWorkflowSource(assetName, {
        tenantDomain: tenant.domain,
        inferencePreferences: await deps.inferencePreferences(tenant.id),
      });
      if (source === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `"${assetName}" isn't a deployable catalog workflow.`,
          }),
          404,
        );
      }

      try {
        const result = await deps.deployWorkflowSource({
          tenantId: tenant.id,
          principalId: principal.id,
          assetName: source.assetName,
          displayName: source.displayName,
          workflowJson: source.workflowJson,
        });
        return c.json(
          { id: result.id, created: result.created },
          result.created ? 201 : 200,
        );
      } catch (cause) {
        // report-error-ignore: the client sees one honest userMessage
        // below; the real cause goes to deps.log, the same CL-6360 idiom
        // `./connect-github-routes.ts` documents.
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `catalog-blocks: deploying "${assetName}" failed for tenant ${tenant.id}: ${message}`,
        );
        return c.json(
          makeErrorEnvelope({
            code: "deploy_failed",
            userMessage: DEPLOY_FAILED_MESSAGE,
          }),
          500,
        );
      }
    },
  );

  return app;
}
