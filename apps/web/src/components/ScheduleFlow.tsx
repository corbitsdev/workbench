import { useMemo, useState } from "react";
import type {
  ScheduleFieldMetadata,
  ScheduleRecurrence,
  ScheduleScope,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import { ScheduleFieldForm, scheduleFieldsComplete } from "./ScheduleFieldForm";
import { RecurrenceAmountInput } from "./RecurrenceAmountInput";
import {
  amountUnitFromInterval,
  anchorToLocalTimeInputValue,
  formatRecurrence,
  intervalFromAmountUnit,
  localTimeInputValueToAnchor,
  onlyDailyAllowedForKind,
  scheduleScopeLabel,
  type RecurrenceUnit,
} from "../lib/schedule-time";

const RECURRENCE_UNIT_OPTIONS: { value: RecurrenceUnit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
];

/** Ordered schedule create/edit steps (CL-4263). */
export type ScheduleFlowStepId =
  | "open"
  | "recurrence"
  | "inputs"
  | "availability";

export const SCHEDULE_FLOW_STEP_LABELS: Record<ScheduleFlowStepId, string> = {
  open: "Open",
  recurrence: "Recurrence",
  inputs: "Inputs",
  availability: "Availability",
};

/**
 * Build the visible step list for a schedule create/edit walk.
 * - Inputs collapses when the kind has no schedule field metadata.
 * - Availability collapses when scope cannot be chosen (edit, or a single
 *   allowed scope — defaultScope is applied silently).
 */
export function buildScheduleFlowSteps(opts: {
  hasInputFields: boolean;
  canChooseScope: boolean;
}): ScheduleFlowStepId[] {
  const steps: ScheduleFlowStepId[] = ["open", "recurrence"];
  if (opts.hasInputFields) steps.push("inputs");
  if (opts.canChooseScope) steps.push("availability");
  return steps;
}

export type ScheduleFlowProps = {
  entry: WorkflowCatalogEntry;
  productLabel: string;
  /** Existing schedule when editing; omit for create. */
  existing?: { scope: ScheduleScope } | null;
  recurrence: ScheduleRecurrence;
  onRecurrenceChange: (next: ScheduleRecurrence) => void;
  scope: ScheduleScope;
  onScopeChange: (scope: ScheduleScope) => void;
  fieldValues: Record<string, unknown>;
  onFieldValuesChange: (next: Record<string, unknown>) => void;
  fields: readonly ScheduleFieldMetadata[];
  error: string | null;
  busy?: boolean;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
};

/**
 * Multi-step schedule create/edit walk (CL-4263):
 * Open → Recurrence → Inputs (if any) → Availability (if choosable).
 *
 * Recurrence is two raw controls (CL-4278): an amount + unit for "how often"
 * (decomposed to `intervalMinutes`, minute granularity available) and a
 * local time-of-day for "starting at" (decomposed to `anchorMinuteUtc`).
 * Kinds whose per-kind rule requires a fixed daily cadence (e.g. heartbeat,
 * see `onlyDailyAllowedForKind`) lock the "how often" control to once a day.
 */
export function ScheduleFlow({
  entry,
  productLabel,
  existing = null,
  recurrence,
  onRecurrenceChange,
  scope,
  onScopeChange,
  fieldValues,
  onFieldValuesChange,
  fields,
  error,
  busy = false,
  onCancel,
  onSave,
}: ScheduleFlowProps) {
  const isEdit = existing != null;
  const canChooseScope = !isEdit && entry.allowedScopes.length > 1;
  const steps = useMemo(
    () =>
      buildScheduleFlowSteps({
        hasInputFields: fields.length > 0,
        canChooseScope,
      }),
    [fields.length, canChooseScope],
  );

  const [stepIndex, setStepIndex] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

  const currentStep = steps[stepIndex] ?? "open";
  const isLast = stepIndex >= steps.length - 1;
  const dailyOnly = onlyDailyAllowedForKind(entry.kind);
  const { amount, unit } = amountUnitFromInterval(recurrence.intervalMinutes);

  const updateInterval = (nextAmount: number, nextUnit: RecurrenceUnit) => {
    onRecurrenceChange({
      ...recurrence,
      intervalMinutes: intervalFromAmountUnit(nextAmount, nextUnit),
    });
  };

  const setAnchor = (localTimeValue: string) => {
    onRecurrenceChange({
      ...recurrence,
      anchorMinuteUtc: localTimeInputValueToAnchor(localTimeValue),
    });
  };

  const goBack = () => {
    setStepError(null);
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const goNext = () => {
    setStepError(null);
    if (
      currentStep === "inputs" &&
      !scheduleFieldsComplete(fields, fieldValues)
    ) {
      setStepError("Fill in the required fields.");
      return;
    }
    if (isLast) {
      void onSave();
      return;
    }
    setStepIndex((i) => Math.min(steps.length - 1, i + 1));
  };

  const primaryLabel = isLast
    ? isEdit
      ? "Save changes"
      : "Create schedule"
    : "Continue";

  return (
    <div
      className="mt-4 border-t border-border pt-4"
      data-testid={`schedule-editor-${entry.kind}`}
      data-schedule-flow-step={currentStep}
    >
      <nav
        className="mb-4 flex flex-wrap items-center gap-1.5"
        aria-label="Schedule steps"
        data-testid="schedule-flow-steps"
      >
        {steps.map((id, idx) => {
          const active = idx === stepIndex;
          const done = idx < stepIndex;
          let stepClass =
            "rounded-full bg-page px-2.5 py-0.5 text-xs font-medium text-text-3";
          if (active) {
            stepClass =
              "rounded-full bg-orange px-2.5 py-0.5 text-xs font-semibold text-white";
          } else if (done) {
            stepClass =
              "rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-text-2";
          }
          return (
            <div key={id} className="flex items-center gap-1.5">
              {idx > 0 ? (
                <span className="text-text-3" aria-hidden>
                  →
                </span>
              ) : null}
              <span
                data-testid={`schedule-flow-step-${id}`}
                data-active={active ? "true" : "false"}
                data-done={done ? "true" : "false"}
                className={stepClass}
              >
                {SCHEDULE_FLOW_STEP_LABELS[id]}
              </span>
            </div>
          );
        })}
      </nav>

      {currentStep === "open" ? (
        <div data-testid="schedule-flow-body-open">
          <h3 className="text-sm font-semibold text-text">{productLabel}</h3>
          {entry.description ? (
            <p className="mt-1 text-sm text-text-2">{entry.description}</p>
          ) : (
            <p className="mt-1 text-sm text-text-2">
              {isEdit
                ? "Review this routine, then set when it runs."
                : "Put this routine on autopilot. Next: when it runs."}
            </p>
          )}
          <p className="mt-2 text-xs text-text-3">
            {isEdit ? "Editing schedule" : "New schedule"} ·{" "}
            {scheduleScopeLabel(isEdit ? existing.scope : entry.defaultScope)}
            {canChooseScope ? " (you can change who it runs for later)" : null}
          </p>
        </div>
      ) : null}

      {currentStep === "recurrence" ? (
        <div data-testid="schedule-flow-body-recurrence">
          <label
            htmlFor={`recurrence-amount-${entry.kind}`}
            className="mb-1 block text-xs font-semibold uppercase tracking-[0.05em] text-text-3"
          >
            How often
          </label>
          {dailyOnly ? (
            <p
              className="text-sm text-text"
              data-testid={`recurrence-daily-only-${entry.kind}`}
            >
              Once a day
            </p>
          ) : (
            <div className="flex items-start gap-2">
              <span className="mt-2 text-sm text-text-2">Every</span>
              <RecurrenceAmountInput
                id={`recurrence-amount-${entry.kind}`}
                amount={amount}
                onCommit={(nextAmount) => updateInterval(nextAmount, unit)}
                className="w-20 rounded-[10px] border border-border bg-page px-3 py-2 text-sm"
              />
              <select
                aria-label="Interval unit"
                value={unit}
                onChange={(e) =>
                  updateInterval(amount, e.target.value as RecurrenceUnit)
                }
                className="rounded-[10px] border border-border bg-page px-3 py-2 text-sm"
              >
                {RECURRENCE_UNIT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label
            htmlFor={`recurrence-anchor-${entry.kind}`}
            className="mb-1 mt-3 block text-xs font-semibold uppercase tracking-[0.05em] text-text-3"
          >
            Starting at
          </label>
          <input
            id={`recurrence-anchor-${entry.kind}`}
            type="time"
            value={anchorToLocalTimeInputValue(recurrence.anchorMinuteUtc)}
            onChange={(e) => setAnchor(e.target.value)}
            className="w-full max-w-xs rounded-[10px] border border-border bg-page px-3 py-2 text-sm"
          />
          <p className="mt-2 text-xs text-text-3">
            {formatRecurrence(recurrence)}
          </p>
        </div>
      ) : null}

      {currentStep === "inputs" ? (
        <div data-testid="schedule-flow-body-inputs">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-text-3">
            Inputs for each run
          </p>
          <ScheduleFieldForm
            fields={fields}
            values={fieldValues}
            onChange={onFieldValuesChange}
            idPrefix={`routine-${entry.kind}`}
          />
        </div>
      ) : null}

      {currentStep === "availability" ? (
        <fieldset data-testid="schedule-flow-body-availability">
          <legend className="mb-1.5 text-xs font-semibold uppercase tracking-[0.05em] text-text-3">
            Who is this for
          </legend>
          <div className="flex flex-col gap-1.5">
            {entry.allowedScopes.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-start gap-2 text-sm text-text"
              >
                <input
                  type="radio"
                  name={`routine-scope-${entry.kind}`}
                  value={s}
                  checked={scope === s}
                  onChange={() => onScopeChange(s)}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="font-medium">{scheduleScopeLabel(s)}</span>
                  <span className="mt-0.5 block text-xs text-text-3">
                    {s === "tenant"
                      ? "One shared run for the workspace; outcomes fan out to every member's inbox."
                      : "Only you own the schedule and receive the outcome."}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {isEdit && currentStep === "open" ? (
        <p className="mt-3 text-xs text-text-3">
          Scope is set when a schedule is created and can&rsquo;t be changed
          here — remove this schedule and create a new one to change who it runs
          for.
        </p>
      ) : null}

      {stepError || error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {stepError ?? error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {stepIndex > 0 ? (
          <button
            type="button"
            className="rounded-[10px] border border-border px-3.5 py-2 text-sm text-text-2"
            onClick={goBack}
            disabled={busy}
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-[10px] bg-orange px-3.5 py-2 text-sm font-semibold text-white"
          onClick={goNext}
          disabled={busy}
          data-testid="schedule-flow-primary"
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          className="rounded-[10px] border border-border px-3.5 py-2 text-sm text-text-2"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
