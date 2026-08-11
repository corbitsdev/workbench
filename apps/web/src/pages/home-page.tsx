// Default land: open (or create) the Myra channel in the main stage. Home as a
// dashboard does not earn its keep — `/` only exists as the ensure+redirect
// hop onto `/c/:channelId`. Deep links to other pages are unchanged.

import { BootScreen, EmptyState, PageShell } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { ensureMyraChannel } from "../myra-channel";
import { useNavigate } from "../navigation";

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setError(null);
    void ensureMyraChannel(selectedTenantId).then((result) => {
      if (cancelled) return;
      if (result.kind === "ready") {
        navigate(channelPath(result.channelId));
        return;
      }
      setError(result.message);
    });
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

  if (error !== null) {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't open Myra"
          description={error}
        />
      </PageShell>
    );
  }

  return <BootScreen message="Opening Myra" />;
}
