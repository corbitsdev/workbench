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
      const sidecar = await sidecars.resolve(token);
      if (sidecar === null || sidecar.retired === true) return null;
      const bindings = await sidecars.resolveBindings(sidecar.sidecarId);
      const run = await deps.db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, runAddress),
      });
      if (run === undefined || run.principalId === null) return null;
      const matches = bindings.some(
        (identity) =>
          identity.kind === "allocated" &&
          identity.tenantId === run.tenantId &&
          identity.anchorRunId === run.anchorRunId,
      );
      if (!matches) return null;
      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}
