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
}: {
  readonly step: number;
  readonly totalSteps: number;
  readonly label: string;
}) {
  return (
    <div className="onboarding-progress">
      <p className="onboarding-progress-label">
        Step {step} of {totalSteps} · {label}
      </p>
      <div
        className="onboarding-progress-track"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={1}
        aria-valuemax={totalSteps}
        aria-label={label}
      >
        {Array.from({ length: totalSteps }, (_, index) => (
          <span
            key={index}
            className="onboarding-progress-segment"
            data-filled={index < step}
          />
        ))}
      </div>
    </div>
  );
}
