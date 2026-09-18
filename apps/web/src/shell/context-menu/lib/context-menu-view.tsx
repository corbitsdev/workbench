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

// Uses react-ui's Radix-backed `Menu`, not a hand-rolled popover: it
// shares a dismissable-layer stack with the command palette's dialog, so
// a context menu never out-races it on Escape.
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
            <MenuItem
              key={entry.id}
              onSelect={entry.onSelect}
              className={
                entry.danger === true
                  ? "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
                  : undefined
              }
            >
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
