import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@workbench/ui";
import { getOwnerDemos, setOwnerDemosEnabled } from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Demos. Turn the sidebar's Demos section on or off for the whole
 * workbench. Enabling writes a member-role `allow` for `demos`/`view`; while
 * disabled (the default) the hub does not send the demo links to any client.
 */
export function OwnerDemos() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const demos = useQuery({
    queryKey: ["owner", "demos"],
    queryFn: getOwnerDemos,
    staleTime: 5 * 60_000,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setOwnerDemosEnabled(enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owner", "demos"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () =>
      setError("Could not update the Demos section. Try again in a moment."),
  });

  if (demos.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (demos.isError || demos.data === undefined) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load the Demos setting. Try again in a moment.
      </p>
    );
  }

  const { enabled, forcedByEnv } = demos.data;

  let buttonLabel = enabled ? "Hide" : "Show";
  if (toggle.isPending) buttonLabel = "Saving…";

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        Show the Demos section in the sidebar for everyone in this workbench.
        Hidden by default — while off, the demo links are never sent to the
        browser.
      </p>
      {forcedByEnv && (
        <p className="text-sm text-text-2" role="status">
          Demos are forced on for everyone by the deployment’s SHOW_DEMOS
          setting. This toggle has no effect until that override is removed.
        </p>
      )}
      {error && (
        <p className="text-sm text-red-500" role="status">
          {error}
        </p>
      )}
      <div className={adminTableCard}>
        <div className="flex items-center justify-between gap-4 p-3">
          <div className="min-w-0">
            <p className="text-sm text-text">Demos section</p>
            <p className="text-xs text-text-3">
              {enabled ? "Visible to the workbench" : "Hidden"}
            </p>
          </div>
          <Button
            type="button"
            variant={enabled ? "ghost" : "primary"}
            size="sm"
            disabled={toggle.isPending || forcedByEnv}
            onClick={() => {
              setError(null);
              toggle.mutate(!enabled);
            }}
          >
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
