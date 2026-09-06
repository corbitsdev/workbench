// Resolves a provisioned run's session id off its own launch spec
// (`workflow_run_launch_spec.session_id`, written once at provision by
// every native launcher's `recordAgentSessionAtProvision` — CL-7481)
// rather than Interchange's principal-keyed `resolveRunSessionId`. A
// run's session id is fixed at provision time and never changes; its
// principal is not assigned until the run's first trigger anchors one,
// so a principal-keyed lookup returns nothing for exactly the run states
// (freshly provisioned, un-anchored) chat most needs to resolve.
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowRunLaunchSpec } from "@intx/db/schema";

export async function resolveRunSessionIdOrThrow(
  db: DB["db"],
  run: { id: string },
): Promise<string> {
  const launchSpecRow = await db.query.workflowRunLaunchSpec.findFirst({
    where: eq(workflowRunLaunchSpec.anchorRunId, run.id),
  });
  if (launchSpecRow === undefined) {
    throw new Error(
      `no workflow_run_launch_spec for run "${run.id}"; provision may not have completed`,
    );
  }
  return launchSpecRow.sessionId;
}
