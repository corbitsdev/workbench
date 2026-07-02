import { type } from "arktype";
import { getLogger } from "@intx/log";
import {
  createWorkflowRunReader,
  type AgentRepoStore,
  type RepoId,
  type WorkflowRunEvent,
} from "@intx/hub-sessions";
import { resumeFromLog, type WorkflowEvent } from "@intx/workflow";
import type { AgentDefinition, BaseEnv } from "@intx/agent";
import type { WorkflowDefinition } from "@intx/workflow";
import {
  DETERMINISTIC_TOOL_KIND,
  INLINE_INFERENCE_KIND,
  STEP_KIND_TAG,
} from "@workbench/agents";
import { readWorkflowDefinition } from "../services/workflow-deploy";
import { deriveWorkflowRunRepoId } from "../routes/workflow-runs";

// Read a workflow run's authoritative state directly from its native git event
// log (CL-2669 Phase 1a). Where the projection bridge folds the log into a
// coarse `workflow_run_record` row on every pack, this reads the SAME log on
// demand and folds it through the native `@intx/workflow` state machine
// (`resumeFromLog` -> `applyEvent`), yielding the full RunState the runtime
// itself computes: run phase plus per-step phase / attempt / timing. It reuses
// the native transition unmodified — the fold here is not reimplemented.
//
// The log is read through the #534 layout-aware `createWorkflowRunReader`, which
// transparently handles BOTH an in-flight run's per-event `events/<seq>.json`
// files and a terminated run's sealed combined `events.jsonl`. This is the
// read path the workflow reset is proving out before any table is removed.

const log = getLogger(["workflow", "run-state-from-log"]);

// The events ref every workflow-run repo commits to (matches the projection
// bridge and the supervisor's `commitRunEvent`).
const RUN_EVENT_REF = "refs/heads/main";

export type StepKind =
  | "human"
  | "agent"
  | "deterministic"
  | "inline"
  | "other"
  | "unknown";

export const LogStepStateSchema = type({
  stepId: "string",
  phase:
    "'in-flight'|'awaiting-signal'|'awaiting-timer'|'completed'|'failed'|'cancelled'",
  stepType: "'human'|'agent'|'deterministic'|'inline'|'other'|'unknown'",
  currentAttempt: "number",
  "outputRef?": "string",
  "lastError?": { message: "string" },
  "awaitingSignalName?": "string",
  "startedAt?": "string",
  "endedAt?": "string",
});
export type LogStepState = typeof LogStepStateSchema.infer;

export const LogRunStateSchema = type({
  runId: "string",
  phase: "'pending'|'running'|'cancelling'|'completed'|'failed'|'cancelled'",
  "definitionHash?": "string",
  lastSeq: "number",
  "startedAt?": "string",
  "endedAt?": "string",
  steps: LogStepStateSchema.array(),
});
export type LogRunState = typeof LogRunStateSchema.infer;

// Project a workflow primitive to its agent definition when it carries one
// (`step`/`map`); every other primitive has no agent. Mirrors interchange's
// `extractAgent` and the deploy service's `extractStepAgent`.
function primitiveAgent(
  primitive: WorkflowDefinition["steps"][string] | undefined,
): AgentDefinition<BaseEnv> | null {
  if (primitive === undefined) return null;
  if (primitive.kind === "step") return primitive.agent;
  if (primitive.kind === "map") return primitive.step.agent;
  return null;
}

// Classify each step in a definition by how it executes: an `awaitSignal`
// primitive is a human-in-the-loop gate; a `step`/`map` whose agent carries the
// `workbench.stepKind` tag is a deterministic-tool or inline-inference step; a
// bare agent step is a genuine reasoning agent; anything else (gate, sleep,
// childWorkflow, escalation) is `other`.
export function classifyStepKinds(
  definition: WorkflowDefinition,
): Map<string, StepKind> {
  const kinds = new Map<string, StepKind>();
  for (const stepId of Object.keys(definition.steps)) {
    const primitive = definition.steps[stepId];
    if (primitive?.kind === "awaitSignal") {
      kinds.set(stepId, "human");
      continue;
    }
    const agent = primitiveAgent(primitive);
    if (agent === null) {
      kinds.set(stepId, "other");
      continue;
    }
    const tag = agent.tags?.[STEP_KIND_TAG];
    if (tag === DETERMINISTIC_TOOL_KIND) kinds.set(stepId, "deterministic");
    else if (tag === INLINE_INFERENCE_KIND) kinds.set(stepId, "inline");
    else kinds.set(stepId, "agent");
  }
  return kinds;
}

// The on-disk event carries the state-machine discriminator under `type`; the
// native transition reads it under `kind`. Bridge the two and hand the events
// to `resumeFromLog`, which re-validates every invariant (bad shape / sequence
// throws a TransitionError) — so the cast is checked by the fold, not trusted.
function toNativeEvents(events: readonly WorkflowRunEvent[]): WorkflowEvent[] {
  return events.map(
    (e) => ({ ...e.body, kind: e.type }) as unknown as WorkflowEvent,
  );
}

