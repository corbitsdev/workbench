import type { ReactNode } from "react";
import { cn } from "./utils";
import { StatSparkline } from "./StatSparkline";

export type StatGridColumns = 2 | 3 | 4 | 5;

const COLUMN_CLASS: Record<StatGridColumns, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-5",
};

export interface StatGridProps {
  children: ReactNode;
  /** Responsive column count; defaults to four-up on wide screens. */
  columns?: StatGridColumns;
  className?: string;
}

export function StatGrid({ children, columns = 4, className }: StatGridProps) {
  return (
    <div
      className={cn("grid gap-3", COLUMN_CLASS[columns], className)}
      data-testid="stat-grid"
    >
      {children}
    </div>
  );
}

function statValueClass(accent?: boolean, danger?: boolean): string {
  if (danger) return "text-red";
  if (accent) return "text-accent";
  return "text-text";
}

export interface StatGridItemProps {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Orange action tone — reserve for genuine action/positive emphasis. */
  accent?: boolean;
  /** Semantic danger (red) — failure counts, not the action accent. */
  danger?: boolean;
  /** Headline tile: larger value + padding. */
  emphasis?: boolean;
  /** Optional period-over-period badge (caller supplies markup). */
  delta?: ReactNode;
  /** Custom sparkline slot; overrides `sparklineValues` when both are set. */
  sparkline?: ReactNode;
  /** When set (and `sparkline` is omitted), renders the built-in trend line. */
  sparklineValues?: number[];
  sparklineLabel?: string;
  className?: string;
}

export function StatGridItem({
  label,
  value,
  sub,
  accent,
  danger,
  emphasis,
  delta,
  sparkline,
  sparklineValues,
  sparklineLabel,
  className,
}: StatGridItemProps) {
  const sparklineNode =
    sparkline ??
    (sparklineValues && sparklineValues.length > 0 ? (
      <StatSparkline
        values={sparklineValues}
        label={sparklineLabel ?? `${label} trend`}
      />
    ) : null);

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-[12px] border border-border bg-surface",
        emphasis ? "p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]" : "p-4",
        className,
      )}
      data-testid="stat-grid-item"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
        {label}
      </span>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-black leading-none tabular-nums",
            emphasis ? "text-[34px]" : "text-[26px]",
            statValueClass(accent, danger),
          )}
        >
          {value}
        </span>
        {delta}
      </div>
      {sparklineNode ? <div className="mt-0.5">{sparklineNode}</div> : null}
      {sub ? (
        <span className="text-[10px] uppercase tracking-[0.08em] text-text-3">
          {sub}
        </span>
      ) : null}
    </div>
  );
}
