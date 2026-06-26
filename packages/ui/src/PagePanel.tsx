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
  className,
}: PagePanelProps) {
  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section
        className={cn(
          "flex flex-1 flex-col rounded-panel border border-border bg-bg",
          scroll ? "min-h-full overflow-y-auto" : "overflow-hidden",
          !flat && "shadow-[var(--shadow)]",
          className,
        )}
      >
        {children}
      </section>
    </div>
  );
}
