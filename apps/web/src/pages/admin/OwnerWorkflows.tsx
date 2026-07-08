import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@workbench/ui";
import { getOwnerWorkflows, setOwnerWorkflowEnabled } from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Workflows. Enable/disable each deployed workflow for the workbench.
 * Disabling writes a member-role `deny` for `workflow:<kind>`/`run`; the run
 * gate (CL-2885) then blocks starts of that kind. Enabling removes the deny.
 */
export function OwnerWorkflows() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const workflows = useQuery({
    queryKey: ["owner", "workflows"],
    queryFn: getOwnerWorkflows,
    staleTime: 5 * 60_000,
  });

  const toggle = useMutation({
    mutationFn: ({ kind, enabled }: { kind: string; enabled: boolean }) =>
      setOwnerWorkflowEnabled(kind, enabled),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["owner", "workflows"] }),
    onError: () =>
      setError("Could not update the workflow. Try again in a moment."),
  });

  if (workflows.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (workflows.isError || !workflows.data) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load workflows. Try again in a moment.
      </p>
    );
  }
  if (workflows.data.workflows.length === 0) {
    return (
      <p className="p-3 text-sm text-text-2">
        No workflows are deployed to this workbench yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        Turn workflows on or off for this workbench. Disabled workflows cannot
        be run by anyone in the workbench.
      </p>
      {error && (
        <p className="text-sm text-red-500" role="status">
          {error}
        </p>
      )}
      <div className={adminTableCard}>
        <ul className="divide-y divide-border">
          {workflows.data.workflows.map((w) => (
            <li
              key={w.kind}
              className="flex items-center justify-between gap-4 p-3"
            >
              <div className="min-w-0">
                <p className="font-mono text-sm text-text">{w.kind}</p>
                <p className="text-xs text-text-3">
                  {w.enabled ? "Enabled" : "Disabled"}
                </p>
              </div>
              <Button
                type="button"
                variant={w.enabled ? "ghost" : "primary"}
                size="sm"
                disabled={toggle.isPending}
                onClick={() => {
                  setError(null);
                  toggle.mutate({ kind: w.kind, enabled: !w.enabled });
                }}
              >
                {w.enabled ? "Disable" : "Enable"}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
