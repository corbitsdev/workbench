import { useMemo, useState } from "react";
import type {
  ScheduleFieldMetadata,
  ScheduleRecurrence,
  ScheduleScope,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import {
  ScheduleFieldForm,
  scheduleFieldsComplete,
} from "./ScheduleFieldForm";
import {
  decodeRecurrenceKey,
  encodeRecurrence,
  recurrenceOptions,
  scheduleScopeLabel,
  type RecurrenceOption,
} from "../lib/schedule-time";

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
  /** Optional recurrence options (tests can inject). */
  recurrenceChoices?: RecurrenceOption[];
};

/**
 * Multi-step schedule create/edit walk (CL-4263):
 * Open → Recurrence → Inputs (if any) → Availability (if choosable).
 *
 * Recurrence uses the closed set from schedule-time (daily local hour or
 * sub-daily intervals) introduced with real recurrence support.
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
  recurrenceChoices: recurrenceChoicesProp,
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
  const recurrenceChoices = recurrenceChoicesProp ?? recurrenceOptions();

  const goBack = () => {
    setStepError(null);
    setStepIndex((i) => Math.max(0, i - 1));
  };

  const goNext = () => {
    setStepError(null);
    if (currentStep === "inputs" && !scheduleFieldsComplete(fields, fieldValues)) {
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
            htmlFor={`recurrence-${entry.kind}`}
            className="mb-1 block text-xs font-semibold uppercase tracking-[0.05em] text-text-3"
          >
            How often
          </label>
          <select
            id={`recurrence-${entry.kind}`}
            value={encodeRecurrence(recurrence)}
            onChange={(e) =>
              onRecurrenceChange(decodeRecurrenceKey(e.target.value))
            }
            className="w-full max-w-xs rounded-[10px] border border-border bg-page px-3 py-2 text-sm"
          >
            {recurrenceChoices.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-text-3">
            Daily times use your local clock; interval cadences fire on UTC
            anchors.
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
          here — remove this schedule and create a new one to change who it
          runs for.
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
