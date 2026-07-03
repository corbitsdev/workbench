import { toHumanLabel } from "@workbench/ui";
import type { WorkflowDeployment } from "../hooks/use-workflow";

export interface DeployedWorkflowSummary {
  kind: string;
  label: string;
  description?: string;
}

// One entry per deployed kind, carrying the workflow's display label +
// description from the deploy meta (falling back to a humanized kind when an
// older deployment has no meta label). Deployments arrive newest-first; a
// later row's real meta label upgrades a humanized fallback.
export function dedupeDeployedWorkflows(
  deployments: readonly WorkflowDeployment[],
): DeployedWorkflowSummary[] {
  const byKind = new Map<string, DeployedWorkflowSummary>();
  for (const deployment of deployments) {
    const metaLabel = deployment.meta?.label;
    const metaDescription = deployment.meta?.description;
    const existing = byKind.get(deployment.kind);
    const isFallback =
      existing !== undefined &&
      existing.label === toHumanLabel(deployment.kind);
    if (existing === undefined || (isFallback && metaLabel !== undefined)) {
      byKind.set(deployment.kind, {
        kind: deployment.kind,
        label: metaLabel ?? toHumanLabel(deployment.kind),
        ...(metaDescription !== undefined
          ? { description: metaDescription }
          : {}),
      });
    }
  }
  return [...byKind.values()];
}
