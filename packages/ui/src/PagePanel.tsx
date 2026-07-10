import type { ReactNode } from "react";
import { cn } from "./utils";

interface PagePanelProps {
  children: ReactNode;
  /**
   * When true the inner panel scrolls vertically; when false it clips overflow
   * and leaves scrolling to its own children (e.g. a header + scroll body).
   */
  scroll?: boolean;
  /** Drop the panel's drop shadow (some surfaces render flatter). */
  flat?: boolean;
  /**
   * Size the panel to its content instead of filling the viewport. Short pages
   * then leave no dead band below their last section. The framing border is
   * dropped in this mode so a content-height panel has no floating edge where
   * it stops — it blends into the identical `bg-bg` fill below it. Still capped
   * at the viewport (`max-h-full`), so overflowing content scrolls as normal.
   */
  fitContent?: boolean;
  className?: string;
}

/**
 * Standard page-content frame: a full-height outer fill plus a rounded, bordered
 * panel. Shared by the top-level pages so margins, radius, and background stay
 * consistent across them.
 */
export function PagePanel({
  children,
  scroll = true,
  flat = false,
  fitContent = false,
  className,
}: PagePanelProps) {
  const sizing = fitContent
    ? "w-full max-h-full self-start"
    : "flex-1 border border-border";
  let overflow = "overflow-hidden";
  if (scroll) {
    overflow = fitContent ? "overflow-y-auto" : "min-h-full overflow-y-auto";
  }
  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section
        className={cn(
          "flex flex-col bg-bg",
          sizing,
          overflow,
          !flat && "shadow-[var(--shadow)]",
          className,
        )}
      >
        {children}
      </section>
    </div>
  );
}
