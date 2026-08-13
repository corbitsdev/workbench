import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@corbits/react-ui";

import { restoreFocus } from "./focus-restore";
import type { ContextMenu } from "./menu";

/**
 * Renders a `ContextMenu` at a fixed screen point using react-ui's
 * `Menu` (Radix `DropdownMenu`) rather than a hand-rolled popover: Radix
 * already owns anchored positioning that stays on screen, focus management,
 * arrow-key navigation, and closing on Escape or an outside click, and it
 * shares its dismissable-layer stack with react-ui's `Dialog` — the same
 * stack the command palette's dialog uses — so a context menu never
 * out-races a dialog on Escape. The only custom part is anchoring the
 * (Radix-required) trigger to the click point instead of a visible button:
 * that anchor is an inert, unfocusable point, so Radix's default
 * close-focus-the-trigger behavior is overridden to focus `restoreFocusTo`
 * (the row that was right-clicked) instead.
 */
export function ContextMenuView({
  x,
  y,
  menu,
  open,
  onOpenChange,
  restoreFocusTo = null,
}: {
  readonly x: number;
  readonly y: number;
  readonly menu: ContextMenu | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly restoreFocusTo?: Element | null;
}) {
  if (menu === null) return null;
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <span
          aria-hidden="true"
          style={{
            position: "fixed",
            left: x,
            top: y,
            width: 1,
            height: 1,
            pointerEvents: "none",
          }}
        />
      </MenuTrigger>
      <MenuContent
        align="start"
        side="bottom"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus(restoreFocusTo);
        }}
      >
        {menu.label !== undefined ? <MenuLabel>{menu.label}</MenuLabel> : null}
        {menu.entries.map((entry, index) =>
          entry.kind === "separator" ? (
            <MenuSeparator key={`separator-${index}`} />
          ) : (
            <MenuItem key={entry.id} onSelect={entry.onSelect}>
              {entry.icon}
              <span>{entry.label}</span>
              {entry.shortcut !== undefined ? (
                <span className="context-menu-shortcut">{entry.shortcut}</span>
              ) : null}
            </MenuItem>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}
