import { type } from "arktype";

// Serialized intake-field descriptor carried in the embedded workflow def so the
// Serialized intake-field descriptor carried in the embedded workflow def so the
// attach UI can render a workflow's first-intake form without importing workflow
// code (CL-3509 + CL-3860 schedule field metadata). Includes string-array for
// multi-value schedule fields (prospect-engine verticals).
export const EmbeddedIntakeFieldSchema = type({
  name: "string > 0",
  label: "string > 0",
  "inputHint?":
    "'text' | 'textarea' | 'url' | 'select' | 'boolean' | 'string-array'",
  "kind?":
    "'text' | 'textarea' | 'url' | 'select' | 'boolean' | 'string-array'",

  "required?": "boolean",
  "placeholder?": "string",
  "help?": "string",
  "order?": "number.integer",
  "options?": type({ value: "string", label: "string > 0" }).array(),
  "optionsSource?": "string > 0",
  "fromProfile?": "string > 0",
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
  "allowsScheduledPostIntakeDrive?": "boolean",
});
export type WorkflowGateInfo = typeof WorkflowGateInfoSchema.infer;

/** Kinds explicitly cleared for unattended Myra post-intake gate-drive (CL-3528). */
export const SCHEDULED_POST_INTAKE_DRIVE_KIND_ALLOWLIST = new Set([
  "scheduler-multi-gate-test",
]);

/** Whether a kind may use Myra to auto-drive human gates after intake on scheduler runs. */
export function kindAllowsScheduledPostIntakeDrive(
  kind: string,
  info: WorkflowGateInfo,
): boolean {
  if (!info.requiresIntake || info.humanGateCount <= 1) return false;
  if (SCHEDULED_POST_INTAKE_DRIVE_KIND_ALLOWLIST.has(kind)) return true;
  return info.allowsScheduledPostIntakeDrive === true;
}

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
// gates) always qualify. Intake-only workflows qualify: the scheduler pre-fills and
// auto-delivers intake (CL-3509). Workflows with additional post-intake human
// gates qualify only when explicitly allowlisted or flagged in the embedded
// catalog (CL-3528 security). Workflows whose first human gate is not `intake`
// are excluded.
export function isKindStructurallyAttachable(
  info: WorkflowGateInfo,
  kind: string,
): boolean {
  if (info.humanGateCount === 0) return true;
  if (!info.requiresIntake) return false;
  if (info.humanGateCount === 1) return true;
  return kindAllowsScheduledPostIntakeDrive(kind, info);
}
