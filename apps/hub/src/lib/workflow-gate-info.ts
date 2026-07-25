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
    "'text' | 'textarea' | 'url' | 'select' | 'boolean' | 'string-array' | 'number'",
  "kind?":
    "'text' | 'textarea' | 'url' | 'select' | 'boolean' | 'string-array' | 'number'",

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

// Kinds explicitly cleared to be attachable to a schedule despite having
// post-intake human gates (CL-3528). Historically named for an unattended
// Myra auto-drive path; that driver is NOT wired into production (CL-4289 —
// see scheduled-workflow-gate-agent.ts), so today these post-intake gates
// simply deliver gate mail to the owner like any other gate, same as every
// other allowlisted kind reaching `allowsScheduledPostIntakeDrive`.
export const SCHEDULED_POST_INTAKE_DRIVE_KIND_ALLOWLIST = new Set([
  "scheduler-multi-gate-test",
]);

/** Whether a kind's post-intake human gates may be attached to a schedule at all. */
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

// Shape read by `deriveEntryStepRequiredTriggerFields` — only the fields that
// derivation touches; extra keys on the real step/agent objects are ignored.
type RawTriggerStep = {
  kind?: string;
  input?: { from?: string };
  agent?: { tags?: Record<string, unknown> };
};

/**
 * The trigger-payload fields a workflow's entry step reads directly (CL-4204
 * routine eligibility derivation). Only meaningful for a fully-unattended
 * entry (a deterministic `step`, not an `awaitSignal` gate) whose input comes
 * straight from `trigger.payload` — an intake-gated entry has no direct
 * trigger read; its inputs are the declared intake fields instead, handled
 * separately. The deterministic-tool arg map (`workbench.argMap`, stamped by
 * `deterministicToolStep`) names exactly which trigger-payload keys the entry
 * step's tool call requires — e.g. `granola-call`'s entry step requires
 * `noteId`, which is neither a declared intake field nor supplied by any
 * registered trigger-payload enricher, so it correctly comes back non-empty
 * and fails eligibility. A step with no arg map (nothing read from the
 * trigger beyond identity/reserved keys, e.g. `prospect-engine`'s
 * `initBudget`) returns no required fields.
 */
export function deriveEntryStepRequiredTriggerFields(
  definition: unknown,
): string[] {
  const def = definition as
    | { steps?: Record<string, RawTriggerStep>; stepOrder?: unknown }
    | null
    | undefined;
  const stepOrder = Array.isArray(def?.stepOrder) ? def.stepOrder : [];
  const firstId = stepOrder[0];
  if (typeof firstId !== "string") return [];
  const first = def?.steps?.[firstId];
  if (first === undefined || first.kind !== "step") return [];
  if (first.input?.from !== "trigger.payload") return [];
  const argMapRaw = first.agent?.tags?.["workbench.argMap"];
  if (typeof argMapRaw !== "string") return [];
  let argMap: unknown;
  try {
    argMap = JSON.parse(argMapRaw);
  } catch {
    return [];
  }
  if (argMap === null || typeof argMap !== "object") return [];
  const fields: string[] = [];
  for (const value of Object.values(argMap as Record<string, unknown>)) {
    const from = (value as { from?: unknown } | null)?.from;
    if (typeof from === "string") fields.push(from);
  }
  return fields;
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
