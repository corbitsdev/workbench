import { type } from "arktype";

// Resume-boundary contracts for the reddit-opportunity-scanner workflow's three
// HITL gates (CL-2769). The block-driven UIBlocks and the run-page panel both
// POST these shapes; registering them in the resume-payload registry rejects a
// hollow/malformed resume at the /resume boundary rather than writing it into a
// step output and poisoning the deterministic collect/persist map steps.

// intake gate: the human supplies the website URL (REQUIRED and http(s) — the
// scrape step fetches it, so a blank or non-URL value would fail the crawl deep
// in the run) plus optional brand / geography / ICP hints the analyze step reads.
// The URL validation the panel enforced client-side lives here as the single
// server-side check, so a block-form submission is held to the same contract.
export const RedditIntakePayloadSchema = type({
  url: /^https?:\/\/.+/iu,
  "brandName?": "string",
  "targetGeography?": "string",
  "icpHints?": "string",
});
export type RedditIntakePayload = typeof RedditIntakePayloadSchema.infer;

// One planned Reddit search the collect step maps into `reddit_subreddit_search`.
// `subreddit` + `query` are REQUIRED and non-empty (the collect map calls the
// tool once per row; a blank subreddit or query would query nothing). The
// remaining fields are optional here — the per-row defaulting + "r/"-strip is
// relocated server-side into the tool's `normalizeSubredditSearchArgs`
// (CL-2769), so a row carrying "r/devops" and no sort/timeframe/limit still
// reaches the API complete.
export const RedditSearchPlanItemSchema = type({
  subreddit: "string >= 1",
  query: "string >= 1",
  "sort?": "string",
  "timeframe?": "string",
  "limit?": "number",
  "intent?": "string",
  "reason?": "string",
});
export type RedditSearchPlanItem = typeof RedditSearchPlanItemSchema.infer;

// recommendation-review gate: the human accepts / edits the inferred keyword +
// subreddit strategy and the concrete search plan. `keywords` and `subreddits`
// must each carry at least one entry (the scan is grounded on them); `searches`
// must carry at least one row (the collect step maps over it). `competitors`
// and `businessContext` are optional context the curate step reads.
export const RedditReviewPayloadSchema = type({
  keywords: "string[] >= 1",
  subreddits: "string[] >= 1",
  "competitors?": "string[]",
  "businessContext?": "string",
  searches: RedditSearchPlanItemSchema.array().atLeastLength(1),
});
export type RedditReviewPayload = typeof RedditReviewPayloadSchema.infer;

// One selected opportunity the persist step maps into `artifact_create`. The
// persist argMap reads `title` + `content`, so both are REQUIRED and non-empty
// here — the reviewList row carries the FULL opportunity object as its payload,
// and the block builder guarantees a non-empty `content` (synthesizing a brief
// from the opportunity's fields when the curate step did not emit one). Extra
// keys (the opportunity's other fields) pass through untouched.
export const RedditSelectionOpportunitySchema = type({
  title: "string >= 1",
  content: "string >= 1",
  "[string]": "unknown",
});
export type RedditSelectionOpportunity =
  typeof RedditSelectionOpportunitySchema.infer;

// opportunity-selection gate: the human approves which opportunities to persist.
// The reviewList emits the approved rows' payloads under `selected` (its
// approvedKey) plus a `decisions` array covering every row. `selected` must
// carry at least one entry — the persist map over an empty array would save
// nothing, and the gate's whole purpose is to save at least one.
export const RedditSelectionPayloadSchema = type({
  selected: RedditSelectionOpportunitySchema.array().atLeastLength(1),
  "decisions?": "unknown[]",
});
export type RedditSelectionPayload = typeof RedditSelectionPayloadSchema.infer;
