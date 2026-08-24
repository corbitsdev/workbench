// CL-6656: ad-hoc ("Just start talking") benches mint as "New Workbench" and
// used to stay that way in the sidebar. Prefab templates already name the
// room after the template title; this helper turns the person's first message
// into a short sidebar title so blank benches get the same treatment once
// that message is known (at create) — without inventing a second rename API.
// Callers apply the result through `patchWorkbenchSettings` the same way the
// sidebar rename does (`chat/name`).

/** Placeholder title for an untitled / blank mint — never a prefab name. */
export const NEW_WORKBENCH_TITLE = "New Workbench";

/** Sidebar-friendly cap — long enough for a goal phrase, short enough to scan. */
export const AUTO_WORKBENCH_TITLE_MAX = 48;

/**
 * Collapse a first user message into a short workbench title.
 * Returns `undefined` when there is nothing worth naming with (blank /
 * whitespace-only). Truncates at a word boundary when the cut would land
 * mid-word past halfway, and appends an ellipsis when truncated.
 */
export function titleFromFirstMessage(
  message: string,
  maxLength: number = AUTO_WORKBENCH_TITLE_MAX,
): string | undefined {
  const collapsed = message.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= maxLength) return collapsed;

  const sliced = collapsed.slice(0, maxLength);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut =
    lastSpace > Math.floor(maxLength / 2) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:!?]+$/u, "")}…`;
}

/**
 * What an ad-hoc auto-name should PATCH as `chat/name`: the derived title when
 * the room is still the generic "New Workbench" placeholder, otherwise
 * `undefined` so callers leave prefab (and already-renamed) titles alone.
 */
export function autoNameFromFirstMessage(
  currentTitle: string,
  firstMessage: string,
): string | undefined {
  if (currentTitle !== NEW_WORKBENCH_TITLE) return undefined;
  return titleFromFirstMessage(firstMessage);
}
