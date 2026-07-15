/**
 * Reasoning summarization for the turn activity block.
 *
 * The agent's reasoning arrives as one cumulative markdown string (see
 * createPartAssembler). For the collapsed activity block we surface a single
 * rolling label — the latest *meaningful* step — while the full raw trace stays
 * available on expand. Low-signal tool-discovery narration ("Looking for tools
 * about X", "Bringing 4 tools online") is filtered from the label so it never
 * reads as debug logging (CL-3638).
 */

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

/** True when a fragment is internal tool-discovery / plumbing narration. */
export function isLowSignalReasoning(fragment: string): boolean {
  const normalized = toSingleLine(fragment);
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Drop repeated fragments, keeping the first occurrence's order. */
export function dedupeReasoningSteps(steps: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of steps) {
    const key = toSingleLine(step).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(step);
  }
  return out;
}

/**
 * The rolling label for the collapsed activity block: the latest meaningful
 * reasoning step, with low-signal narration filtered out and duplicates
 * removed. Returns null when the trace is empty or entirely low-signal, so the
 * caller can fall back to a tool/generic label.
 */
export function rollingReasoningLabel(text: string): string | null {
  const steps = dedupeReasoningSteps(splitReasoningSteps(text));
  if (steps.length === 0) return null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step !== undefined && !isLowSignalReasoning(step)) {
      return toSingleLine(step);
    }
  }
  return null;
}
