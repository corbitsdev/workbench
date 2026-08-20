import type { ReactNode } from "react";

/** One actionable row. Every entry must be a real, already-wired action —
 * this type carries no "not implemented yet" state on purpose. */
export type ContextMenuItem = {
  readonly kind: "item";
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly shortcut?: string;
  readonly onSelect: () => void;
  /** Marks a destructive action (e.g. "Sign out", "Delete") so the view can
   * render it in the theme's destructive color instead of the default. */
  readonly danger?: boolean;
};

export type ContextMenuSeparator = {
  readonly kind: "separator";
};

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export type ContextMenu = {
  readonly label?: string;
  readonly entries: readonly ContextMenuEntry[];
};

export function contextMenuItem(
  item: Omit<ContextMenuItem, "kind">,
): ContextMenuItem {
  return { kind: "item", ...item };
}

export const contextMenuSeparator: ContextMenuSeparator = {
  kind: "separator",
};

/** A menu with no items has nothing to show — the trigger hook uses this to
 * decide whether to intercept the native context menu at all. */
export function isContextMenuEmpty(menu: ContextMenu | null): boolean {
  return (
    menu === null || menu.entries.every((entry) => entry.kind === "separator")
  );
}
