/** Max length for a first-message fallback title (matches hub CL-2805). */
export const MYRA_THREAD_TITLE_FALLBACK_MAX_CHARS = 48;

const DEFAULT_MYRA_THREAD_LABEL = /^Chat( \d+)?$/;

/** True when the label is still the auto-assigned default (`Chat`, `Chat 2`, …). */
export function isDefaultMyraThreadLabel(label: string): boolean {
  return DEFAULT_MYRA_THREAD_LABEL.test(label.trim());
}

/**
 * Deterministic sidebar title from the user's first message — used for optimistic
 * UI updates and as the hub's LLM fallback.
 */
export function myraThreadTitleFromFirstMessage(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MYRA_THREAD_TITLE_FALLBACK_MAX_CHARS) {
    return collapsed.replace(/[.!?,;:]+$/u, "").trim() || collapsed;
  }
  const slice = collapsed.slice(0, MYRA_THREAD_TITLE_FALLBACK_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const cut =
    lastSpace >= MYRA_THREAD_TITLE_FALLBACK_MAX_CHARS / 2
      ? slice.slice(0, lastSpace)
      : slice;
  return cut.replace(/[.!?,;:]+$/u, "").trim() || cut;
}
