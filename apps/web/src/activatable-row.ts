// Pure so "which keys activate a row" is testable without a table render.
import type { KeyboardEvent } from "react";

export function isRowActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

// Ctrl-click is additive only on non-Mac; on Mac it's the context-menu
// gesture, and treating it as additive there would toggle the row the
// context menu is about to act on.
export function isAdditiveSelectClick(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): boolean {
  return event.metaKey || (!isMacPlatform() && event.ctrlKey);
}

function isMacPlatform(): boolean {
  // Browsers report "MacIntel"; happy-dom (our test DOM) reports
  // "X11; Darwin arm64" — both are the same Ctrl-click-is-context-menu OS.
  return typeof navigator !== "undefined" && /mac|darwin/i.test(navigator.platform);
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
