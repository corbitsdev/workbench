import { type ComponentPropsWithoutRef } from "react";
import { cn } from "./utils";

/**
 * A token-driven shimmer placeholder for loading content. Renders on the
 * `surface-2` token with a `pulse` animation and inherits sizing/shape from the
 * caller's className (height, width, radius). Marked `aria-hidden` so screen
 * readers announce a sibling `aria-live` status, not the shimmer geometry.
 */
export function Skeleton({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-testid="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-[8px] bg-surface-2", className)}
      {...props}
    />
  );
}
