// Per-step storage path derivation for the workflow-process child:
// where a step invocation's agent-state storage and workspace root on
// the sidecar's local disk, for the cold per-run/step/attempt keying,
// the per-run reclamation root, and the warm single-step agent's
// stable per-agent keying.

import path from "node:path";

import type { RepoId } from "@intx/hub-sessions/substrate";

/**
 * Root directory for a single step invocation's agent-state storage and
 * workspace, derived from the sidecar data dir and the run/step/attempt
 * coordinates the workflow runtime owns.
 *
 * The per-step agent storage is a distinct isogit repo, deliberately
 * rooted OUTSIDE the workflow-run repo's working tree. The workflow-run
 * repo's single writer is the supervisor, and its working tree carries
 * the run-event log under `runs/<runId>/events/...`; nesting a second
 * git repo inside that tree would collide with the event subtree and
 * with the supervisor's write contract. Rooting the per-step store under
 * a dedicated `workflow-step-state/` sibling subtree keyed by the
 * workflow-run repo id keeps every step's storage isolated per run and
 * per step while never touching the run-event tree.
 */
export function stepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
  stepId: string;
  attempt: number;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "runs",
    args.runId,
    "steps",
    args.stepId,
    `attempt-${String(args.attempt)}`,
  );
}

/**
 * Root directory for a single workflow-run subtree's per-step scratch:
 * `<dataDir>/workflow-step-state/<repoId>/runs/<runId>/`. The cold
 * (multi-step) path's per-step `stepStorageRoot` nests under this, so
 * reclaiming this subtree on run completion drops every step/attempt the
 * run produced in one `rm -rf`. Kept distinct from `stepStorageRoot` so
 * the deletion granularity (a whole run, not a single step/attempt) is
 * expressed at the call site that owns run-completion cleanup.
 */
export function runStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  runId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "runs",
    args.runId,
  );
}

/**
 * Stable per-agent scratch root for the WARM single-step agent's
 * workspace + tool materialization (tarball-cache + apply-state). Keyed
 * by the step identity exactly like the durable conversation store's
 * `agent-conversation-state/<repoId>/<agentKey>/` (conversation-state.ts),
 * NOT by the arbitrary first-message runId. Keying it stably is what
 * bounds the warm case: the cached agent reuses ONE workspace across
 * every message in the child's lifetime, and that same workspace is
 * re-derived (and so survives) across a child respawn, instead of
 * stranding a fresh per-runId subtree each time. The whole subtree is
 * reclaimed on undeploy, when the deployment's supervisor + child are
 * already torn down. Rooted under a `warm/` sibling of the cold `runs/`
 * subtree so the undeploy sweep of `workflow-step-state/<repoId>/`
 * reclaims both with one removal and the two keyings never collide.
 */
/**
 * Stable per-action-step scratch root for the action-handler registry's
 * tool materialization (tarball-cache + apply-state + workspace). An
 * action step's tool closure is materialized ONCE, at deployment
 * establish (registry construction), and its handler dispatches against
 * that closure across every run -- so the keying is per step, not per
 * run/attempt. Rooted under an `action/` sibling of the cold `runs/`
 * and warm `warm/` sub-roots so no reclamation sweep collides with it;
 * the undeploy sweep of `workflow-step-state/<repoId>/` reclaims all
 * three with one removal.
 */
export function actionStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  stepId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "action",
    encodeURIComponent(args.stepId),
  );
}

export function warmStepStorageRoot(args: {
  dataDir: string;
  workflowRunRepoId: RepoId;
  stepId: string;
}): string {
  return path.join(
    args.dataDir,
    "workflow-step-state",
    args.workflowRunRepoId.id,
    "warm",
    encodeURIComponent(args.stepId),
  );
}
