// A clickable `TableRow` (library, agents, skills) needs the same three
// things to be keyboard-operable: an accessible role, a tab stop, and
// Enter/Space activation. Pure so the "which keys activate a row" rule is
// testable without rendering a table.
import type { KeyboardEvent } from "react";

export function isRowActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
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
