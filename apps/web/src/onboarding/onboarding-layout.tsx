import { CorbitsMark } from "@corbits/react-ui";
import type { ReactNode } from "react";

const STEP_LABELS = ["Workspace", "Model", "Myra"] as const;

/**
 * Single centered column with a step progress bar, matching the onboarding
 * mockup. `step` is the index of the current step (0-2; 3 = all done).
 */
export function OnboardingLayout({
  step,
  children,
}: {
  readonly step: 0 | 1 | 2 | 3;
  readonly children: ReactNode;
}) {
  return (
    <div className="onboarding-shell">
      <main className="onboarding-form-col">
        <div className="onboarding-brand">
          <span className="onboarding-brand-chip">
            <CorbitsMark decorative className="onboarding-brand-mark" />
          </span>
          Workbench
        </div>

        <div className="onboarding-form-slot">
          <div className="onboarding-form">
            <ol className="onboarding-progress" aria-label="Setup progress">
              {STEP_LABELS.map((label, index) => (
                <li
                  key={label}
                  data-state={index < step ? "done" : index === step ? "now" : "ahead"}
                  aria-label={label}
                  aria-current={index === step ? "step" : undefined}
                />
              ))}
            </ol>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
