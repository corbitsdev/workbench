// Default land: a brand-new bench with zero workbenches auto-mints its
// first Myra workbench and lands straight in it (CL-6138, superseding the
// CL-6104 describe-screen step) — the same one-creation-verb mint
// `instant-agent-create.ts` gives every other "+ New workbench" control, so
// a fresh bench's very first workbench comes from the exact same path as
// every one after it. A bench that already has one or more lands in (or
// creates) the Myra workbench in the main stage, unchanged. Home as a
// dashboard does not earn its keep — `/` only exists as this hop onto
// `/w/:workbenchId`. Deep links to other pages are unchanged.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { WarningCircle } from "@corbits/icons";
import { useEffect, useState } from "react";

import { listAllWorkbenches, WorkbenchLoadingState } from "@corbits/chat-ui";
import { describeApiError } from "@corbits/api-query";

import { fetchProvisioningProgress } from "../onboarding";
import { useBench } from "../bench-context";
import { workbenchPath } from "../workbench-path";
import { createAgentAndLaunch } from "../instant-agent-create";
import { ensureMyraWorkbench } from "../myra-workbench";
import { useNavigate } from "../navigation";

type LandState =
  | { readonly kind: "checking" }
  /** The bench exists and its credential is connected, but its agents
   * are still being deployed in the background (CL-6457). Landing here
   * is expected right after someone connects a provider — connecting
   * deliberately no longer waits for deploys — so this is a warm wait
   * with live progress, never an error. */
  | { readonly kind: "provisioning"; readonly live: number; readonly total: number }
  | { readonly kind: "error"; readonly message: string };

const PROVISIONING_POLL_MS = 3_000;

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const [state, setState] = useState<LandState>({ kind: "checking" });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setState({ kind: "checking" });
    void listAllWorkbenches(selectedTenantId).then(
      (workbenches) => {
        if (cancelled) return;
        if (workbenches.length === 0) {
          createAgentAndLaunch(selectedTenantId, navigate).catch(
            (cause: unknown) => {
              if (cancelled) return;
              // Myra cannot be launched if she has not finished
              // deploying yet. Rather than reading that off an error
              // message, ask the bench where its agents actually are: a
              // bench still provisioning is someone waiting, not someone
              // broken.
              void fetchProvisioningProgress().then((progress) => {
                if (cancelled) return;
                setState(
                  progress.ready
                    ? {
                        kind: "error",
                        message: describeApiError(cause, "opening Myra"),
                      }
                    : {
                        kind: "provisioning",
                        live: progress.live,
                        total: progress.total,
                      },
                );
              });
            },
          );
          return;
        }
        void ensureMyraWorkbench(selectedTenantId).then((result) => {
          if (cancelled) return;
          if (result.kind === "ready") {
            navigate(workbenchPath(result.workbenchId));
            return;
          }
          setState({ kind: "error", message: result.message });
        });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: describeApiError(cause, "opening Myra"),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, navigate, retryCount]);

  // While agents are still deploying, keep asking — and the moment the
  // bench is ready, re-run the land so the person drops straight into
  // Myra without touching anything.
  useEffect(() => {
    if (state.kind !== "provisioning") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void fetchProvisioningProgress().then((progress) => {
        if (cancelled) return;
        if (progress.ready) {
          setRetryCount((count) => count + 1);
          return;
        }
        setState({
          kind: "provisioning",
          live: progress.live,
          total: progress.total,
        });
      });
    }, PROVISIONING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.kind]);

  if (memberships.kind === "loading") {
    return (
      <div className="page-fill shell-route-loading">
        <WorkbenchLoadingState />
      </div>
    );
  }

  if (memberships.kind === "error") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't load your workbenches"
          description={memberships.message}
          action={
            <Button variant="outline" onClick={memberships.retry}>
              Retry
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (selectedTenantId === null) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="No workbench selected"
          description="Nothing to open yet — start a new workbench and Myra will be waiting in it."
        />
      </PageShell>
    );
  }

  if (state.kind === "error") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't open Myra"
          description={state.message}
          action={
            <Button
              variant="outline"
              onClick={() => setRetryCount((count) => count + 1)}
            >
              Retry
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (state.kind === "provisioning") {
    return (
      <div className="page-fill shell-route-loading">
        <WorkbenchLoadingState
          title="Getting your agents ready…"
          delayMs={0}
        />
        <p className="shell-route-loading-note" role="status">
          {state.total > 0
            ? `${state.live} of ${state.total} ready`
            : "This only takes a moment."}
        </p>
      </div>
    );
  }

  return (
    <div className="page-fill shell-route-loading">
      <WorkbenchLoadingState />
    </div>
  );
}
