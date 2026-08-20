// A clickable `TableRow` (library, agents, skills) needs the same three
// things to be keyboard-operable: an accessible role, a tab stop, and
// Enter/Space activation. Pure so the "which keys activate a row" rule is
// testable without rendering a table.
import type { KeyboardEvent } from "react";

export function isRowActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * Whether a click's modifiers mean "add this row to the selection" rather
 * than "activate/replace". Cmd-click is the additive gesture on every
 * platform; Ctrl-click only joins in on non-Mac, because on Mac Ctrl-click
 * is the native context-menu gesture — the browser can fire `click` and
 * `contextmenu` from the same physical click, and treating Ctrl as additive
 * there would silently toggle the very row the context menu is about to
 * act on.
 */
export function isAdditiveSelectClick(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): boolean {
  return event.metaKey || (!isMacPlatform() && event.ctrlKey);
}

function isMacPlatform(): boolean {
  // Browsers report "MacIntel"; happy-dom (our test DOM) reports
  // "X11; Darwin arm64" — both are the same Ctrl-click-is-context-menu OS.
  return (
    typeof navigator !== "undefined" && /mac|darwin/i.test(navigator.platform)
  );
}

export function rowActivationProps(onSelect: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onSelect,
    onKeyDown: (event: KeyboardEvent) => {
      if (!isRowActivationKey(event.key)) return;
      event.preventDefault();
      onSelect();
    },
  };
}
