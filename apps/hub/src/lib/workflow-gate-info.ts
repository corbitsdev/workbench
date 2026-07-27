import { type } from "arktype";

// Serialized intake-field descriptor carried in the embedded workflow def so the
// attach UI can render a workflow's first-intake form without importing workflow
// code (CL-3509 + CL-3860 schedule field metadata). Includes string-array for
// multi-value schedule fields (prospect-engine verticals) and select-multi for
// option-backed roster subsets (CL-4429 / CL-4033). Kept in lockstep with
// `ScheduleFieldInputKindSchema` in `@workbench/shared` — a hint accepted there
// but not here fails def serialization at build time.
export const EmbeddedIntakeFieldSchema = type({
  name: "string > 0",
  label: "string > 0",
  "inputHint?":
    "'text' | 'textarea' | 'url' | 'select' | 'select-multi' | 'boolean' | 'string-array' | 'number'",
  "kind?":
    "'text' | 'textarea' | 'url' | 'select' | 'select-multi' | 'boolean' | 'string-array' | 'number'",

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

// Every workflow is schedulable (CL-4514) — there is no structural or
// eligibility gate on schedule attachment anymore. `requiresIntake` below
// survives ONLY as a delivery detail: it tells the scheduler and the
// `/me/schedules` PATCH validator whether a kind's entry gate is named
// `intake`, i.e. whether a stored trigger payload should be auto-delivered to
// it / re-validated against its registered intake schema. It is never
// consulted to decide whether a kind CAN be scheduled.

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
 *
 * KNOWN GAP — what this function CANNOT see, and what covers each case now:
 *
 * 1. Native `action` entry steps. `deterministicToolStep` and its
 *    `workbench.argMap` tag are retired, so no committed def carries that tag
 *    and this function returns `[]` for every workflow today. The property it
 *    used to enforce is now re-derived independently, from the raw selector
 *    tree, by the "native action entry steps only require trigger fields the
 *    schedule can supply" suite in `routine-eligibility.integration.test.ts`.
 *    That is a BUILD-TIME check, not a reinstated runtime gate.
 *
 * 2. Agent (`kind: "step"`) steps — STILL UNCOVERED, and uncoverable by static
 *    analysis. An agent chooses its tool arguments at run time from its system
 *    prompt, so which `trigger.payload` fields its calls require is not encoded
 *    in any selector or tag. `daily-linkedin` (CL-4033) is exactly this shape:
 *    its drafting agent passes `userAddress` into `inbox_deliver_batch`, which
 *    requires it, and nothing here or in the selector walk can tell. The only
 *    real cover for that shape is a registered trigger-payload enricher for the
 *    kind (`../workflow-executor/trigger-payload-enrichment-registry.ts`), which
 *    daily-linkedin has and which `routine-eligibility.integration.test.ts`
 *    asserts. A new agent-step workflow that reads a trigger field with no
 *    enricher will still fail only at fire time — do not read this file's `[]`
 *    as evidence that it is safe.
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
