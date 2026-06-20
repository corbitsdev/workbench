# @workbench/gtm-workflows

Artifact-eligibility helpers shared between the hub and the web app. This package
no longer defines workflows: workflows are native `@intx/workflow` packages under
`workflows/<kind>/` (see [docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md)).
The former `WorkflowType` definitions and the `@workbench/workflow-core` registry
were removed in the native-runtime cutover.

## Exports

`src/index.ts` exports only artifact-eligibility helpers:

- `WORKFLOW_ACCEPTED_ARTIFACT_KINDS` — the artifact kinds each workflow kind accepts as a source
- `canUseArtifactInWorkflow` / `workflowAcceptsArtifactKind` — whether a given artifact kind is a valid input
- `workflowsAcceptingArtifactKind` — which workflow kinds accept a given artifact kind
- `sourceArtifactKindSkipsAnalysis` — whether a source artifact kind bypasses the analysis step

These are pure functions used to decide which artifacts a user may pick as input
for a workflow run; they carry no execution logic.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
