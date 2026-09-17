// The setup gate (CL-8112): the screen a signed-in session lands on when
// the hub reports setup-required. It reads the hub's native setup-status
// route and does one of three honest things — a hub that turns out to
// already have tenants bounces straight into the shell (`/`), an empty
// hub renders a static pending panel, and a broken status read blocks
// with retry. Read-only on purpose: the provisioning, credential, and
// OAuth-connect machinery that used to live here spoke to the deleted
// `/api/onboarding/*` routes, so it went with the hub mount — the setup
// flow itself (first workbench, first credential) is T6/T7's to build,
// and this screen is where it will land.
import { Button, EmptyState } from "@corbits/react-ui";
import { WarningCircle } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useCallback, useEffect, useState } from "react";

import { useNavigate } from "../navigation";
import { triggerFirstLoginProvisioning } from "../onboarding";
import { OnboardingLayout } from "../onboarding/onboarding-layout";

type GateState =
  | { readonly phase: "checking" }
  | { readonly phase: "setup-pending" }
  | {
      readonly phase: "error";
      readonly message: string;
      readonly refId?: string;
    };

export function OnboardingPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<GateState>({ phase: "checking" });

  // One status read per landing (plus each manual recheck): the hook's
  // verdict decides everything, so there is no step to replay — a reload
  // just re-reads.
  const checkStatus = useCallback(() => {
    setState({ phase: "checking" });
    void triggerFirstLoginProvisioning().then((result) => {
      if (result.kind === "error") {
        setState(
          result.refId === undefined
            ? { phase: "error", message: result.message }
            : {
                phase: "error",
                message: result.message,
                refId: result.refId,
              },
        );
      } else if (result.kind === "existing-member") {
        navigate("/");
      } else {
        setState({ phase: "setup-pending" });
      }
    });
  }, [navigate]);
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  if (state.phase === "checking") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase" key="checking">
          <h1 className="onboarding-title">Checking your workbench</h1>
          <p className="onboarding-subtitle">One moment.</p>
          <div className="onboarding-content">
            <WorkbenchLoadingState
              delayMs={0}
              title="Checking your workbench…"
            />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "setup-pending") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase" key="setup-pending">
          <h1 className="onboarding-title">Set up your workbench</h1>
          <p className="onboarding-subtitle">
            Your workbench isn&apos;t set up yet. The first-workbench setup flow
            is still being built; this screen will host it.
          </p>
          <div className="onboarding-content">
            <Button variant="outline" onClick={checkStatus}>
              Check again
            </Button>
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout>
      <div className="onboarding-phase" key="status-error">
        <div className="onboarding-content">
          <EmptyState
            icon={<WarningCircle />}
            title="Couldn't check your workbench"
            description={
              state.refId === undefined ? (
                state.message
              ) : (
                <>
                  {state.message}
                  <br />
                  <span className="onboarding-error-refid">
                    If you tell us about this, mention {state.refId}.
                  </span>
                </>
              )
            }
            action={
              <Button variant="outline" onClick={checkStatus}>
                Try again
              </Button>
            }
          />
        </div>
      </div>
    </OnboardingLayout>
  );
}
