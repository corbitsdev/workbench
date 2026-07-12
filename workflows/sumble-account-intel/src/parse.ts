// Shared step-output parsers for the sumble-account-intel workflow.
//
// The run-page panel (`ui.tsx`) and the dock block builder (`blocks.ts`) both
// decode the SAME log-derived step outputs — a Sumble tool result envelope
// (`{ content: string }` carrying JSON) and the synthesis step's inline-inference
// reply (`{ reply: string }` carrying strict JSON). Extracting the parsers here
// keeps the two surfaces in lockstep.

import { type } from "arktype";

export const ToolResultEnvelope = type({
  "callId?": "string",
  content: "string",
});

export const ResolvedOrganization = type({
  "name?": "string | null",
  "slug?": "string | null",
  "url?": "string | null",
  "industry?": "string | null",
  "employee_count?": "number | null",
});
export type ResolvedOrganization = typeof ResolvedOrganization.infer;

export const AccountBrief = type({
  title: "string",
  content: "string",
  contactsCsv: "string",
  slackDraft: "string",
});
export type AccountBrief = typeof AccountBrief.infer;

export const AgentReplyEnvelope = type({ reply: "string" });

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

export function parseResolvedOrganization(
  raw: unknown,
): Decoded<ResolvedOrganization | null> {
  const decoded = decodeToolEnvelope(raw);
  if (decoded.status !== "ok") return decoded;
  if (decoded.value === null) return { status: "ok", value: null };
  const parsed = ResolvedOrganization(decoded.value);
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

export function parseAccountBrief(raw: unknown): Decoded<AccountBrief> {
  const envelope = AgentReplyEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  const decoded = parseAgentJson(envelope.reply);
  if (decoded.status !== "ok") return decoded;
  const parsed = AccountBrief(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed };
}
