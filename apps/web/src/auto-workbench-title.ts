// Turns the first message into a short sidebar title so an ad-hoc bench
// gets the same naming treatment as a prefab template, via the existing
// `patchWorkbenchSettings` rename path — no second rename API.

/** Placeholder title for an untitled / blank mint — never a prefab name. */
export const NEW_WORKBENCH_TITLE = "New Workbench";

/** Sidebar-friendly cap — long enough for a goal phrase, short enough to scan. */
export const AUTO_WORKBENCH_TITLE_MAX = 40;

const LEADING_FILLER =
  /^(?:(?:hey|hi|hello|so|ok|okay)[,\s]+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|pls\s+|i(?:'d| would)? (?:like|want|need) (?:you )?to\s+)+(?:please\s+)?/iu;

// First sentence or clause, filler stripped, first letter capitalised, cut at
// a word boundary with an ellipsis when it still exceeds the cap.
export function titleFromFirstMessage(
  message: string,
  maxLength: number = AUTO_WORKBENCH_TITLE_MAX,
): string | undefined {
  const collapsed = message.trim().replace(/\s+/g, " ");
  const clause = (collapsed.split(/[.!?:;]+(?:\s|$)|\s[-—–]\s/u)[0] ?? "").replace(
    LEADING_FILLER,
    "",
  );
  const cleaned = clause.replace(/[\s.,;:!?]+$/u, "");
  if (cleaned.length === 0) return undefined;
  const title = cleaned.charAt(0).toLocaleUpperCase() + cleaned.slice(1);
  if (title.length <= maxLength) return title;

  const sliced = title.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > Math.floor(maxLength / 2) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[\s.,;:!?]+$/u, "")}…`;
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
