import { type } from "arktype";

// Serialized intake-field descriptor carried in the embedded workflow def so the
// attach UI can render a workflow's first-intake form without importing workflow
// code (CL-3509). A minimal subset of @workbench/blocks `FormField` (text /
// textarea only) — the attach form collects short scalar inputs, not the full
// block form surface. A workflow exports `INTAKE_FIELDS` matching this shape; the
// build serializes it into the def.
export const EmbeddedIntakeFieldSchema = type({
  name: "string > 0",
  label: "string > 0",
  kind: "'text' | 'textarea'",
  "required?": "boolean",
  "placeholder?": "string",
});
export type EmbeddedIntakeField = typeof EmbeddedIntakeFieldSchema.infer;

// The steps map of a serialized workflow definition, reduced to the only fields
// the gate derivation reads. Extra keys are ignored so any real step shape parses.
const DefinitionStepsSchema = type({
  "[string]": { "kind?": "string", "name?": "string", "+": "ignore" },
});

export const WorkflowGateInfoSchema = type({
  requiresIntake: "boolean",
  humanGateCount: "number.integer >= 0",
});
export type WorkflowGateInfo = typeof WorkflowGateInfoSchema.infer;

// Derive a workflow's gate shape from its serialized definition's `steps`.
// `requiresIntake` is true when the definition has an `awaitSignal` gate named
// "intake" — the entry gate a scheduled run can be pre-filled for and have
// auto-delivered (CL-3509). `humanGateCount` is the total number of awaitSignal
// gates. A workflow with zero gates is fully unattended; one whose only gate is
// `intake` runs to completion once the stored intake is auto-delivered.
export function deriveWorkflowGateInfo(definition: unknown): WorkflowGateInfo {
  const rawSteps = (definition as { steps?: unknown } | null | undefined)
    ?.steps;
  const steps = DefinitionStepsSchema(rawSteps ?? {});
  if (steps instanceof type.errors) {
    return { requiresIntake: false, humanGateCount: 0 };
  }
  let humanGateCount = 0;
  let requiresIntake = false;
  for (const [id, step] of Object.entries(steps)) {
    if (step.kind !== "awaitSignal") continue;
    humanGateCount += 1;
    if ((step.name ?? id) === "intake") requiresIntake = true;
  }
  return { requiresIntake, humanGateCount };
}

// Whether a kind can be attached to a schedule at all (structural), ignoring
// whether intake input has actually been supplied. Fully-unattended workflows (no
// gates) always qualify. A workflow with an `intake` entry gate qualifies: the
// scheduler pre-fills and auto-delivers intake (CL-3509) and Myra drives every
// post-intake human gate for scheduler-sourced runs (CL-3528). Workflows whose
// first human gate is not `intake` are excluded — there is no auto-first-gate
// path and no agent drives them on a schedule.
export function isKindStructurallyAttachable(info: WorkflowGateInfo): boolean {
  if (info.humanGateCount === 0) return true;
  return info.requiresIntake;
}
