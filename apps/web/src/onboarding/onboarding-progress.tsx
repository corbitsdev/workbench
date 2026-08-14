/**
 * The restrained progress affordance that replaced the numbered-circle
 * stepper: an uppercase step label and a thin segmented rail filled in
 * brand orange, one segment per wizard step. Deliberately small — the
 * question being asked, not the chrome around it, is the focal point of
 * each phase.
 */
export function OnboardingProgress({
  step,
  totalSteps,
  label,
  optionalStep,
}: {
  readonly step: number;
  readonly totalSteps: number;
  readonly label: string;
  /** The one step in the sequence that never gates progress — flagged on
   * the rail regardless of which step is current, and appended to the
   * label whenever it is the current step, so the wizard never implies a
   * skippable step is required. */
  readonly optionalStep?: number;
}) {
  const displayLabel = step === optionalStep ? `${label} · optional` : label;
  return (
    <div className="onboarding-progress">
      <p className="onboarding-progress-label">
        Step {step} of {totalSteps} · {displayLabel}
      </p>
      <div
        className="onboarding-progress-track"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={totalSteps}
        aria-label={displayLabel}
      >
        {Array.from({ length: totalSteps }, (_, index) => (
          <span
            key={index}
            className="onboarding-progress-segment"
            data-filled={index < step}
            data-optional={index + 1 === optionalStep ? "true" : undefined}
          />
        ))}
      </div>
    </div>
  );
}
