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
   * Size the panel to its content instead of filling the viewport height. The
   * frame ends where the content ends (no dead full-height scrollport when the
   * content is short) and the panel itself scrolls once content exceeds the
   * available height. Overrides `scroll`.
   */
  fitContent?: boolean;
  className?: string;
}

function frameSizingClass(scroll: boolean, fitContent: boolean): string {
  if (fitContent) return "max-h-full self-start overflow-y-auto";
  if (scroll) return "min-h-full overflow-y-auto";
  return "overflow-hidden";
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
  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section
        className={cn(
          "flex flex-1 flex-col border border-border bg-bg",
          frameSizingClass(scroll, fitContent),
          !flat && "shadow-[var(--shadow)]",
          className,
        )}
      >
        {children}
      </section>
    </div>
  );
}
