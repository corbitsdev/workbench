// Default land: `/` hops onto the conversation rail (`/w`). Myra is an
// agent row, opened the same way as any other agent — never find-or-created
// as the home slot. A brand-new bench with zero conversations has nothing
// to land in yet, so this hop waits for the setup agent (and a provider)
// before opening the empty rail, rather than auto-minting a Myra DM.
// Home as a dashboard does not earn its keep — `/` only exists as this hop
// onto `/w`. Deep links to other pages are unchanged.
//
// Right after a provider connect this hop is also the wait (CL-6457's
// deploys run in the background, so landing here can beat them). CL-6462
// settled what that wait looks like: one warm loader and nothing else. For
// a zero-conversation bench the wait is for Myra's own definition to exist
// at all. The check is simply retried every few seconds, because Myra's
// readiness IS the test of whether the person can start — she is deployed
// first (`SETUP_AGENT_ASSET_NAME` leads `DEFAULT_WORKFLOWS`), so the moment
// she's ready we go, with every other seeded workflow still converging
// behind us. Readiness is read only to tell a wait from a genuine failure,
// never to draw a progress number: a seed count is an implementation
// detail, and "0 of 5" told a waiting person nothing.
//
// CL-6780: a skip with no credential stops pretending anything is "getting
// ready" and offers the honest next step (connect a provider) instead of
// spinning forever.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { Clock, WarningCircle } from "@corbits/icons";
import { useEffect, useState } from "react";

import { listAllWorkbenches, WorkbenchLoadingState } from "@corbits/chat-ui";
import { describeApiError } from "@corbits/api-query";

import { fetchAgentReadiness, hasActiveCredential } from "../onboarding";
import { useBench } from "../bench-context";
import { WORKBENCH_PATH_PREFIX } from "../workbench-path";
import { useNavigate } from "../navigation";
import { ONBOARDING_PATH } from "../routes";

type LandState =
  /** Working on it: the warm loader, whether we are reading the bench's
   * conversations or waiting for Myra to finish coming online. Both are
   * the same thing to the person waiting. */
  | { readonly kind: "opening" }
  /** Zero conversations, credential present, Myra not ready yet — the
   * post-connect wait. */
  | { readonly kind: "waiting-for-agent" }
  /** Myra has taken long enough that silence would read as a hang. Says
   * so plainly and offers another go — never a frozen number. */
  | { readonly kind: "slow" }
  /** Zero conversations and no active credential: the drain never starts,
   * so waiting on "ready" would spin forever. Offer the connect step. */
  | { readonly kind: "needs-provider" }
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

    // Zero conversations: wait for Myra's own definition to exist, then
    // send the person to the rail rather than minting anything ourselves.
    // Without a credential the drain never starts (CL-6780), so a
    // not-ready status with no credential is an honest next step, not a
    // forever spin on "getting ready".
    const awaitFirstWorkbench = () => {
      void fetchAgentReadiness().then((readiness) => {
        if (cancelled) return;
        if (readiness.kind === "ready" || readiness.kind === "chat-ready") {
          navigate(WORKBENCH_PATH_PREFIX);
          return;
        }
        void hasActiveCredential(selectedTenantId).then((hasCredential) => {
          if (cancelled) return;
          if (!hasCredential) {
            setState({ kind: "needs-provider" });
            return;
          }
          setState((current) =>
            current.kind === "slow" ? current : { kind: "waiting-for-agent" },
          );
          waitAndRetry();
        });
      });
    };

    void listAllWorkbenches(selectedTenantId).then(
      (workbenches) => {
        if (cancelled) return;
        if (workbenches.length === 0) {
          awaitFirstWorkbench();
          return;
        }
        navigate(WORKBENCH_PATH_PREFIX);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: describeApiError(cause, "opening your conversations"),
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
          title="Couldn't open your conversations"
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

  if (state.kind === "needs-provider") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Connect a provider"
          description="Agents need a provider before they can come online. Connect one to finish setup."
          action={
            <Button variant="primary" onClick={() => navigate(ONBOARDING_PATH)}>
              Connect a provider
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
