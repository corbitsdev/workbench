import type { StepUI, StepUIInputField } from "@workbench/shared";

// The intake gate's `awaitSignal` name (matches the step in index.ts).
export const INTAKE_SIGNAL = "intake";

// Single source of truth for the intake gate's collectible fields (CL-4538):
// both the live dock's `STEP_UI` form below AND the schedule/attach
// `INTAKE_FIELDS` export (`./index.ts`) derive from this one list, so a field
// `GtmScriptsBriefsIntakePayloadSchema` requires (topic, days) can never be
// declared for one surface and silently missing from the other — that drift
// (dock had both fields, the schedule form had neither) is CL-4538: the
// schedule form rendered no inputs, then the /resume boundary rejected the
// hollow payload it was never given a chance to collect.
const INTAKE_FORM_FIELDS: readonly StepUIInputField[] = [
  {
    kind: "text",
    name: "topic",
    label: "Topic",
    placeholder: "e.g. Recent AI agent launches for revenue teams",
    required: true,
  },
  {
    kind: "number",
    name: "days",
    label: "Research window (days)",
    placeholder: "30",
    required: true,
    defaultValue: 30,
  },
  {
    kind: "text",
    name: "audience",
    label: "Audience (optional)",
    placeholder: "e.g. VP Sales at mid-market SaaS companies",
  },
  {
    kind: "textarea",
    name: "objective",
    label: "Objective (optional)",
    placeholder: "What should the artifact help the audience understand or do?",
  },
];

// Declarative step -> component mapping consumed by `blocksFromStepUI`
// (`@workbench/blocks`) — the dock's `intake` form is rendered generically
// from this map rather than a hand-written `blocks.ts` builder.
export const STEP_UI: StepUI = {
  [INTAKE_SIGNAL]: {
    role: "intake",
    prompt:
      "What current GTM story should we research and turn into a deliverable?",
    submitLabel: "Research and create deliverable",
    input: [...INTAKE_FORM_FIELDS],
  },
};

// Schedule-field metadata (CL-3509/CL-3860): the first-intake form descriptor
// the attach UI and Routines form read to pre-fill and auto-deliver a
// scheduled run's `intake` gate, in the richer `ScheduleFieldMetadata`
// vocabulary (`inputHint` + `order`) those surfaces expect. Derived from
// `INTAKE_FORM_FIELDS` — the same list the dock form above renders — rather
// than hand-maintained separately, so the two surfaces cannot disagree on
// which fields exist or which are required.
export const INTAKE_FIELDS = INTAKE_FORM_FIELDS.map((field, index) => ({
  name: field.name,
  label: field.label ?? field.name,
  inputHint: field.kind,
  ...(field.required !== undefined ? { required: field.required } : {}),
  ...(field.placeholder !== undefined
    ? { placeholder: field.placeholder }
    : {}),
  order: index,
}));
