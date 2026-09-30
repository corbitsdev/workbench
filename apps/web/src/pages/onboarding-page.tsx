// A gap the install loop can't cross renders here with a retry, never a
// silent "ready".
import { Button, EmptyState } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensurePrimaryTenant, runPortableClientBootstrap } from "../client-bootstrap";
import { createFetchStockHub, findOwnedTenants } from "../needs-converge";
import { deployWorkerSource } from "../worker-deploy";
import { useNavigate } from "../navigation";
import { NEW_WORKBENCH_PATH } from "../routes";
import { triggerFirstLoginProvisioning } from "../onboarding";
import { setProviderSkipped } from "../provider-skip";
import { OnboardingLayout } from "../onboarding/onboarding-layout";
import {
  ProviderConnectStep,
  resolveExistingOffering,
  type ExistingOffering,
} from "../onboarding/provider-connect-step";
import type { WorkflowDeployInput } from "../needs-list";
import type { SessionUser } from "../session";

type GateState =
  | { readonly phase: "checking" }
  | { readonly phase: "resolving-tenant" }
  | { readonly phase: "provider-setup"; readonly tenantId: string }
  | { readonly phase: "publishing-worker" }
  | { readonly phase: "installing"; readonly workerDeploy: WorkflowDeployInput }
  | { readonly phase: "ready" }
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
  const installRef = useRef<ReturnType<typeof runPortableClientBootstrap> | null>(null);

  // Remembered so a reload lands in the shell instead of back here.
  function skipForNow() {
    setProviderSkipped(user.id, true);
    navigate(NEW_WORKBENCH_PATH);
  }

  // One status read per landing (plus each manual recheck): a hub that
  // already has tenants means setup is done; an empty hub starts the
  // converge loop immediately rather than showing a dead-end panel.
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

  // A separate phase from "installing" because a credential connect
  // needs a tenant id to write against.
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
              setState({ phase: "publishing-worker" });
              void publishAndInstall(primary.id, primary.domain, existing);
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
    // `publishAndInstall` is defined below and stable across renders (it
    // closes over nothing but `setState`), so it is intentionally left
    // out of this effect's dependency list.
  }, [state.phase, user]);

  // Shared by both the already-resolved-offering path and the
  // operator-connected path.
  function publishAndInstall(
    tenantId: string,
    tenantDomain: string,
    offering: ExistingOffering,
  ): Promise<void> {
    return deployWorkerSource({
      tenantId,
      tenantDomain,
      sourceOfferingIds: offering.sourceOfferingIds,
      defaultSourceOfferingId: offering.defaultSourceOfferingId,
      declaredSources: offering.declaredSources,
    }).then(
      (workerDeploy) => setState({ phase: "installing", workerDeploy }),
      (error: unknown) => {
        setState({
          phase: "error",
          message:
            error instanceof Error ? error.message : "Publishing your worker's source hit a snag.",
        });
      },
    );
  }

  // Step 4: the installer itself, run once a `workerDeploy` is in hand. A
  // converged install hands off to the shell; a stock capability gap or
  // a hard failure surfaces here instead of retrying silently forever.
  useEffect(() => {
    if (state.phase !== "installing") return;
    let cancelled = false;
    // StrictMode re-runs this effect once; the converge deploys Worker, so a
    // second concurrent run would deploy her twice. Reuse the in-flight one.
    installRef.current ??= runPortableClientBootstrap(user, {
      workerDeploy: state.workerDeploy,
    });
    void installRef.current.then(
      (result) => {
        if (cancelled) return;
        if (result.kind === "ready") {
          setState({ phase: "ready" });
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
          message: error instanceof Error ? error.message : "Setting up your workbench hit a snag.",
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state, user, navigate]);

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
              onConnected={(offering) => {
                const tenantId = state.tenantId;
                setState({ phase: "publishing-worker" });
                // The tenant's domain never changes mid-flow — re-derive
                // it fresh rather than threading it through state, since
                // `resolving-tenant` already looked the tenant up once.
                void findOwnedTenants(createFetchStockHub()).then((owned) => {
                  const primary = owned.find((t) => t.id === tenantId);
                  if (primary === undefined) {
                    setState({
                      phase: "error",
                      message: "Your primary workbench disappeared mid-setup — please retry.",
                    });
                    return;
                  }
                  void publishAndInstall(tenantId, primary.domain, offering);
                });
              }}
              onError={(message) => setState({ phase: "error", message })}
              onSkip={skipForNow}
            />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "publishing-worker" || state.phase === "installing") {
    return (
      <OnboardingLayout step={2}>
        <div className="onboarding-phase onboarding-phase--loading" key="installing">
          <WorkbenchLoadingState
            delayMs={0}
            title={
              state.phase === "publishing-worker"
                ? "Connecting your model…"
                : "Getting your worker ready…"
            }
          />
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "ready") {
    return (
      <OnboardingLayout step={3}>
        <div className="onboarding-phase" key="ready">
          <h1 className="onboarding-title">Your worker is ready</h1>
          <p className="onboarding-subtitle">
            Describe the job and your co-worker sets up the rest.
          </p>
          <div className="onboarding-content">
            <div className="onboarding-actions">
              <Button variant="primary" onClick={() => navigate("/")}>
                Start your first workbench
              </Button>
            </div>
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "setup-pending") {
    return (
      <OnboardingLayout step={2}>
        <div className="onboarding-phase" key="setup-pending">
          <h1 className="onboarding-title">Set up your workbench</h1>
          <p className="onboarding-subtitle">{state.message}</p>
          <div className="onboarding-content">
            <div className="onboarding-actions">
              <Button variant="primary" onClick={checkStatus}>
                Check again
              </Button>
              <Button variant="ghost" onClick={skipForNow}>
                Skip for now
              </Button>
            </div>
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
