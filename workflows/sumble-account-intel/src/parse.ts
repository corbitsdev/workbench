// Shared step-output parsers for the sumble-account-intel workflow.
//
// The run-page panel (`ui.tsx`) and the dock block builder (`blocks.ts`) both
// decode the SAME log-derived step outputs. The Sumble `resolve` and
// `search_people` tools emit STRUCTURED object content (`{ content: {...} }`),
// while the synthesis step emits an inline-inference reply (`{ reply: string }`
// carrying strict JSON). Extracting the parsers here keeps the two surfaces in
// lockstep.

import { type } from "arktype";

// A deterministic tool step's output is the ToolResult envelope. The Sumble
// tools this workflow decodes emit OBJECT content (not a JSON string), so
// `content` is `unknown` and the specific parser narrows it.
export const StructuredToolEnvelope = type({
  "callId?": "string",
  "content?": "unknown",
  "isError?": "boolean",
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

// Narrow a structured tool envelope to its object content. `pending` until the
// step has produced an output; `malformed` when the content is not an object
// (e.g. a degraded `isError` string envelope).
function structuredContent(
  raw: unknown,
):
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: Record<string, unknown> } {
  const envelope = StructuredToolEnvelope(raw);
  if (envelope instanceof type.errors) return { status: "pending" };
  const content = envelope.content;
  if (content === null || content === undefined) return { status: "pending" };
  if (typeof content !== "object" || Array.isArray(content)) {
    return { status: "malformed" };
  }
  return { status: "ok", value: content as Record<string, unknown> };
}

export function parseResolvedOrganization(
  raw: unknown,
): Decoded<ResolvedOrganization | null> {
  const decoded = structuredContent(raw);
  if (decoded.status !== "ok") return decoded;
  const parsed = ResolvedOrganization(decoded.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed };
}

// A single ranked contact row from the brief's `contactsCsv`, split into cells.
// The synthesize step emits a simple comma-separated CSV (header row +
// one row per contact); this renders it as a table for the human to review.
export interface ContactsTable {
  headers: string[];
  rows: string[][];
}

export function parseContactsCsv(csv: string): ContactsTable | null {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const split = (line: string): string[] =>
    line.split(",").map((cell) => cell.trim());
  const headers = split(lines[0] ?? "");
  const rows = lines.slice(1).map(split);
  return { headers, rows };
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
