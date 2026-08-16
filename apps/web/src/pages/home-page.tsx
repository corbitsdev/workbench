// Default land: a brand-new bench with zero workbenches lands on the
// guided first-workbench describe screen (CL-6104, step three of
// onboarding's four); a bench that already has one or more lands in (or
// creates) the Myra channel in the main stage, unchanged. Home as a
// dashboard does not earn its keep — `/` only exists as this hop onto
// either the describe screen or `/c/:channelId`. Deep links to other
// pages are unchanged.

import { BootScreen, EmptyState, PageShell } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { listAllChannels } from "@corbits/chat-ui";

import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { ensureMyraChannel } from "../myra-channel";
import { useNavigate } from "../navigation";
import { DescribeFirstWorkbench } from "./describe-first-workbench";

type LandState =
  | { readonly kind: "checking" }
  | { readonly kind: "no-workbenches" }
  | { readonly kind: "error"; readonly message: string };

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const [state, setState] = useState<LandState>({ kind: "checking" });

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setState({ kind: "checking" });
    void listAllChannels(selectedTenantId).then(
      (channels) => {
        if (cancelled) return;
        if (channels.length === 0) {
          setState({ kind: "no-workbenches" });
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
  }, [selectedTenantId, navigate]);

  if (memberships.kind === "loading") {
    return <BootScreen message="Opening Myra" />;
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

  if (state.kind === "no-workbenches") {
    return (
      <DescribeFirstWorkbench tenantId={selectedTenantId} navigate={navigate} />
    );
  }

  if (state.kind === "error") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't open Myra"
          description={state.message}
        />
      </PageShell>
    );
  }

  return <BootScreen message="Opening Myra" />;
}
