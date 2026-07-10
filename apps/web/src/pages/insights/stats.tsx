import { AlertTriangle } from "lucide-react";

import type { DeltaResult } from "./metrics";
import { DeltaBadge, Sparkline } from "./viz";

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
      {children}
    </span>
  );
}

export function CaveatNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="flex items-start gap-1.5 text-[11px] leading-snug text-text-3"
      data-testid="data-caveat"
    >
      <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-text-3" />
      <span>{children}</span>
    </p>
  );
}

export function HudCard({
  label,
  tag,
  children,
  className = "",
}: {
  label?: string;
  tag?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-[12px] border border-border bg-surface p-4 ${className}`}
    >
      {(label || tag) && (
        <div className="flex items-center justify-between">
          {label ? <CardLabel>{label}</CardLabel> : <span />}
          {tag}
        </div>
      )}
      {children}
    </div>
  );
}

function statValueClass(accent?: boolean, danger?: boolean): string {
  if (danger) return "text-red";
  if (accent) return "text-accent";
  return "text-text";
}

export function Stat({
  label,
  value,
  sub,
  delta,
  accent,
  danger,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: DeltaResult;
  /** Orange action tone — reserve for genuine action/positive emphasis. */
  accent?: boolean;
  /** Semantic danger (red) — for failure counts, never the action accent. */
  danger?: boolean;
  /** Headline tile: larger value + padding so the KPI row anchors the page. */
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-[12px] border border-border bg-surface ${emphasis ? "p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]" : "p-4"}`}
    >
      <CardLabel>{label}</CardLabel>
      <div className="flex items-baseline gap-2">
        <span
          className={`font-black leading-none tabular-nums ${emphasis ? "text-[34px]" : "text-[26px]"} ${statValueClass(accent, danger)}`}
        >
          {value}
        </span>
        {delta && <DeltaBadge delta={delta} />}
      </div>
      {sub && (
        <span className="text-[10px] uppercase tracking-[0.08em] text-text-3">
          {sub}
        </span>
      )}
    </div>
  );
}

export function TrendCard({
  label,
  total,
  values,
  delta,
  note,
}: {
  label: string;
  total: string;
  values: number[];
  delta?: DeltaResult;
  note?: string | null;
}) {
  const trendNote =
    values.length < 3
      ? "Trend line appears once 3+ daily buckets are selected"
      : note;

  return (
    <HudCard label={label}>
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] font-black leading-none tabular-nums text-text">
          {total}
        </span>
        {delta && <DeltaBadge delta={delta} />}
      </div>
      {values.length >= 3 ? (
        <Sparkline
          values={values}
          label={`${label} trend`}
          width={220}
          height={36}
        />
      ) : null}
      {trendNote ? <CaveatNote>{trendNote}</CaveatNote> : null}
    </HudCard>
  );
}
