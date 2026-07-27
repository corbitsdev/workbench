// The dock's declarative step -> UI map for competitor-analysis, plus the
// schedule/attach form field descriptor derived from the SAME field list
// (CL-4538's guarantee: the dock's intake form and the Routines/attach form
// can never disagree about which fields exist or which are required).
//
// `@workbench/shared` is a devDependency only (see package.json) — this
// module imports its `StepUI` contract as a TYPE ONLY (erased at compile
// time, zero runtime footprint), so the workflow carries no runtime
// `@workbench/shared` dependency. `CompetitorAnalysisIntakePayloadSchema`
// below is this workflow's OWN copy (not imported), duplicated deliberately:
// the hub validates the identical shape independently via its own
// `@workbench/shared`-owned copy at the /resume boundary.

import { type } from "arktype";
import type { StepUI, StepUIInputField } from "@workbench/shared";

export const INTAKE_SIGNAL = "intake";
export const REVIEW_SIGNAL = "review";

// Local copy of the hub's resume-boundary schema
// (`packages/workbench-shared`'s `CompetitorAnalysisIntakePayloadSchema`) —
// duplicated deliberately per workflow self-containment: this workflow
// asserts its own `STEP_UI` intake fields cover this copy's required keys in
// its own tests, while the hub validates the identical shape independently
// via its own `@workbench/shared`-owned copy at the /resume boundary.
export const CompetitorAnalysisIntakePayloadSchema = type({
  url: /^https?:\/\/.+/iu,
  "companyName?": "string",
  "focusNotes?": "string",
});
export type CompetitorAnalysisIntakePayload =
  typeof CompetitorAnalysisIntakePayloadSchema.infer;

export const CompetitorAnalysisReviewPayloadSchema = type({
  approved: "boolean",
});
export type CompetitorAnalysisReviewPayload =
  typeof CompetitorAnalysisReviewPayloadSchema.infer;

// Single source of truth for the intake gate's fields (CL-4538): both the
// dock's `STEP_UI.intake.input` below and the schedule/attach `INTAKE_FIELDS`
// export derive from this one list, so the field
// `CompetitorAnalysisIntakePayloadSchema` requires (`url`) can never be
// declared for one surface and missing from the other. Named `url` (not
// `companyUrl`): must equal the shared `firecrawl_scrape` tool's arg
// verbatim — native `action` selectors cannot rename a key.
const INTAKE_FORM_FIELDS: readonly StepUIInputField[] = [
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

// Declarative step -> component mapping consumed by `blocksFromStepUI`
// (`@workbench/blocks`, on the host side only). The review gate's block
// content depends on the synthesized report, so it is expressed as a
// dynamic `gateFromOutput` gate whose source is `reviewGate` — a native
// action step (see `index.ts`) that reads the `synthesize` agent's raw reply
// and emits the `{ kind: "choice", ... }` block directly, rather than a
// static gate declared here.
export const STEP_UI: StepUI = {
  [INTAKE_SIGNAL]: {
    role: "intake",
    prompt:
      "Enter the company to research. We scrape their site, search for alternatives, and draft a competitor shortlist for you to review.",
    submitLabel: "Find competitors",
    input: [...INTAKE_FORM_FIELDS],
  },
  scrape: { title: "Scrape the company site" },
  profile: { title: "Define the company profile" },
  discover: { title: "Discover competitors" },
  synthesize: { title: "Write the competitor report" },
  reviewGate: { title: "Prepare the report review" },
  [REVIEW_SIGNAL]: {
    role: "review",
    title: "Review the competitor report",
    gateFromOutput: true,
    gateSourceStep: "reviewGate",
  },
  document: { title: "Format the report" },
  packageArtifact: { title: "Save to workbench" },
};

// Schedule-field metadata (CL-4538/CL-3509): the same fields in the richer
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
