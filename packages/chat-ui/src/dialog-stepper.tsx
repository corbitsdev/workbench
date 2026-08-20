import type * as React from "react";

// The guided-dialog progress affordance: an uppercase step label, a thin
// segmented rail filled in the host's accent color, and one calm sentence
// of per-step guidance underneath. This is generic dialog chrome with no
// chat-specific behavior; it lives here only because `chat-ui` is the
// lowest common package every current caller — `CreateRoutineDialog` in
// this package's own tree, plus the onboarding wizard in `apps/web`
// (which already depends on `chat-ui`) — can reach without adding a new
// package dependency. It belongs in
// `@corbits/react-ui` long-term as a shared primitive; flagged here, not
// lifted, since that repo is out of bounds for this change.
export interface DialogStepperStep {
  readonly label: string;
  readonly guidance?: string;
  /** Never gates progress — flagged on the rail regardless of which step
   * is current, and appended to the label whenever it is the current
   * step, so the flow never implies a skippable step is required. */
  readonly optional?: boolean;
}

export function DialogStepper({
  step,
  steps,
}: {
  readonly step: number;
  readonly steps: readonly DialogStepperStep[];
}) {
  const current = steps[step - 1];
  const currentLabel =
    current !== undefined
      ? `${current.label}${current.optional === true ? " · optional" : ""}`
      : undefined;
  return (
    <div className="dialog-stepper">
      <p className="dialog-stepper-label">
        Step {step} of {steps.length}
        {currentLabel !== undefined ? ` · ${currentLabel}` : ""}
      </p>
      <div
        className="dialog-stepper-track"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-label={currentLabel ?? ""}
      >
        {steps.map((s, index) => (
          <span
            key={s.label}
            className="dialog-stepper-segment"
            data-filled={index < step}
            data-optional={s.optional === true ? "true" : undefined}
          />
        ))}
      </div>
      {current?.guidance !== undefined ? (
        <p className="dialog-stepper-guidance">{current.guidance}</p>
      ) : null}
    </div>
  );
}

export type DialogStepStatus = "completed" | "current" | "upcoming";

export interface DialogStepAccordionStep {
  readonly key: string;
  readonly label: string;
  readonly status: DialogStepStatus;
  /** One-line recap of the answer already given — shown only while the
   * step is collapsed (`completed`), never on the current or an upcoming
   * step. */
  readonly summary?: React.ReactNode;
  /** Present only on a completed step — jumps straight back to it, in
   * place, rather than walking Back one step at a time. */
  readonly onEdit?: () => void;
  /** The step's own form content. Rendered only while `status ===
   * "current"` — a completed or upcoming step shows its heading alone. */
  readonly content?: React.ReactNode;
}

/**
 * A vertical, always-visible stepper: every step listed top to bottom, so
 * the whole journey and every answer so far stay on screen at once. A
 * completed step collapses to its heading and a one-line recap with an
 * Edit affordance; the current step expands with its full content; an
 * upcoming step shows only its dimmed label. Same rationale and shared
 * home as `DialogStepper` above — generic dialog chrome, not chat-specific,
 * living here only because this is the lowest common package its callers
 * can reach.
 */
export function DialogStepAccordion({
  steps,
}: {
  readonly steps: readonly DialogStepAccordionStep[];
}) {
  return (
    <ol className="dialog-step-accordion">
      {steps.map((s, index) => (
        <li
          key={s.key}
          className="dialog-step-accordion-item"
          data-status={s.status}
        >
          <div className="dialog-step-accordion-header">
            <span className="dialog-step-accordion-index" aria-hidden="true">
              {s.status === "completed" ? "✓" : index + 1}
            </span>
            <div className="dialog-step-accordion-heading">
              <span className="dialog-step-accordion-label">{s.label}</span>
              {s.status !== "current" && s.summary !== undefined ? (
                <span className="dialog-step-accordion-summary">
                  {s.summary}
                </span>
              ) : null}
            </div>
            {s.status === "completed" && s.onEdit !== undefined ? (
              <button
                type="button"
                className="dialog-step-accordion-edit"
                onClick={s.onEdit}
              >
                Edit
              </button>
            ) : null}
          </div>
          {s.status === "current" ? (
            <div className="dialog-step-accordion-body">{s.content}</div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
