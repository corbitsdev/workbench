import type { StepUIInputField } from "@workbench/shared";

// Schedule-field metadata (CL-4538): `GammaIntakePayloadSchema` requires
// `deckTitle` and `gammaId`. The LIVE dock deliberately has no intake form for
// this gate — `deckTitle`/`gammaId` need the run page's Gamma template
// catalogue query, which no static field can express (see `./blocks.ts`), so
// the dock sends the user there instead of asking for opaque ids in a form.
// A SCHEDULED run has no run page to visit before firing, though: without a
// declared field here the Routines/attach form renders nothing for a payload
// that requires both keys, and the /resume boundary rejects it — the exact
// CL-4538 defect. Declaring `gammaId` as plain text (the operator pastes the
// template id, findable on the Gamma Templates admin page) is a real,
// submittable schedule form, unlike the alternative of shipping none. A live
// template picker for the schedule surface (mirroring the Sumble
// `optionsSource` mechanism, CL-4279) is a follow-up, not this fix.
export const INTAKE_FORM_FIELDS: readonly StepUIInputField[] = [
  {
    kind: "text",
    name: "deckTitle",
    label: "Deck title",
    placeholder: "e.g. Q3 Product Update",
    required: true,
  },
  {
    kind: "text",
    name: "gammaId",
    label: "Gamma template id",
    placeholder: "e.g. abc123XYZ",
    help: "Find this on the Gamma Templates admin page.",
    required: true,
  },
];

export const INTAKE_FIELDS = INTAKE_FORM_FIELDS.map((field, index) => ({
  name: field.name,
  label: field.label ?? field.name,
  inputHint: field.kind,
  ...(field.required !== undefined ? { required: field.required } : {}),
  ...(field.placeholder !== undefined
    ? { placeholder: field.placeholder }
    : {}),
  ...(field.help !== undefined ? { help: field.help } : {}),
  ...(field.defaultValue !== undefined
    ? { defaultValue: field.defaultValue }
    : {}),
  ...(field.min !== undefined ? { min: field.min } : {}),
  ...(field.max !== undefined ? { max: field.max } : {}),
  ...(field.step !== undefined ? { step: field.step } : {}),
  order: index,
}));
