// Shared step-output parsers for the pain-point-collateral workflow (CL-2775).
//
// The run-page panel (`ui.tsx`) and the dock block builder (`blocks.ts`) both
// decode the SAME log-derived step outputs — a Granola tool result envelope
// (`{ content: string }`), an agentStep reply (`{ reply: string }`), and
// the generate map's array of replies. Extracting the parsers here keeps the two
// surfaces in lockstep: a shape change is made once, and both the panel and the
// blocks read the identical decoded values.

import { type } from "arktype";

// -------------------------------------------------------------------------
// Arktype schemas — parse every untrusted stepOutput
// -------------------------------------------------------------------------

export const ToolResultEnvelope = type({ content: "string" });

export const GranolaNote = type({
  id: "string",
  "title?": "string | null",
  "created_at?": "string",
  "summary?": "string",
});
export type GranolaNote = typeof GranolaNote.infer;

export const GranolaListContent = type({ notes: GranolaNote.array() });

export const GranolaNoteDetail = type({
  "id?": "string",
  "title?": "string | null",
  "summary?": "string",
  "transcript?": "string",
});

export const PainPoint = type({
  id: "string",
  title: "string",
  detail: "string",
  "severity?": "'low' | 'medium' | 'high' | 'critical'",
});
export type PainPoint = typeof PainPoint.infer;

export const AnalyzeOutput = type({ painPoints: PainPoint.array() });

export const GeneratedPiece = type({
  format: "string",
  title: "string",
  content: "string",
});
export type GeneratedPiece = typeof GeneratedPiece.infer;

export const AgentReplyEnvelope = type({ reply: "string" });

export const ReviewDecision = type({
  format: "string",
  title: "string",
  content: "string",
  approved: "boolean",
});

export const ApprovedPiece = type({
  format: "string",
  title: "string",
  content: "string",
});

export const PersistOutput = type({
  decisions: ReviewDecision.array(),
  "approvedPieces?": ApprovedPiece.array(),
});

export const PpSelectionOutput = type({ selectedIds: "string[]" });

// -------------------------------------------------------------------------
// Output parsing helpers
// -------------------------------------------------------------------------

export type Decoded<T> =
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: T };

export function decodeToolEnvelope(
  raw: unknown,
):
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: unknown } {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  try {
    return { status: "ok", value: JSON.parse(envelope.content) };
  } catch {
    return { status: "malformed" };
  }
}

export function parseNoteList(raw: unknown): Decoded<GranolaNote[]> {
  const decoded = decodeToolEnvelope(raw);
  if (decoded.status !== "ok") return decoded;
  const parsed = GranolaListContent(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.notes };
}

export function parseFetchedNote(
  raw: unknown,
): Decoded<typeof GranolaNoteDetail.infer> {
  const decoded = decodeToolEnvelope(raw);
  if (decoded.status !== "ok") return decoded;
  const parsed = GranolaNoteDetail(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed };
}

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

export function parseAnalyze(raw: unknown): Decoded<PainPoint[]> {
  // Agent step: output is { reply: string } — parse JSON from reply
  const envelope = AgentReplyEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  const decoded = parseAgentJson(envelope.reply);
  if (decoded.status !== "ok") return decoded;
  const parsed = AnalyzeOutput(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.painPoints };
}

export function parseGeneratedPieces(raw: unknown): Decoded<GeneratedPiece[]> {
  // map step output is Array<{reply: string, turn: unknown}>, one entry per (pain point × format) item
  if (!Array.isArray(raw)) return { status: "pending" };
  if (raw.length === 0) return { status: "pending" };
  const pieces: GeneratedPiece[] = [];
  for (const item of raw) {
    const envelope = AgentReplyEnvelope(item);
    if (envelope instanceof type.errors) continue;
    const decoded = parseAgentJson(envelope.reply);
    if (decoded.status !== "ok") continue;
    const parsed = GeneratedPiece(decoded.value);
    if (parsed instanceof type.errors) continue;
    pieces.push(parsed);
  }
  if (pieces.length === 0) return { status: "malformed" };
  return { status: "ok", value: pieces };
}

export function parsePersistOutput(
  raw: unknown,
): Decoded<typeof PersistOutput.infer> {
  const parsed = PersistOutput(raw);
  if (parsed instanceof type.errors) return { status: "pending" };
  return { status: "ok", value: parsed };
}
