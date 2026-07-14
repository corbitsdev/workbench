/**
 * Reasoning summarization for the turn activity block.
 *
 * The agent's reasoning arrives as one cumulative markdown string (see
 * createReasoningTracker). For the collapsed activity block we surface a single
 * rolling label — the latest *meaningful* step — while the full raw trace stays
 * available on expand. Low-signal tool-discovery narration ("Looking for tools
 * about X", "Bringing 4 tools online") is filtered from the label so it never
 * reads as debug logging (CL-3638).
 */

/** Split cumulative reasoning text into trimmed, markdown-stripped step lines. */
export function splitReasoningSteps(text: string): string[] {
  return text
    .split(/\n+/u)
    .map((line) => line.replace(/^[#>*\-\s]+/u, "").trim())
    .filter((line) => line.length > 0);
}

/** Collapse a multi-line fragment to a single trimmed line. */
export function toSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * The rolling label for the collapsed activity block: the latest step from the
 * reasoning trace. Enhanced with low-signal filtering + dedupe in CL-3638.
 */
export function rollingReasoningLabel(text: string): string | null {
  const steps = splitReasoningSteps(text);
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  if (last === undefined) return null;
  return toSingleLine(last);
}
