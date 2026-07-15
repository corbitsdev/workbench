/**
 * Rolling activity label for a turn's ephemeral status line (CL-3668/CL-3673).
 *
 * The label is derived from the trailing part of the turn's ordered `parts`
 * array — a reasoning part contributes its latest meaningful line (low-signal
 * tool-discovery narration filtered, CL-3638), a tool part contributes a
 * formatted summary of the call. Replaces the old whole-string reasoning
 * regex-summarizer (`reasoning-summary.ts`) now that parts carry true order.
 */

import type { Part, ToolCall } from "./types";
import { toolPartToCall } from "./parts";

// Internal tool-discovery / plumbing narration the model emits between real
// reasoning. These read as debug logging to a user, so they are filtered from
// the rolling label (the full text still shows inside the expanded trace).
const LOW_SIGNAL_PATTERNS: readonly RegExp[] = [
  /^looking for tools?\b/iu,
  /^searching (?:skills|tools)\b/iu,
  /^finding (?:the )?tools?\b/iu,
  /^selecting tools?\b/iu,
  /^loading tools?\b/iu,
  /^bringing \d+ tools? online\b/iu,
  /^bringing tools? online\b/iu,
  /^getting that ready\b/iu,
  /^getting ready\b/iu,
  /^preparing tools?\b/iu,
];

/** Collapse a multi-line fragment to a single trimmed line. */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** True when a fragment is internal tool-discovery / plumbing narration. */
export function isLowSignalReasoning(fragment: string): boolean {
  const normalized = toSingleLine(fragment);
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function splitReasoningLines(text: string): string[] {
  return text
    .split(/\n+/u)
    .map((line) => line.replace(/^[#>*\-\s]+/u, "").trim())
    .filter((line) => line.length > 0);
}

// Drop repeated lines (first-occurrence order) so a model that re-emits an
// earlier step verbatim doesn't make the label roll backward to it.
function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = toSingleLine(line).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function lastMeaningfulReasoningLine(text: string): string | null {
  const lines = dedupeLines(splitReasoningLines(text));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && !isLowSignalReasoning(line)) {
      return toSingleLine(line);
    }
  }
  return null;
}

/**
 * The rolling activity label: derived from the trailing part that isn't the
 * answer text or a file. Text and file parts are skipped (they render
 * elsewhere, not as "activity"); walking backward from the end means a turn
 * that has settled onto an answer still reports its last real activity if
 * asked while streaming continues past it.
 *
 * Never surfaces a raw internal tool name: a tool part contributes a label
 * only through the host formatter or its human-authored `label`; otherwise
 * the walk continues to earlier parts and ultimately falls back to "Working".
 */
export function deriveActivityLabel(
  parts: Part[],
  formatToolSummary?: (call: ToolCall) => string,
): string {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part === undefined) continue;
    if (part.type === "reasoning") {
      const label = lastMeaningfulReasoningLine(part.text);
      if (label !== null) return label;
      continue;
    }
    if (part.type === "tool") {
      const call = toolPartToCall(part);
      if (formatToolSummary !== undefined) return formatToolSummary(call);
      if (call.label !== undefined) return call.label;
      continue;
    }
  }
  return "Working";
}