interface StepTiming {
  startedAt?: string;
  endedAt?: string;
}

// Derive run + per-step wall-clock timing from each event's `EventBase.at`.
// The native StepState carries no timing; the ISO timestamp on every event is
// the only source, so we fold the raw event stream once for it.
function deriveTiming(events: readonly WorkflowRunEvent[]): {
  runStartedAt?: string;
  runEndedAt?: string;
  steps: Map<string, StepTiming>;
} {
  const steps = new Map<string, StepTiming>();
  let runStartedAt: string | undefined;
  let runEndedAt: string | undefined;
  const at = (body: Record<string, unknown>): string | undefined =>
    typeof body["at"] === "string" ? body["at"] : undefined;
  const stepId = (body: Record<string, unknown>): string | undefined =>
    typeof body["stepId"] === "string" ? body["stepId"] : undefined;
  const ensure = (id: string): StepTiming => {
    let t = steps.get(id);
    if (t === undefined) {
      t = {};
      steps.set(id, t);
    }
    return t;
  };
  for (const { type: eventType, body } of events) {
    const ts = at(body);
    if (ts === undefined) continue;
    switch (eventType) {
      case "RunStarted":
        runStartedAt = ts;
        break;
      case "RunCompleted":
      case "RunFailed":
      case "RunCancelled":
        runEndedAt = ts;
        break;
      case "StepStarted": {
        const id = stepId(body);
        if (id !== undefined && ensure(id).startedAt === undefined) {
          ensure(id).startedAt = ts;
        }
        break;
      }
      case "StepCompleted":
      case "StepFailed":
      case "CancelPropagated": {
        const id = stepId(body);
        if (id !== undefined) ensure(id).endedAt = ts;
        break;
      }
      default:
        break;
    }
  }
  return {
    steps,
    ...(runStartedAt !== undefined ? { runStartedAt } : {}),
    ...(runEndedAt !== undefined ? { runEndedAt } : {}),
  };
}

async function resolveStepKinds(
  repoStore: AgentRepoStore,
  kind: string,
): Promise<Map<string, StepKind>> {
  try {
    const definition = await readWorkflowDefinition(repoStore, kind);
    return classifyStepKinds(definition);
  } catch (err) {
    // The definition repo may be absent (a run whose kind was undeployed). The
    // log-derived RunState is still authoritative; degrade classification to
    // `unknown` rather than failing the whole read.
    log.warn("run-state-from-log: definition unreadable; step types unknown", {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

// Read a run's event log from the hub's repo store (layout-aware) and fold it
// through the native state machine into a fully-typed RunState, with each step
// classified by execution type from the deployed definition.
export async function getWorkflowRunState(
  deps: { repoStore: AgentRepoStore },
  args: {
    deploymentId: string;
    runId: string;
    kind: string;
    deploymentDomain: string;
  },
): Promise<LogRunState> {
  // The sidecar keys the workflow-run repo by the SUBSTRATE-SAFE SLUG of the
  // deployment's mail address, NOT the raw `ses_<id>` deploymentId — so a read
  // against the raw id finds an empty repo in production. Derive the slug the
  // same way the working step-output route does (deriveWorkflowRunRepoId), which
  // stays in lockstep with the sidecar's `deriveTrivialDeploymentId` (CL-2669).
  const repoId: RepoId = {
    kind: "workflow-run",
    id: deriveWorkflowRunRepoId({
      deploymentId: args.deploymentId,
      deploymentDomain: args.deploymentDomain,
    }),
  };
  const reader = createWorkflowRunReader(deps.repoStore.repoStore);
  const events = await reader.readRunEvents(repoId, RUN_EVENT_REF, args.runId);

  const state = resumeFromLog(args.runId, toNativeEvents(events));
  const timing = deriveTiming(events);
  const stepKinds = await resolveStepKinds(deps.repoStore, args.kind);

  const steps: LogStepState[] = [];
  for (const [stepId, step] of state.steps) {
    const t = timing.steps.get(stepId);
    steps.push({
      stepId,
      phase: step.phase,
      stepType: stepKinds.get(stepId) ?? "unknown",
      currentAttempt: step.currentAttempt,
      ...(step.outputRef !== undefined ? { outputRef: step.outputRef } : {}),
      ...(step.lastError !== undefined
        ? { lastError: { message: step.lastError.message } }
        : {}),
      ...(step.awaitingSignal !== undefined
        ? { awaitingSignalName: step.awaitingSignal.name }
        : {}),
      ...(t?.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
      ...(t?.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    });
  }

  return {
    runId: args.runId,
    phase: state.phase,
    ...(state.definitionHash !== undefined
      ? { definitionHash: state.definitionHash }
      : {}),
    lastSeq: state.lastSeq,
    ...(timing.runStartedAt !== undefined
      ? { startedAt: timing.runStartedAt }
      : {}),
    ...(timing.runEndedAt !== undefined ? { endedAt: timing.runEndedAt } : {}),
    steps,
  };
}
