// The guided-dialog progress affordance: an uppercase step label, a thin
// segmented rail filled in the host's accent color, and one calm sentence
// of per-step guidance underneath. Adapted from
// `apps/web/src/onboarding/onboarding-progress.tsx`'s wizard rail — that
// file is left as-is (its own CSS and a markup-asserting test already cover
// it) rather than rewired onto this component, so this is a fresh
// implementation of the same pattern, not a shared one. This is generic
// dialog chrome with no chat-specific behavior; it lives here only because
// `chat-ui` is the lowest common package both `NewChannelDialog` (in this
// package) and `CreateRoutineDialog` (in `apps/web`, which already depends
// on `chat-ui`) can reach without a new package. It belongs in
// `@corbits/react-ui` long-term — flagged, not lifted, since that repo is
// out of bounds here.
export interface DialogStepperStep {
  readonly label: string;
  readonly guidance?: string;
}

export function DialogStepper({
  step,
  steps,
}: {
  readonly step: number;
  readonly steps: readonly DialogStepperStep[];
}) {
  const current = steps[step - 1];
  return (
    <div className="dialog-stepper">
      <p className="dialog-stepper-label">
        Step {step} of {steps.length}
        {current !== undefined ? ` · ${current.label}` : ""}
      </p>
      <div
        className="dialog-stepper-track"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-label={current?.label ?? ""}
      >
        {steps.map((s, index) => (
          <span
            key={s.label}
            className="dialog-stepper-segment"
            data-filled={index < step}
          />
        ))}
      </div>
      {current?.guidance !== undefined ? (
        <p className="dialog-stepper-guidance">{current.guidance}</p>
      ) : null}
    </div>
  );
}
