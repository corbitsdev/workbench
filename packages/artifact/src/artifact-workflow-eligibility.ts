// Which artifact kinds each workflow accepts as a starting source. It backs the
// artifact UI's "Use in Workflow" affordance, so it lives beside the artifact
// kinds/visuals it gates rather than in a standalone package.
//
// A workflow either accepts a specific set of artifact kinds or is 'general'
// (accepts any artifact). Pain Point Collateral seeds from a call transcript or
// its extracted pain points; the Gamma presentation creator accepts any artifact
// as source content (its `source` step already supports `transcriptSource:
// 'artifact'`).

type AcceptedArtifactKinds = ReadonlySet<string> | "general";

export const WORKFLOW_ACCEPTED_ARTIFACT_KINDS: Readonly<
  Record<string, AcceptedArtifactKinds>
> = {
  "pain-point-collateral": new Set(["call-transcript", "pain-points"]),
  "gamma-presentation-creator": "general",
};

export function workflowAcceptsArtifactKind(
  workflowKind: string,
  artifactKind: string,
): boolean {
  const accepted = WORKFLOW_ACCEPTED_ARTIFACT_KINDS[workflowKind];
  if (!accepted) return false;
  return accepted === "general" || accepted.has(artifactKind);
}

// Workflow kinds that can be seeded from an artifact of the given kind. Used to
// filter the catalog when "Use in Workflow" is launched from an artifact.
export function workflowsAcceptingArtifactKind(artifactKind: string): string[] {
  return Object.keys(WORKFLOW_ACCEPTED_ARTIFACT_KINDS).filter((workflowKind) =>
    workflowAcceptsArtifactKind(workflowKind, artifactKind),
  );
}

// Whether the "Use in Workflow" affordance should be offered for an artifact:
// true when at least one workflow accepts its kind.
export function canUseArtifactInWorkflow(artifactKind: string): boolean {
  return workflowsAcceptingArtifactKind(artifactKind).length > 0;
}

// Source artifact kinds whose content already represents a completed phase of a
// workflow, so seeding from them must skip that phase rather than redo it.
// Pain Point Collateral's analyze phase produces a 'pain-points' artifact;
// seeding a new run from one means the pain points are already chosen, so the
// run jumps straight to generation instead of re-extracting.
const PAIN_POINT_COLLATERAL_ANALYSIS_SKIP_SOURCE_KINDS: ReadonlySet<string> =
  new Set(["pain-points"]);

// Whether seeding the given workflow from a source artifact of this kind should
// skip the analysis phase and go straight to generation. This is a workflow
// product rule, so it lives beside the artifact-eligibility rules rather than in
// the hub route that wires the workflow creation request.
export function sourceArtifactKindSkipsAnalysis(
  workflowKind: string,
  artifactKind: string,
): boolean {
  if (workflowKind !== "pain-point-collateral") return false;
  return PAIN_POINT_COLLATERAL_ANALYSIS_SKIP_SOURCE_KINDS.has(artifactKind);
}
