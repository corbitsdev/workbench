// The setup gate (CL-8112/CL-8131): the screen a signed-in session lands
// on when the hub reports setup-required. It reads the hub's native
// setup-status route, and a hub that already has tenants bounces
// straight into the shell (`/`). An empty hub drives the browser
// installer itself: `bootstrapClientSession` mints the account's primary
// tenant over the stock `POST /api/tenants` route and converges Myra
// onto it, all over stock routes — the hub never seeds anything. A
// converged install lands on `/`; a stock capability gap (most commonly
// "no myraDeploy configured yet") renders here so the operator sees
// exactly what stock Interchange is missing, with a retry; a broken
// status read blocks with retry too.
import { Button, EmptyState } from "@corbits/react-ui";
import { WarningCircle } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useCallback, useEffect, useState } from "react";

import { runPortableClientBootstrap } from "../client-bootstrap";
import { useNavigate } from "../navigation";
import { triggerFirstLoginProvisioning } from "../onboarding";
import { OnboardingLayout } from "../onboarding/onboarding-layout";
import type { SessionUser } from "../session";

type GateState =
  | { readonly phase: "checking" }
  | { readonly phase: "installing" }
  | {
      readonly phase: "setup-pending";
      readonly message: string;
      readonly refId?: string;
    }
  | {
      readonly phase: "error";
      readonly message: string;
      readonly refId?: string;
    };

export function OnboardingPage({ user }: { readonly user: SessionUser }) {
  const navigate = useNavigate();
  const [state, setState] = useState<GateState>({ phase: "checking" });

  // One status read per landing (plus each manual recheck): a hub that
  // already has tenants means setup is done; an empty hub drives the
  // installer immediately rather than showing a dead-end panel.
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
        setState({ phase: "installing" });
      }
    });
  }, [navigate]);
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // The installer itself: runs once the status read confirms setup is
  // required. A converged install hands off to the shell; a stock
  // capability gap or a hard failure surfaces here instead of retrying
  // silently forever.
  useEffect(() => {
    if (state.phase !== "installing") return;
    let cancelled = false;
    void runPortableClientBootstrap(user).then(
      (result) => {
        if (cancelled) return;
        if (result.kind === "ready") {
          navigate("/");
        } else if (result.code === "stock-capability-missing") {
          setState({ phase: "setup-pending", message: result.gap });
        } else {
          setState({ phase: "error", message: result.message });
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message:
            error instanceof Error
              ? error.message
              : "Setting up your workbench hit a snag.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.phase, user, navigate]);

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

  if (state.phase === "installing") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase" key="installing">
          <h1 className="onboarding-title">Setting up your workbench</h1>
          <p className="onboarding-subtitle">One moment.</p>
          <div className="onboarding-content">
            <WorkbenchLoadingState
              delayMs={0}
              title="Setting up your workbench…"
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
          <p className="onboarding-subtitle">{state.message}</p>
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
