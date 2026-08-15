// The guided-dialog progress affordance: an uppercase step label, a thin
// segmented rail filled in the host's accent color, and one calm sentence
// of per-step guidance underneath. This is generic dialog chrome with no
// chat-specific behavior; it lives here only because `chat-ui` is the
// lowest common package every current caller — `NewChannelDialog` and
// `CreateRoutineDialog` in this package's own tree, plus the onboarding
// wizard in `apps/web` (which already depends on `chat-ui`) — can reach
// without adding a new package dependency. It belongs in
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
