// The setup gate: the screen a signed-in
// session lands on when the hub reports setup-required. It reads the
// hub's native setup-status route, and a hub that already has tenants
// bounces straight into the shell (`/`). An empty hub drives the
// browser installer itself, as one converge loop over stock routes,
// asking the operator only where a human input is genuinely required:
//
//   1. mint the account's primary tenant (stock `POST /api/tenants`) if
//      it does not already own one;
//   2. resolve a catalog offering to deploy Myra against — if the
//      tenant already resolves one (inherited, or a previous run of
//      this step), skip straight past; otherwise ask the operator to
//      connect exactly one provider credential (`ProviderConnectStep`);
//   3. push Myra's source tree and build its deploy input for that offering
//      (`deployMyraSource`) and hand it to `bootstrapClientSession` as
//      `myraDeploy`.
//
// A converged install lands on `/`; a stock capability gap this loop did
// not anticipate, or a hard failure at any step, renders here with a
// retry — a gap is not "ready".
import { Button, EmptyState } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensurePrimaryTenant, runPortableClientBootstrap } from "../client-bootstrap";
import { createFetchStockHub, findOwnedTenants } from "../needs-converge";
import { deployMyraSource } from "../myra-deploy";
import { publishToolPackageRegistry } from "../tools/registry-publish";
import { useNavigate } from "../navigation";
import { triggerFirstLoginProvisioning } from "../onboarding";
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
  | { readonly phase: "publishing-myra" }
  | { readonly phase: "installing"; readonly myraDeploy: WorkflowDeployInput }
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

  // Step 1: mint the primary tenant if this account does not already
  // own one, then move to the offering-resolution step. Stays a
  // separate phase from "installing" (which still runs the full
  // `bootstrapClientSession` converge for the rest of the needs list)
  // because a credential connect needs a tenant id to write against.
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
              setState({ phase: "publishing-myra" });
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

  // Step 3: publish Myra's deploy input for the resolved offering, then
  // hand off to the installing phase. Shared by both the
  // already-resolved-offering path (above) and the operator-connected
  // path (`ProviderConnectStep`'s `onConnected` below).
  function publishAndInstall(
    tenantId: string,
    tenantDomain: string,
    offering: ExistingOffering,
  ): Promise<void> {
    // Myra's pins resolve from the tenant registry, so the tool packages
    // must be there before her definition deploys.
    return publishToolPackageRegistry(tenantId)
      .then(() =>
        deployMyraSource({
          tenantId,
          tenantDomain,
          sourceOfferingIds: offering.sourceOfferingIds,
          defaultSourceOfferingId: offering.defaultSourceOfferingId,
          declaredSources: offering.declaredSources,
        }),
      )
      .then(
        (myraDeploy) => setState({ phase: "installing", myraDeploy }),
        (error: unknown) => {
          setState({
            phase: "error",
            message:
              error instanceof Error ? error.message : "Publishing Myra's source hit a snag.",
          });
        },
      );
  }

  // Step 4: the installer itself, run once a `myraDeploy` is in hand. A
  // converged install hands off to the shell; a stock capability gap or
  // a hard failure surfaces here instead of retrying silently forever.
  useEffect(() => {
    if (state.phase !== "installing") return;
    let cancelled = false;
    // StrictMode re-runs this effect once; the converge deploys Myra, so a
    // second concurrent run would deploy her twice. Reuse the in-flight one.
    installRef.current ??= runPortableClientBootstrap(user, {
      myraDeploy: state.myraDeploy,
    });
    void installRef.current.then(
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
      <OnboardingLayout>
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
      <OnboardingLayout>
        <div className="onboarding-phase onboarding-phase--credential" key="provider-setup">
          <h1 className="onboarding-title">Connect a model provider</h1>
          <p className="onboarding-subtitle">
            Myra needs one working inference credential before she can start.
          </p>
          <div className="onboarding-content">
            <ProviderConnectStep
              tenantId={state.tenantId}
              onConnected={(offering) => {
                const tenantId = state.tenantId;
                setState({ phase: "publishing-myra" });
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
            />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (state.phase === "publishing-myra" || state.phase === "installing") {
    return (
      <OnboardingLayout>
        <div className="onboarding-phase onboarding-phase--loading" key="installing">
          <WorkbenchLoadingState
            delayMs={0}
            title={
              state.phase === "publishing-myra" ? "Connecting your model…" : "Getting Myra ready…"
            }
          />
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
