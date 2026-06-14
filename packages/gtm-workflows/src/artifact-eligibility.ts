// Which artifact kinds can seed a new workflow run. This is a workflow product
// rule, so it lives in the workflow package rather than in the artifact UI
// components that render the "Use in Workflow" affordance.

export const WORKFLOW_ELIGIBLE_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  'pain-points',
  'call-transcript',
]);

export function canUseArtifactInWorkflow(kind: string): boolean {
  return WORKFLOW_ELIGIBLE_ARTIFACT_KINDS.has(kind);
}
