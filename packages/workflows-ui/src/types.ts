import { type } from "arktype";

/**
 * How a display step behaves at runtime, derived from its primitive `kind`
 * plus (for `step`/`map`) the `workbench.stepKind` authoring tag. This is a
 * finer-grained sibling of `FlowStepClass` in
 * `@workbench/agents`'s `flow-classify.ts` ("auto" | "agent" | "human"): that
 * vocabulary answers "does this need a human", this one answers "what kind of
 * node is this" for a renderer that wants to draw a gate differently from a
 * sleep differently from a child-workflow spawn. The two should eventually
 * converge — `flow-classify.ts` could derive its coarse `FlowStepClass` from
 * this finer `DisplayStepCharacter` — but that migration is out of scope for
 * this phase.
 */
export type DisplayStepCharacter =
  | "deterministic"
  | "reasoning"
  | "gate"
  | "await"
  | "action"
  | "sleep"
  | "child"
  | "other";

/**
 * One display step derived from a single runtime primitive, before any
 * curation overlay groups steps together. `after` is carried through
 * unmodified so a renderer can lay out parallel branches honestly instead of
 * flattening the DAG into a single line.
 */
export interface DisplayFlowStep {
  stepId: string;
  label: string;
  character: DisplayStepCharacter;
  after: readonly string[];
}

/** The full derived display model for one workflow definition, in `stepOrder`. */
export interface DisplayFlow {
  steps: readonly DisplayFlowStep[];
}

/**
 * A workflow author's curation of the raw per-primitive display flow into
 * user-facing groups. Structurally compatible with the persisted
 * `displayFlow` field in `apps/hub/generated/workflow-defs/*.json`
 * (`EmbeddedDisplayFlowStepSchema` in `apps/hub/src/lib/workflow-defs-embedded.ts`)
 * and with `DisplayFlowStep` in `@workbench/agents`'s `flow-classify.ts` —
 * this package's `steps` corresponds to that module's `stepIds`. A future
 * authoring-layer typing over a live definition (the compile-time-typo goal)
 * builds on this shape; this overlay is its runtime backstop.
 */
export interface DisplayOverlayGroup {
  key: string;
  label: string;
  steps: readonly string[];
  activityLabel?: string;
}

export interface DisplayOverlay {
  groups: readonly DisplayOverlayGroup[];
}

/** One curated group after applying a `DisplayOverlay` to a `DisplayFlow`. */
export interface OverlaidDisplayStep {
  key: string;
  label: string;
  character: DisplayStepCharacter;
  stepIds: readonly string[];
  activityLabel?: string;
}

export interface OverlaidDisplayFlow {
  groups: readonly OverlaidDisplayStep[];
}

/**
 * Structural boundary schema for the fields `deriveDisplayFlow` reads off a
 * persisted workflow-def JSON file (`apps/hub/generated/workflow-defs/*.json`).
 * Deliberately loose on `steps`/`agent`/`tags` — like
 * `workflowDefinitionEnvelopeSchema` in `@workbench/hub-sessions` and
 * `RawTriggerStep` in `apps/hub/src/lib/workflow-gate-info.ts`, deep
 * primitive-union validation belongs to the runtime layer that hydrates a
 * `WorkflowDefinition` via `defineWorkflow`; this schema only rejects a file
 * that could not possibly carry a display flow (missing `kind`/`definition`,
 * wrong top-level types).
 */
export const PersistedStepAgentSchema = type({
  "tags?": "Record<string, string>",
}).onUndeclaredKey("ignore");

export const PersistedPrimitiveSchema = type({
  kind: "string",
  "after?": "string[]",
  "agent?": PersistedStepAgentSchema,
  "step?": type({
    "agent?": PersistedStepAgentSchema,
  }).onUndeclaredKey("ignore"),
  "name?": "string",
}).onUndeclaredKey("ignore");

export const PersistedWorkflowDefinitionSchema = type({
  id: "string",
  stepOrder: "string[]",
  steps: "Record<string, unknown>",
}).onUndeclaredKey("ignore");

export const PersistedWorkflowDefFileSchema = type({
  kind: "string",
  "label?": "string",
  definition: PersistedWorkflowDefinitionSchema,
}).onUndeclaredKey("ignore");

export type PersistedWorkflowDefFile =
  typeof PersistedWorkflowDefFileSchema.infer;

/** The narrow per-primitive shape `deriveDisplayFlow` actually reads. */
export type PersistedPrimitive = typeof PersistedPrimitiveSchema.infer;
