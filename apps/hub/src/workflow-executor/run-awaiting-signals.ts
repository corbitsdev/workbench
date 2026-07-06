import {
  createWorkflowRunReader,
  type RepoId,
  type RepoStore,
  type WorkflowRunEvent,
} from "@intx/hub-sessions";
import { resumeFromLog, type WorkflowEvent } from "@intx/workflow";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";

// Read ONLY the open `awaitSignal` gates of a run from its event log (CL-2681):
// the set of signal names the run is currently parked on. Folds the native
// `@intx/workflow` state machine over the log but skips the definition read /
// step classification the full RunState read does — so it is a LEAF module with
// NO app-internal value imports (importing `workflow-runs`/`workflow-deploy`
// from run-exec would close an import cycle via the tool registry). Needs only
// the inner repo store and is sidecar-independent (reads the hub's own store),
// so the resume guard can run it before the deploy-window sidecar wait without
// masking that 503.

// The events ref every workflow-run repo commits to (matches the projection
// bridge, the supervisor's `commitRunEvent`, and run-state-from-log).
const RUN_EVENT_REF = "refs/heads/main";

// The sidecar keys the workflow-run repo by the substrate-safe slug of the
// deployment's mail address (NOT the raw `ses_<id>`). Inlined from the route's
// `deriveWorkflowRunRepoId` (kept byte-identical) to avoid a value import of the
// heavy `routes/workflow-runs` module — see the leaf-module note above.
function deriveRunRepoId(args: {
  deploymentId: string;
  deploymentDomain: string;
}): string {
  return deriveDeploymentAddress(args).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

// The on-disk event carries the state-machine discriminator under `type`; the
// native transition reads it under `kind`. Bridge the two; `resumeFromLog`
// re-validates every invariant, so the cast is checked by the fold.
function toNativeEvents(events: readonly WorkflowRunEvent[]): WorkflowEvent[] {
  return events.map(
    (e) => ({ ...e.body, kind: e.type }) as unknown as WorkflowEvent,
  );
}

export async function getAwaitingSignalNames(
  deps: { repoStore: RepoStore },
  args: { deploymentId: string; runId: string; deploymentDomain: string },
): Promise<Set<string>> {
  const repoId: RepoId = {
    kind: "workflow-run",
    id: deriveRunRepoId({
      deploymentId: args.deploymentId,
      deploymentDomain: args.deploymentDomain,
    }),
  };
  const reader = createWorkflowRunReader(deps.repoStore);
  const events = await reader.readRunEvents(repoId, RUN_EVENT_REF, args.runId);
  const state = resumeFromLog(args.runId, toNativeEvents(events));
  const names = new Set<string>();
  for (const step of state.steps.values()) {
    if (step.phase === "awaiting-signal" && step.awaitingSignal !== undefined) {
      names.add(step.awaitingSignal.name);
    }
  }
  return names;
}
