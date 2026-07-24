import type { ReactNode } from "react";
import type { DisplayFlowStep } from "../types";
import { cn } from "./cn";
import { InspectorPanelTitle } from "./InspectorShell";
import type { StepDisplayStatus, StepListItem } from "./types";

function stepMark(status: StepDisplayStatus): string {
  if (status === "done") return "✓";
  if (status === "failed") return "!";
  return "";
}

function stateLabel(status: StepDisplayStatus): string {
  if (status === "active") return "now";
  return status;
}

const MARK_CLASS: Record<StepDisplayStatus, string> = {
  pending: "border-border bg-surface text-text-3",
  active: "border-accent/50 bg-accent/15 text-accent-deep",
  done: "border-green/40 bg-green/15 text-green-deep",
  failed: "border-red/40 bg-red/15 text-red",
};

const STATE_CLASS: Record<StepDisplayStatus, string> = {
  pending: "text-text-3",
  active: "font-semibold text-accent-deep",
  done: "text-green-deep",
  failed: "text-red",
};

export function StepListRow({
  step,
  className,
}: {
  step: StepListItem;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2 py-1.5",
        className,
      )}
      data-step-id={step.id}
      data-step-status={step.status}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid h-[18px] w-[18px] place-items-center rounded-[5px] border text-[10px] font-bold",
          MARK_CLASS[step.status],
        )}
      >
        {stepMark(step.status)}
      </span>
      <div className="min-w-0">
        <div
          className={cn(
            "truncate text-[13px] font-medium text-text",
            step.status === "pending" && "text-text-3",
          )}
        >
          {step.name}
        </div>
        {step.meta ? (
          <div className="truncate text-[11px] text-text-3">{step.meta}</div>
        ) : null}
      </div>
      <span
        className={cn(
          "shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.04em]",
          STATE_CLASS[step.status],
        )}
      >
        {stateLabel(step.status)}
      </span>
    </div>
  );
}

export function StepList({
  steps,
  title = "Steps",
  className,
  empty,
}: {
  steps: readonly StepListItem[];
  title?: string;
  className?: string;
  empty?: ReactNode;
}) {
  return (
    <div className={cn(className)}>
      {title ? <InspectorPanelTitle>{title}</InspectorPanelTitle> : null}
      {steps.length === 0 ? (
        empty ?? (
          <p className="text-[12.5px] text-text-3">No steps yet.</p>
        )
      ) : (
        <div className="flex flex-col" role="list">
          {steps.map((step) => (
            <StepListRow key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Map pure display-flow steps into StepList items (all pending until host overlays run state).
 */
export function stepListFromDisplayFlow(
  steps: readonly DisplayFlowStep[],
  statusById?: ReadonlyMap<string, StepDisplayStatus> | Record<string, StepDisplayStatus>,
): StepListItem[] {
  const lookup =
    statusById instanceof Map
      ? (id: string) => statusById.get(id)
      : statusById
        ? (id: string) =>
            (statusById as Record<string, StepDisplayStatus | undefined>)[id]
        : () => undefined;

  return steps.map((s) => {
    const status = lookup(s.stepId) ?? "pending";
    return {
      id: s.stepId,
      name: s.label,
      status,
      character: s.character,
    };
  });
}
