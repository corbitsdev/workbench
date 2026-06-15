// Which artifact kinds each workflow accepts as a starting source. This is a
// workflow product rule, so it lives in the workflow package rather than in the
// artifact UI components that render the "Use in Workflow" affordance.
//
// A workflow either accepts a specific set of artifact kinds or is 'general'
// (accepts any artifact). Collateral generation seeds from a call transcript or
// its extracted pain points; presentation generation accepts any artifact as
// source content (its `source` step already supports `transcriptSource:
// 'artifact'`).

type AcceptedArtifactKinds = ReadonlySet<string> | 'general';

export const WORKFLOW_ACCEPTED_ARTIFACT_KINDS: Readonly<Record<string, AcceptedArtifactKinds>> = {
  'collateral-generation': new Set(['call-transcript', 'pain-points']),
  'presentation-generation': 'general',
};

export function workflowAcceptsArtifactKind(workflowKind: string, artifactKind: string): boolean {
  const accepted = WORKFLOW_ACCEPTED_ARTIFACT_KINDS[workflowKind];
  if (!accepted) return false;
  return accepted === 'general' || accepted.has(artifactKind);
}

// Workflow kinds that can be seeded from an artifact of the given kind. Used to
// filter the catalog when "Use in Workflow" is launched from an artifact.
export function workflowsAcceptingArtifactKind(artifactKind: string): string[] {
  return Object.keys(WORKFLOW_ACCEPTED_ARTIFACT_KINDS).filter((workflowKind) =>
    workflowAcceptsArtifactKind(workflowKind, artifactKind)
  );
}

// Whether the "Use in Workflow" affordance should be offered for an artifact:
// true when at least one workflow accepts its kind.
export function canUseArtifactInWorkflow(artifactKind: string): boolean {
  return workflowsAcceptingArtifactKind(artifactKind).length > 0;
}
