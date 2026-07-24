import { type } from "arktype";

// Pure, React-free parsing of the workflow's inference-step outputs (CL-2769).
// Shared by the run-page panel (`ui.tsx`) and the dock block builder
// (`blocks.ts`) so both read the analyze/curate replies through the exact same
// schemas and derivations — a block-driven run and a panel-driven run can never
// disagree on what the model produced.

// Agent / agentStep output: the sidecar wraps the reply in
// { reply, turn }. We JSON.parse(reply) to get structured data.
export const AgentStepOutput = type({ reply: "string", "turn?": "unknown" });

export const Recommendation = type({
  label: "string",
  "intent?": "string",
  "reason?": "string",
  "confidence?": "number",
});

export const SearchPlanItem = type({
  subreddit: "string",
  query: "string",
  "intent?": "string",
  "reason?": "string",
  "sort?": "string",
  "timeframe?": "string",
  "limit?": "number",
});
export type SearchPlanItem = typeof SearchPlanItem.infer;

export const AnalyzeJSON = type({
  "whatTheySell?": "string",
  "icp?": "string",
  "competitors?": "string[]",
  "audienceNotes?": "string",
  "keywords?": Recommendation.array(),
  "subreddits?": Recommendation.array(),
  "searches?": SearchPlanItem.array(),
});
export type AnalyzeResult = typeof AnalyzeJSON.infer;

export const Opportunity = type({
  id: "string",
  title: "string",
  subreddit: "string",
  signal: "'buying-signal' | 'pain-point' | 'competitor-mention'",
  "score?": "number",
  "detail?": "string",
  "evidence?": "string",
  "whyItMatters?": "string",
  "suggestedAction?": "string",
  "content?": "string",
  "url?": "string",
});
export type Opportunity = typeof Opportunity.infer;

export const ScanJSON = type({ "opportunities?": Opportunity.array() });

export function parseAnalyzeOutput(
  raw: unknown,
): AnalyzeResult | "pending" | "error" {
  const envelope = AgentStepOutput(raw);
  if (envelope instanceof type.errors) return "pending";

  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.reply);
  } catch {
    return "error";
  }

  const parsed = AnalyzeJSON(decoded);
  if (parsed instanceof type.errors) return "error";
  return parsed;
}

export function parseCurateOutput(
  raw: unknown,
): Opportunity[] | "pending" | "error" {
  const envelope = AgentStepOutput(raw);
  if (envelope instanceof type.errors) return "pending";

  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.reply);
  } catch {
    return "error";
  }

  const parsed = ScanJSON(decoded);
  if (parsed instanceof type.errors) return "error";
  return parsed.opportunities ?? [];
}

// The business-context summary the review gate seeds and the curate step reads.
// Formerly derived inline in the panel; hoisted here so the block form seeds the
// identical text (CL-2769).
export function deriveBusinessContext(analysis: AnalyzeResult): string {
  const competitors = analysis.competitors ?? [];
  return [
    analysis.whatTheySell !== undefined
      ? `What they sell: ${analysis.whatTheySell}`
      : null,
    analysis.icp !== undefined ? `ICP: ${analysis.icp}` : null,
    analysis.audienceNotes !== undefined
      ? `Audience: ${analysis.audienceNotes}`
      : null,
    competitors.length > 0 ? `Competitors: ${competitors.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
