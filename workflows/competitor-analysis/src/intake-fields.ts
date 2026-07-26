import type { StepUIInputField } from "@workbench/shared";

// Single source of truth for the intake gate's fields (CL-4538): both the
// dock's `blocks.ts` form AND the schedule/attach `INTAKE_FIELDS` export
// (`./index.ts`) derive from this one list, so the field
// `CompetitorAnalysisIntakePayloadSchema` requires (`url`) can never be
// declared for one surface and missing from the other. Named `url` (not
// `companyUrl`): must equal the shared `firecrawl_scrape` tool's arg
// verbatim — native `action` selectors cannot rename a key. Kept dependency-
// free (only `@workbench/shared` types) so `./index.ts` — the server-side
// entry `build-workflow-defs` loads — never gains a runtime edge onto
// `@workbench/blocks`.
export const INTAKE_FORM_FIELDS: readonly StepUIInputField[] = [
  {
    kind: "text",
    name: "url",
    label: "Company website URL",
    placeholder: "https://acme.com",
    required: true,
  },
  {
    kind: "text",
    name: "companyName",
    label: "Company name (optional)",
    placeholder: "Acme",
  },
  {
    kind: "textarea",
    name: "focusNotes",
    label: "Focus notes (optional)",
    placeholder: "e.g. mid-market CRM, EU region, product-led motion",
  },
];

// Schedule-field metadata (CL-3509): the same fields in the richer
// `ScheduleFieldMetadata` vocabulary (`inputHint` + `order`) the attach UI
// and Routines form read, derived from `INTAKE_FORM_FIELDS` rather than
// hand-maintained separately.
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
