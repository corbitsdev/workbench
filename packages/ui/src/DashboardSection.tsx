import type { ReactNode } from "react";
import { cn } from "./utils";

export type DashboardSectionVariant = "plain" | "highlighted";

export interface DashboardSectionProps {
  /** Section heading (dashboard caption style). */
  title: ReactNode;
  /** Optional supporting copy under the title. */
  description?: ReactNode;
  /** Optional header actions (filters, links) aligned to the title row. */
  action?: ReactNode;
  /**
   * `highlighted` adds a bordered gradient shell (KPI band). `plain` is the
   * default section stack used across Insights.
   */
  variant?: DashboardSectionVariant;
  children: ReactNode;
  className?: string;
}

/**
 * Dashboard section shell: caption title, optional description and actions, and a
 * consistent vertical rhythm for composed blocks beneath.
 */
export function DashboardSection({
  title,
  description,
  action,
  variant = "plain",
  children,
  className,
}: DashboardSectionProps) {
  const shell =
    variant === "highlighted"
      ? "rounded-[16px] border border-border bg-gradient-to-b from-surface-2 to-surface p-4 max-md:p-3"
      : "";

  return (
    <section
      className={cn("flex flex-col gap-4", shell, className)}
      data-testid="dashboard-section"
      data-variant={variant}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
            {title}
          </h2>
          {description ? (
            <p className="text-[13px] leading-snug text-text-2">{description}</p>
          ) : null}
        </div>
        {action ? (
          <div className="flex shrink-0 items-center gap-2">{action}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}