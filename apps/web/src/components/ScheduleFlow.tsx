import { useState } from "react";
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
  /**
   * Whether to render the workflow name/description header. Callers that
   * already show the kind's title above this panel (e.g. the create-flow
   * page header) pass `false` to avoid rendering it twice.
   */
  showHeader?: boolean;
};

/**
 * Single-form schedule create/edit panel (CL-4282, replacing the CL-4263
 * Open → Recurrence → Inputs → Availability wizard, which buried the time
 * control behind a Continue click). Every field here is independent and
 * short, so all applicable sections render stacked in one panel; sections
 * that don't apply (no input fields, scope not choosable) stay absent using
 * the same conditions the wizard steps used to gate on.
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
  showHeader = true,
}: ScheduleFlowProps) {
  const isEdit = existing != null;
  const canChooseScope = !isEdit && entry.allowedScopes.length > 1;
  const hasInputFields = fields.length > 0;
  const dailyOnly = onlyDailyAllowedForKind(entry.kind);
  const { amount, unit } = amountUnitFromInterval(recurrence.intervalMinutes);

  const [validationError, setValidationError] = useState<string | null>(null);

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

  const handleSave = () => {
    setValidationError(null);
    if (hasInputFields && !scheduleFieldsComplete(fields, fieldValues)) {
      setValidationError("Fill in the required fields.");
      return;
    }
    void onSave();
  };

  const primaryLabel = isEdit ? "Save changes" : "Create schedule";

  return (
    <div
      className={showHeader ? "mt-4 border-t border-border pt-4" : "mt-3"}
      data-testid={`schedule-editor-${entry.kind}`}
    >
      <div className="mb-4">
        {showHeader ? (
          <>
            <h3 className="text-sm font-semibold text-text">
              {productLabel}
            </h3>
            {entry.description ? (
              <p className="mt-1 text-sm text-text-2">{entry.description}</p>
            ) : null}
          </>
        ) : null}
        <p className={`${showHeader ? "mt-1 " : ""}text-xs text-text-3`}>
          {isEdit ? "Editing schedule" : "New schedule"} ·{" "}
          {scheduleScopeLabel(isEdit ? existing.scope : entry.defaultScope)}
          {canChooseScope ? " (you can change who it runs for later)" : null}
        </p>
        {isEdit ? (
          <p className="mt-2 text-xs text-text-3">
            Scope is set when a schedule is created and can&rsquo;t be changed
            here — remove this schedule and create a new one to change who it
            runs for.
          </p>
        ) : null}
      </div>

      <div className="mb-4">
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

      {hasInputFields ? (
        <div className="mb-4">
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

      {canChooseScope ? (
        <fieldset className="mb-4">
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

      {validationError || error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {validationError ?? error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-[10px] bg-orange px-3.5 py-2 text-sm font-semibold text-white"
          onClick={handleSave}
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
