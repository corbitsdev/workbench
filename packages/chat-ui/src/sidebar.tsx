// Pure helpers for workbench-row menus. The page-local ChatSidebar surface is
// gone — the app shell's panel contributions own the workbench list.

import type { Workbench } from "./api";
import { CHAT_STRINGS } from "./strings";

/**
 * The row menu's item labels for a given workbench, pure so its pinned-state
 * wording ("Pin" vs "Unpin") is testable without opening the (portaled,
 * Radix-controlled) menu itself.
 */
export function rowMenuLabels(
  workbench: Pick<Workbench, "pinned">,
): readonly [rename: string, pin: string, settings: string] {
  return [
    CHAT_STRINGS.rowMenuRename,
    workbench.pinned ? CHAT_STRINGS.rowMenuUnpin : CHAT_STRINGS.rowMenuPin,
    CHAT_STRINGS.rowMenuSettings,
  ];
}

/**
 * What a rename submission should send: `undefined` for input that resolves
 * to nothing worth saving (blank, or unchanged from the workbench's current
 * title) — the caller's cue to treat the rename as a no-op cancel rather
 * than an empty-name PATCH.
 */
export function renamePayload(
  input: string,
  currentTitle: string,
): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === currentTitle) return undefined;
  return trimmed;
}
