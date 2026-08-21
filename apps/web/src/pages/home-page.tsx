// Default land: a bench that already has one or more workbenches lands in
// (or creates) the Myra workbench in the main stage. A brand-new bench with
// zero workbenches has nothing to land in yet, so this hop sends it to the
// guided create surface (`NewWorkbenchPickerRoute`, CL-6342) instead of
// auto-minting an unlabeled "New Workbench" and dropping the person straight
// into it — that auto-mint (CL-6138) is exactly the confusing empty-bench
// landing this hop used to produce. Home as a dashboard does not earn its
// keep — `/` only exists as this hop onto `/w/:workbenchId` or `/new`. Deep
// links to other pages are unchanged.
//
// Right after a provider connect this hop is also the wait (CL-6457's
// deploys run in the background, so landing here can beat them). CL-6462
// settled what that wait looks like: one warm loader and nothing else. For
// a zero-workbench bench the wait is for Myra's own definition to exist at
// all — the picker's "Create workbench" needs it too, so checking here
// first means the picker never opens onto a create button that would just
// throw. The check is simply retried every few seconds, because Myra's
// readiness IS the test of whether the person can start — she is deployed
// first (`SETUP_AGENT_ASSET_NAME` leads `DEFAULT_WORKFLOWS`), so the moment
// she's ready we go, with every other seeded workflow still converging
// behind us. Readiness is read only to tell a wait from a genuine failure,
// never to draw a progress number: a seed count is an implementation
// detail, and "0 of 5" told a waiting person nothing.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { Clock, WarningCircle } from "@corbits/icons";
import { useEffect, useState } from "react";

import { listAllWorkbenches, WorkbenchLoadingState } from "@corbits/chat-ui";
import { describeApiError } from "@corbits/api-query";

import { fetchAgentReadiness } from "../onboarding";
import { useBench } from "../bench-context";
import { workbenchPath } from "../workbench-path";
import { ensureMyraWorkbench } from "../myra-workbench";
import { useNavigate } from "../navigation";
import { NEW_WORKBENCH_PATH } from "../routes";

type LandState =
  /** Working on it: the warm loader, whether we are reading the bench's
   * workbenches or waiting for Myra to finish coming online. Both are
   * the same thing to the person waiting. */
  | { readonly kind: "opening" }
  /** Myra has taken long enough that silence would read as a hang. Says
   * so plainly and offers another go — never a frozen number. */
  | { readonly kind: "slow" }
  | { readonly kind: "error"; readonly message: string };

const LAND_RETRY_MS = 3_000;
const LAND_STALL_MS = 45_000;

export function HomeRoute({
  retryMs = LAND_RETRY_MS,
  stallAfterMs = LAND_STALL_MS,
}: {
  /** Timing seams. Production passes neither. */
  readonly retryMs?: number;
  readonly stallAfterMs?: number;
} = {}) {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const [state, setState] = useState<LandState>({ kind: "opening" });
  const [attempt, setAttempt] = useState(0);
  const [waitId, setWaitId] = useState(0);

  const startOver = () => {
    setState({ kind: "opening" });
    setAttempt(0);
    setWaitId((id) => id + 1);
  };

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const waitAndRetry = () => {
      if (cancelled) return;
      if ((attempt + 1) * retryMs >= stallAfterMs) {
        setState({ kind: "slow" });
      }
      // Slow is a message, not a stop: retries keep going underneath it so
      // a backend that recovers after the stall still lands on its own —
      // "Retry" stays as an escape hatch, never the only way forward.
      retryTimer = setTimeout(() => setAttempt((count) => count + 1), retryMs);
    };

    // A land that failed is either "she isn't up yet" or a real problem,
    // and only the bench itself can say which.
    const classify = (cause: unknown) => {
      void fetchAgentReadiness().then((readiness) => {
        if (cancelled) return;
        if (readiness.kind === "ready" || readiness.kind === "chat-ready") {
          setState({
            kind: "error",
            message: describeApiError(cause, "opening Myra"),
          });
          return;
        }
        waitAndRetry();
      });
    };

    // Zero workbenches: wait for Myra's own definition to exist, then send
    // the person to the picker rather than minting anything ourselves —
    // "she can't start yet" and "here, go create your first workbench"
    // are different messages, and only the readiness check tells them
    // apart.
    const awaitFirstWorkbench = () => {
      void fetchAgentReadiness().then((readiness) => {
        if (cancelled) return;
        if (readiness.kind === "ready" || readiness.kind === "chat-ready") {
          navigate(NEW_WORKBENCH_PATH);
          return;
        }
        waitAndRetry();
      });
    };

    void listAllWorkbenches(selectedTenantId).then(
      (workbenches) => {
        if (cancelled) return;
        if (workbenches.length === 0) {
          awaitFirstWorkbench();
          return;
        }
        void ensureMyraWorkbench(selectedTenantId).then((result) => {
          if (cancelled) return;
          if (result.kind === "ready") {
            navigate(workbenchPath(result.workbenchId));
            return;
          }
          classify(new Error(result.message));
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
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [selectedTenantId, navigate, attempt, waitId, retryMs, stallAfterMs]);

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
            <Button variant="outline" onClick={startOver}>
              Retry
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (state.kind === "slow") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<Clock />}
          title="Myra is taking longer than usual"
          description="She's still getting set up. Give it another moment, or try again."
          action={
            <Button variant="outline" onClick={startOver}>
              Retry
            </Button>
          }
        />
      </PageShell>
    );
  }

  return (
    <div className="page-fill shell-route-loading">
      <WorkbenchLoadingState delayMs={0} />
    </div>
  );
}
