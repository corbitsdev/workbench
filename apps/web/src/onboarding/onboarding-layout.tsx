import { CorbitsMark } from "@corbits/react-ui";
import type { ReactNode } from "react";

import { DitherBackground } from "../auth/dither-background";

/**
 * Full-screen wizard frame, modeled on `AuthLayout`'s two-column shell for
 * visual continuity with the sign-in screen: a form column on the left and
 * a dithered brand panel on the right (hidden on small screens). Wider than
 * the auth form column — the credential step's provider picker and the
 * guidance cards need more room than a login form does.
 */
export function OnboardingLayout({
  children,
}: {
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
          <div className="onboarding-form">{children}</div>
        </div>
      </main>

      <div aria-hidden className="onboarding-panel">
        <img
          src="/images/hero-dither.png"
          alt=""
          className="onboarding-panel-fallback"
        />
        <DitherBackground className="onboarding-panel-dither" />
      </div>
    </div>
  );
}
