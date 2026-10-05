import { createSidecarCredentialResolver } from "@intx/hub-sessions";
import type { DB } from "@intx/db";
import { eq } from "drizzle-orm";
import { workflowRun } from "@intx/db/schema";

// The one concrete `WorkflowRunAuthenticator` every workflow-run-authenticated
// Corbits surface takes structurally (`@corbits/artifacts`'
// `mountWorkflowArtifacts`): a sidecar bearer token + run address resolve to
// the tenant/principal/run it names. The token must belong to a live
// allocation, and the run must be that allocation's anchor run or one of its
// children, in the allocation's tenant.
export function createWorkflowRunAuthenticator(deps: { db: DB["db"] }) {
  const sidecars = createSidecarCredentialResolver({ db: deps.db });
  return {
    async resolve(token: string, runAddress: string) {
      if (token === "" || runAddress === "") return null;
      const identity = await sidecars.resolve(token);
      if (identity?.kind !== "allocated") return null;
      const run = await deps.db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, runAddress),
      });
      if (run === undefined || run.principalId === null) return null;
      if (run.tenantId !== identity.tenantId) return null;
      if (run.anchorRunId !== identity.anchorRunId) return null;
      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}
