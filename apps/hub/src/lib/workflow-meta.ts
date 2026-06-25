import { type } from 'arktype';

// Deploy-time provenance captured at workflow deploy and persisted on the
// workflow_run row (CL-2321): the workflow package version, the repo git short
// SHA, and the ISO timestamp of the deploy. Shared by the deploy script, the
// deploy route, the run-list route, and the projection bridge so all four agree
// on the on-the-wire shape. The web side (apps/web/src/hooks/use-workflow.ts)
// re-declares the same shape rather than importing this — the two build graphs
// don't share apps/hub source, so a literal import isn't free; keep the two in
// sync by hand. `deployedAt` is constrained to ISO because the deploy CLI sends
// `new Date().toISOString()`.
export const WorkflowMeta = type({
  version: 'string',
  sha: 'string',
  deployedAt: 'string.date.iso',
});
export type WorkflowMeta = typeof WorkflowMeta.infer;
