import { eq } from "drizzle-orm";
import { sha256 } from "@intx/crypto";
import type { DB } from "@intx/db";
import { sidecar, workflowRun } from "@intx/db/schema";

// The one concrete `WorkflowRunAuthenticator` every workflow-run-authenticated
// Corbits surface takes structurally (`@corbits/artifacts`'
// `mountWorkflowArtifacts`): a sidecar bearer token + run address resolve to
// the tenant/principal/run it names.
export function createWorkflowRunAuthenticator(deps: { db: DB["db"] }) {
  return {
    async resolve(token: string, runAddress: string) {
      if (token === "" || runAddress === "") return null;
      const tokenHash = await sha256(token);
      const sidecarRow = await deps.db.query.sidecar.findFirst({
        where: eq(sidecar.tokenHashSha256, tokenHash),
      });
      if (sidecarRow === undefined) return null;
      const run = await deps.db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, runAddress),
      });
      if (run === undefined || run.principalId === null) return null;
      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}
