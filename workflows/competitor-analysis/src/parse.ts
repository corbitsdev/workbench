// Shared step-output parsers for the competitor-analysis workflow.
//
// The run-page panel (`ui.tsx`) and the dock block builder (`blocks.ts`) both
// decode the same log-derived step outputs. Inference steps emit
// `{ reply: string }` carrying strict JSON.

import { type } from "arktype";

export const CompetitorSegment = type(
  "'direct'|'indirect'|'adjacent'|'status_quo'",
);
export type CompetitorSegment = typeof CompetitorSegment.infer;

export const SubjectProfile = type({
  companyName: "string",
  website: "string",
  category: "string",
  thesis: "string",
  icp: "string",
  positioning: "string",
  discoveryQueries: "string[]",
});
export type SubjectProfile = typeof SubjectProfile.infer;

export const DiscoveredCompetitor = type({
  name: "string",
  "website?": "string",
  segment: CompetitorSegment,
  thesis: "string",
  whyCompetes: "string",
  "positioning?": "string",
  "strengths?": "string[]",
  "gaps?": "string[]",
  sources: "string[]",
});
export type DiscoveredCompetitor = typeof DiscoveredCompetitor.infer;

export const DiscoverResult = type({
  subjectName: "string",
  category: "string",
  notes: "string",
  competitors: DiscoveredCompetitor.array(),
});
export type DiscoverResult = typeof DiscoverResult.infer;

export const ReportCompetitor = type({
  name: "string",
  "website?": "string",
  segment: CompetitorSegment,
  whyCompetes: "string",
  "positioning?": "string",
  sources: "string[]",
});
export type ReportCompetitor = typeof ReportCompetitor.infer;

export const CompetitorReport = type({
  title: "string",
  content: "string",
  competitors: ReportCompetitor.array(),
});
export type CompetitorReport = typeof CompetitorReport.infer;

export const AgentReplyEnvelope = type({ reply: "string" });

export type Decoded<T> =
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: T };

export function stripCodeFence(text: string): string {
  const fenced = text.match(/^(```|~~~)[^\n]*\n([\s\S]*?)\n?\1\s*$/);
  return fenced?.[2]?.trim() ?? text;
}

export function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseAgentJson(
  reply: string,
):
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: unknown } {
  const trimmed = reply.trim();
  if (trimmed === "") return { status: "pending" };
  const unfenced = stripCodeFence(trimmed);
  const jsonText = extractFirstJsonValue(unfenced) ?? unfenced;
  try {
    return { status: "ok", value: JSON.parse(jsonText) };
  } catch {
    return { status: "malformed" };
  }
}

function parseReplyAs<T>(
  raw: unknown,
  schema: (value: unknown) => T | type.errors,
): Decoded<T> {
  const envelope = AgentReplyEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  const decoded = parseAgentJson(envelope.reply);
  if (decoded.status !== "ok") return decoded;
  const parsed = schema(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed };
}

export function parseSubjectProfile(raw: unknown): Decoded<SubjectProfile> {
  return parseReplyAs(raw, SubjectProfile);
}

export function parseDiscoverResult(raw: unknown): Decoded<DiscoverResult> {
  return parseReplyAs(raw, DiscoverResult);
}

export function parseCompetitorReport(raw: unknown): Decoded<CompetitorReport> {
  return parseReplyAs(raw, CompetitorReport);
}
