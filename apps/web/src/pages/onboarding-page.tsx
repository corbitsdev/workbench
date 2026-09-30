// A gap the setup can't cross renders here with a retry. Setup ends at a
// connected model; the first workbench is created from the new-workbench
// prompt, and its worker is the first worker.
import { Button, EmptyState } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { useCallback, useEffect, useState } from "react";

import { ensurePrimaryTenant } from "../client-bootstrap";
import { createFetchStockHub, findOwnedTenants } from "../needs-converge";
import { useNavigate } from "../navigation";
import { NEW_WORKBENCH_PATH } from "../routes";
import { triggerFirstLoginProvisioning } from "../onboarding";
import { setProviderSkipped } from "../provider-skip";
import { OnboardingLayout } from "../onboarding/onboarding-layout";
import { ProviderConnectStep, resolveExistingOffering } from "../onboarding/provider-connect-step";
import type { SessionUser } from "../session";

type GateState =
  | { readonly phase: "checking" }
  | { readonly phase: "resolving-tenant" }
  | { readonly phase: "provider-setup"; readonly tenantId: string }
  | {
      readonly phase: "error";
      readonly message: string;
      readonly refId?: string;
    };

export function OnboardingPage({ user }: { readonly user: SessionUser }) {
  const navigate = useNavigate();
  const [state, setState] = useState<GateState>({ phase: "checking" });

  // Remembered so a reload lands in the shell instead of back here.
  function skipForNow() {
    setProviderSkipped(user.id, true);
    navigate(NEW_WORKBENCH_PATH);
  }

  // One status read per landing (plus each manual recheck): a workspace
  // with a connected model means setup is done; otherwise the workspace is
  // ensured and the provider step starts.
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
        setState({ phase: "resolving-tenant" });
      }
    });
  }, [navigate]);
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // A separate phase because a credential connect needs a tenant id to
  // write against.
  useEffect(() => {
    if (state.phase !== "resolving-tenant") return;
    let cancelled = false;
    const hub = createFetchStockHub();
    void (async () => {
      await ensurePrimaryTenant(user, hub);
      const owned = await findOwnedTenants(hub);
      const primary = owned.find((tenant) => tenant.parentId === null);
      if (primary === undefined) {
        throw new Error(
          "Sign-in is expected to leave exactly one owned top-level home behind, but this session shows none.",
        );
      }
      return primary;
    })().then(
      (primary) => {
        if (cancelled) return;
        void resolveExistingOffering(primary.id).then(
          (existing) => {
            if (cancelled) return;
            if (existing !== null) {
              navigate(NEW_WORKBENCH_PATH);
              return;
            }
            setState({ phase: "provider-setup", tenantId: primary.id });
          },
          (error: unknown) => {
            if (cancelled) return;
            setState({
              phase: "error",
              message:
                error instanceof Error ? error.message : "Checking your model access hit a snag.",
            });
          },
        );
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : "Setting up your workbench hit a snag.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.phase, user, navigate]);

  if (state.phase === "checking" || state.phase === "resolving-tenant") {
    return (
      <OnboardingLayout step={0}>
        <div className="onboarding-phase onboarding-phase--loading" key="checking">
          <WorkbenchLoadingState
            delayMs={0}
            title={
              state.phase === "checking" ? "Checking your workbench…" : "Creating your workbench…"
            }
          />
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "provider-setup") {
    return (
      <OnboardingLayout step={1}>
        <div className="onboarding-phase onboarding-phase--credential" key="provider-setup">
          <h1 className="onboarding-title">Connect a brain</h1>
          <p className="onboarding-subtitle">
            Pick a provider and connect it, or skip for now and connect one later in Settings.
          </p>
          <div className="onboarding-content">
            <ProviderConnectStep
              tenantId={state.tenantId}
              onConnected={() => navigate(NEW_WORKBENCH_PATH)}
              onError={(message) => setState({ phase: "error", message })}
              onSkip={skipForNow}
            />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout step={0}>
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
              <div className="onboarding-actions">
                <Button variant="primary" onClick={checkStatus}>
                  Try again
                </Button>
                <Button variant="ghost" onClick={skipForNow}>
                  Skip for now
                </Button>
              </div>
            }
          />
        </div>
      </div>
    </OnboardingLayout>
  );
}
