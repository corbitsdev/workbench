import { type ComponentPropsWithoutRef, forwardRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "./utils";

/**
 * Shared, accessible dropdown/menu primitive built on Radix.
 *
 * Radix owns anchored positioning, focus management, keyboard navigation, and
 * dismissal. The styling layer gives every menu a branded, fully opaque surface
 * so popovers never render see-through over the page (the bug these primitives
 * replace).
 */

const Menu = DropdownMenu.Root;
const MenuTrigger = DropdownMenu.Trigger;
const MenuGroup = DropdownMenu.Group;
const MenuLabel = DropdownMenu.Label;

/** Opaque, branded popover surface shared by every menu. */
const MENU_SURFACE_CLASS =
  "wb-menu-surface z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-surface p-1 text-text shadow-lg";

const MenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(MENU_SURFACE_CLASS, className)}
      {...props}
    />
  </DropdownMenu.Portal>
));
MenuContent.displayName = "MenuContent";

const MENU_ITEM_CLASS =
  "flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-text outline-none transition-colors data-[highlighted]:bg-row-hover data-[highlighted]:text-text data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DropdownMenu.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Item
    ref={ref}
    className={cn(MENU_ITEM_CLASS, className)}
    {...props}
  />
));
MenuItem.displayName = "MenuItem";

const MenuSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DropdownMenu.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenu.Separator
    ref={ref}
    className={cn("my-1 h-px bg-border", className)}
    {...props}
  />
));
MenuSeparator.displayName = "MenuSeparator";

export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuGroup,
  MenuLabel,
};
