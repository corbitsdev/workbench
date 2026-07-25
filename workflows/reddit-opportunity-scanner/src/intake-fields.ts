import type { StepUIInputField } from "@workbench/shared";

// Single source of truth for the intake gate's fields (CL-4538): both the
// dock's `blocks.ts` form AND the schedule/attach `INTAKE_FIELDS` export
// (`./index.ts`) derive from this one list, so the field
// `RedditIntakePayloadSchema` requires (`url`) can never be declared for one
// surface and missing from the other. Named `url` (not `inputUrl`): must
// equal the shared `firecrawl_scrape` tool's arg verbatim — native `action`
// selectors cannot rename a key. Kept dependency-free (only
// `@workbench/shared` types) so `./index.ts` — the server-side entry
// `build-workflow-defs` loads — never gains a runtime edge onto
// `@workbench/blocks`.
export const INTAKE_FORM_FIELDS: readonly StepUIInputField[] = [
  {
    kind: "text",
    name: "url",
    label: "Website URL",
    placeholder: "https://example.com",
    required: true,
  },
  {
    kind: "text",
    name: "brandName",
    label: "Brand name (optional)",
    placeholder: "Acme",
  },
  {
    kind: "text",
    name: "targetGeography",
    label: "Target geography (optional)",
    placeholder: "North America",
  },
  {
    kind: "textarea",
    name: "icpHints",
    label: "ICP / audience hints (optional)",
    placeholder: "Who is the ideal customer? What problems do they have?",
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
  order: index,
}));
