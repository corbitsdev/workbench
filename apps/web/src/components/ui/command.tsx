import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@workbench/ui";

// shadcn `Command` component family (https://ui.shadcn.com/docs/components/radix/command)
// adapted to the workbench brand tokens in packages/ui/src/styles.css. It wraps
// cmdk through the shadcn component API so palette surfaces consume these
// primitives instead of cmdk directly. `CommandDialog` (shadcn's Radix-Dialog
// overlay) is intentionally not provided: the global palette must keep
// combobox/listbox a11y semantics (not a dialog), so it supplies its own overlay
// and renders `Command`/`CommandList` inside.

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-panel bg-surface text-text",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center gap-2.5 border-b border-border px-4 py-3"
    >
      <Search size={16} className="flex-none text-text-3" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex w-full bg-transparent text-sm text-text outline-none placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[70vh] flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-2",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-10 text-center text-xs text-text-3", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "mb-1 text-text [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-3",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-2 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "flex min-h-[40px] w-full cursor-pointer select-none items-center gap-3 rounded-sm px-2.5 py-2 text-left text-sm text-text outline-none transition-colors hover:bg-row-hover data-[selected=true]:bg-orange/15 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto text-xs tracking-widest text-text-3", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
};
