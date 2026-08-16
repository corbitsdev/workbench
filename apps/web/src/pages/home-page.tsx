// Default land: a brand-new bench with zero workbenches auto-mints its
// first Myra workbench and lands straight in it (CL-6138, superseding the
// CL-6104 describe-screen step) — the same one-creation-verb mint
// `instant-agent-create.ts` gives every other "+ New workbench" control, so
// a fresh bench's very first workbench comes from the exact same path as
// every one after it. A bench that already has one or more lands in (or
// creates) the Myra channel in the main stage, unchanged. Home as a
// dashboard does not earn its keep — `/` only exists as this hop onto
// `/c/:channelId`. Deep links to other pages are unchanged.

import { BootScreen, Button, EmptyState, PageShell } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { listAllChannels } from "@corbits/chat-ui";

import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { createAgentAndLaunch } from "../instant-agent-create";
import { ensureMyraChannel } from "../myra-channel";
import { useNavigate } from "../navigation";

type LandState =
  | { readonly kind: "checking" }
  | { readonly kind: "error"; readonly message: string };

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const [state, setState] = useState<LandState>({ kind: "checking" });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setState({ kind: "checking" });
    void listAllChannels(selectedTenantId).then(
      (channels) => {
        if (cancelled) return;
        if (channels.length === 0) {
          createAgentAndLaunch(selectedTenantId, navigate).catch(
            (cause: unknown) => {
              if (cancelled) return;
              setState({
                kind: "error",
                message: cause instanceof Error ? cause.message : String(cause),
              });
            },
          );
          return;
        }
        void ensureMyraChannel(selectedTenantId).then((result) => {
          if (cancelled) return;
          if (result.kind === "ready") {
            navigate(channelPath(result.channelId));
            return;
          }
          setState({ kind: "error", message: result.message });
        });
      },
      (cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, navigate, retryCount]);

  if (memberships.kind === "loading") {
    return <BootScreen message="Opening Myra" />;
  }

  if (memberships.kind === "error") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<CircleAlert />}
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
          icon={<CircleAlert />}
          title="No workbench selected"
          description="Pick a workbench from the switcher, then Myra will open here."
        />
      </PageShell>
    );
  }

  if (state.kind === "error") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<CircleAlert />}
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

  return <BootScreen message="Opening Myra" />;
}
