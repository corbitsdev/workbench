import { type } from "arktype";

// Resume-boundary contracts for the competitor-analysis workflow's two HITL
// gates. The dock blocks and the run-page panel POST these shapes; registering
// them in the resume-payload registry rejects a hollow/malformed resume at the
// /resume boundary rather than writing it into a step output and poisoning the
// scrape / package steps that read it.

// intake: company URL is REQUIRED and must be http(s) — the scrape step fetches
// it, so a blank or non-URL value would fail the crawl deep in the run. Optional
// companyName and focusNotes refine the profile and discovery prompts.
export const CompetitorAnalysisIntakePayloadSchema = type({
  companyUrl: /^https?:\/\/.+/iu,
  "companyName?": "string",
  "focusNotes?": "string",
});
export type CompetitorAnalysisIntakePayload =
  typeof CompetitorAnalysisIntakePayloadSchema.infer;

// review: the operator approves the competitor report before it is persisted.
export const CompetitorAnalysisReviewPayloadSchema = type({
  approved: "boolean",
});
export type CompetitorAnalysisReviewPayload =
  typeof CompetitorAnalysisReviewPayloadSchema.infer;
