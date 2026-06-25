import { type ComponentPropsWithoutRef } from "react";
import { cn } from "@workbench/ui";

/** Minimal stateless label, styled to match the workbench form conventions. */
export function Label({
  className,
  ...props
}: ComponentPropsWithoutRef<"label">) {
  return (
    <label
      className={cn("text-sm font-medium text-text", className)}
      {...props}
    />
  );
}

/** Minimal stateless text input, styled to match the workbench form conventions. */
export function Input({
  className,
  ...props
}: ComponentPropsWithoutRef<"input">) {
  return (
    <input
      className={cn(
        "rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange",
        className,
      )}
      {...props}
    />
  );
}
