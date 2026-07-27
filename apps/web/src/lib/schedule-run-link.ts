import { deepLinkPath } from "@workbench/shared";

/** Match WorkflowRunHistory: awaiting runs open the live gate; others open trace. */
export function scheduleRunDeepLink(status: string, runId: string): string {
  if (status === "awaiting") return deepLinkPath("workflow_run", runId);
  return deepLinkPath("workflow_trace", runId);
}
