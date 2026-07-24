import { type } from "arktype";

/** One participant/task actor: an assignee is matched to a member downstream
 * by email first, then unambiguous name. */
export const CallActionSchema = type({
  description: "string",
  "assignee?": "string",
});
export type CallAction = typeof CallActionSchema.infer;

/** The reasoning turn's structured output (parsed at the LLM boundary). */
export const CallAnalysisSchema = type({
  summary: "string",
  painPoints: "string[]",
  decisions: "string[]",
  actionItems: CallActionSchema.array(),
  tasks: CallActionSchema.array(),
  peopleMentioned: "string[]",
});
export type CallAnalysis = typeof CallAnalysisSchema.infer;

/** A Granola call as the pipeline/workflow consumes it — the subset of a note
 * reasoned over. Parsed from the Granola tool response at the source boundary. */
export const GranolaCallSchema = type({
  id: "string",
  "title?": "string | null",
  "summary?": "string",
  "participants?": "string[]",
  "createdAt?": "string",
  "transcript?": "string",
});
export type GranolaCall = typeof GranolaCallSchema.infer;

/** internal = every resolvable attendee shares the tenant domain; external =
 * at least one attendee is off-domain; unknown = no attendee email to judge. */
export type CallClassification = "internal" | "external" | "unknown";

/** Typed artifact kinds produced per processed Granola call (CL-3647). Distinct
 * from the legacy combined `granola-call` kind kept for backward compatibility. */
export const GRANOLA_CALL_ARTIFACT_KINDS = {
  painPoints: "granola-call-pain-points",
  summary: "granola-call-summary",
  brief: "granola-call-brief",
} as const;

export type GranolaCallArtifactKind =
  (typeof GRANOLA_CALL_ARTIFACT_KINDS)[keyof typeof GRANOLA_CALL_ARTIFACT_KINDS];

export const ANALYSIS_SYSTEM_PROMPT = `You analyze a sales/meeting call transcript and return STRICT JSON only (no prose, no code fences).

Return an object with these keys:
- "summary": a concise plain-text summary of the call (3-6 sentences).
- "painPoints": string[] — customer pain points / problems raised.
- "decisions": string[] — decisions made on the call.
- "actionItems": { "description": string, "assignee"?: string }[] — near-term action items. Set "assignee" to the person's name or email when the transcript makes it clear who owns it; omit otherwise.
- "tasks": { "description": string, "assignee"?: string }[] — concrete follow-up tasks (may overlap conceptually with action items but should be the trackable work).
- "peopleMentioned": string[] — names or emails of people discussed but not necessarily attendees.

Output ONLY the JSON object.`;

function emailDomain(participant: string): string | null {
  const at = participant.lastIndexOf("@");
  if (at < 0 || at === participant.length - 1) return null;
  return participant.slice(at + 1).toLowerCase();
}

/** Deterministic internal/external classification from attendee email domains
 * vs the tenant domain. No inference — a pure metadata rule. */
export function classifyCall(
  participants: readonly string[],
  tenantDomain: string,
): CallClassification {
  const domain = tenantDomain.trim().toLowerCase();
  // Without a tenant domain we cannot judge internal vs external.
  if (domain.length === 0) return "unknown";
  const domains = participants
    .map(emailDomain)
    .filter((d): d is string => d !== null);
  if (domains.length === 0) return "unknown";
  return domains.every((d) => d === domain) ? "internal" : "external";
}

/** Per-kind `artifact.source_ref` for one typed Granola call artifact. Rides
 * `artifact_tenant_source_ref_uniq` (migration 0055) for idempotent re-runs. */
export function granolaCallSourceRef(noteId: string, kind: string): string {
  return `granola:call:${noteId}:${kind}`;
}

/** Task-row `sourceRef` for one action item derived from a call, keyed by a
 * stable index so re-runs do not create duplicate tasks. */
export function granolaTaskSourceRef(noteId: string, index: number): string {
  return `granola:call:${noteId}:task:${index}`;
}

/** Display title for a typed call artifact: `"<title> — <suffix>"`, falling
 * back to `"Call"` when the note has no title. */
export function granolaCallArtifactTitle(
  callTitle: string | null | undefined,
  suffix: string,
): string {
  const title = callTitle?.trim() ? callTitle.trim() : "Call";
  return `${title} — ${suffix}`;
}

export function buildCallAnalysisUserMessage(note: GranolaCall): string {
  const parts = [
    `Title: ${note.title ?? "(untitled)"}`,
    note.participants && note.participants.length > 0
      ? `Attendees: ${note.participants.join(", ")}`
      : "Attendees: (unknown)",
    "",
    note.summary ? `Existing summary:\n${note.summary}` : "",
    note.transcript ? `Transcript:\n${note.transcript}` : "",
  ];
  return parts.filter((p) => p !== "").join("\n");
}

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? trimmed).trim();
}

/** Strip optional code fences, JSON.parse, and validate against
 * {@link CallAnalysisSchema}. Throws a clear Error on parse or schema failure. */
export function parseCallAnalysis(raw: string): CallAnalysis {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripJsonFences(raw));
  } catch {
    throw new Error("Call analysis returned non-JSON output");
  }
  const analysis = CallAnalysisSchema(parsedJson);
  if (analysis instanceof type.errors) {
    throw new Error(
      `Call analysis JSON failed validation: ${analysis.summary}`,
    );
  }
  return analysis;
}

function bullets(items: readonly string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- (none)";
}

function actions(items: readonly CallAction[]): string {
  return items.length > 0
    ? items
        .map(
          (i) =>
            `- ${i.description}${i.assignee ? ` (owner: ${i.assignee})` : ""}`,
        )
        .join("\n")
    : "- (none)";
}

function peopleLine(note: GranolaCall): string {
  return note.participants && note.participants.length > 0
    ? `People: ${note.participants.join(", ")}`
    : "";
}

export function renderPainPointsContent(
  note: GranolaCall,
  classification: CallClassification,
  analysis: CallAnalysis,
): string {
  return [
    `# ${note.title ?? "Call"} — Pain Points`,
    "",
    `Classification: ${classification}`,
    peopleLine(note),
    "",
    "## Pain points",
    bullets(analysis.painPoints),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function renderSummaryContent(
  note: GranolaCall,
  classification: CallClassification,
  analysis: CallAnalysis,
): string {
  return [
    `# ${note.title ?? "Call"} — Summary`,
    "",
    `Classification: ${classification}`,
    peopleLine(note),
    "",
    "## Summary",
    analysis.summary,
    "",
    "## Decisions",
    bullets(analysis.decisions),
    "",
    "## Action items",
    actions(analysis.actionItems),
    "",
    "## Tasks",
    actions(analysis.tasks),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Full call brief — the combined view previously stored under the legacy
 * `granola-call` kind. */
export function renderBriefContent(
  note: GranolaCall,
  classification: CallClassification,
  analysis: CallAnalysis,
): string {
  return [
    `# ${note.title ?? "Call"}`,
    "",
    `Classification: ${classification}`,
    peopleLine(note),
    "",
    "## Summary",
    analysis.summary,
    "",
    "## Pain points",
    bullets(analysis.painPoints),
    "",
    "## Decisions",
    bullets(analysis.decisions),
    "",
    "## Action items",
    actions(analysis.actionItems),
    "",
    "## Tasks",
    actions(analysis.tasks),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
