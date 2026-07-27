import type { ReactNode } from "react";
import { cn } from "./cn";
import type { WorkflowScope, WorkflowStatusTone } from "./types";

const STATUS_TONE_CLASS: Record<WorkflowStatusTone, string> = {
  running: "bg-blue/15 text-blue-deep dark:text-blue-soft",
  awaiting: "bg-accent/15 text-accent-deep dark:text-accent-soft",
  done: "bg-green/15 text-green-deep dark:text-green-soft",
  paused: "bg-text-3/15 text-text-2",
  fail: "bg-red/15 text-red",
};

export function PulseDot({
  className,
  animate = true,
}: {
  className?: string;
  animate?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-current",
        animate && "animate-pulse",
        className,
      )}
    />
  );
}

export function StatusChip({
  tone,
  label,
  pulse,
  className,
}: {
  tone: WorkflowStatusTone;
  label: string;
  /** When omitted, pulses for running/awaiting. */
  pulse?: boolean;
  className?: string;
}) {
  const shouldPulse = pulse ?? (tone === "running" || tone === "awaiting");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] whitespace-nowrap rounded-[5px] px-[7px] py-[2px]",
        "text-[10px] font-bold uppercase tracking-[0.04em]",
        STATUS_TONE_CLASS[tone],
        className,
      )}
    >
      <PulseDot animate={shouldPulse} />
      {label}
    </span>
  );
}

const SCOPE_CLASS: Record<WorkflowScope, string> = {
  personal: "bg-sel text-accent-deep dark:text-accent-soft",
  tenant: "bg-blue/15 text-blue-deep dark:text-blue-soft",
};

export function ScopePill({
  scope,
  label,
  className,
}: {
  scope: WorkflowScope;
  /** Defaults to Mine / Everyone. */
  label?: string;
  className?: string;
}) {
  const text = label ?? (scope === "tenant" ? "Everyone" : "Mine");
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-[5px] px-[7px] py-[2px]",
        "text-[10px] font-bold uppercase tracking-[0.04em]",
        SCOPE_CLASS[scope],
        className,
      )}
    >
      {text}
    </span>
  );
}

export function FilterChip({
  selected,
  onClick,
  children,
  count,
  className,
  type = "button",
}: {
  selected?: boolean;
  onClick?: () => void;
  children: ReactNode;
  count?: number;
  className?: string;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-[5px] text-[12px] font-semibold transition-colors",
        selected
          ? "border-border bg-surface text-text shadow-sm"
          : "border-transparent bg-transparent text-text-2 hover:bg-row-hover",
        className,
      )}
    >
      {children}
      {count !== undefined ? (
        <span
          className={cn(
            "ml-1 text-[10.5px] font-bold",
            selected ? "text-accent-deep" : "text-text-3",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
