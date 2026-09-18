// Turns the first message into a short sidebar title so an ad-hoc bench
// gets the same naming treatment as a prefab template, via the existing
// `patchWorkbenchSettings` rename path — no second rename API.

/** Placeholder title for an untitled / blank mint — never a prefab name. */
export const NEW_WORKBENCH_TITLE = "New Workbench";

/** Sidebar-friendly cap — long enough for a goal phrase, short enough to scan. */
export const AUTO_WORKBENCH_TITLE_MAX = 48;

// Truncates at a word boundary when the cut would land mid-word past
// halfway, appending an ellipsis.
export function titleFromFirstMessage(
  message: string,
  maxLength: number = AUTO_WORKBENCH_TITLE_MAX,
): string | undefined {
  const collapsed = message.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= maxLength) return collapsed;

  const sliced = collapsed.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > Math.floor(maxLength / 2) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:!?]+$/u, "")}…`;
}

// `undefined` unless the workbench is still the generic placeholder, so
// callers leave prefab (and already-renamed) titles alone.
export function autoNameFromFirstMessage(
  currentTitle: string,
  firstMessage: string,
): string | undefined {
  if (currentTitle !== NEW_WORKBENCH_TITLE) return undefined;
  return titleFromFirstMessage(firstMessage);
}
