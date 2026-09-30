import { Badge, ConfirmButton, toast } from "@corbits/react-ui";
import type { GrantEffect } from "@intx/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { QueryView, describeApiError, toAPIQuery } from "@/lib/api-query";
import { tenantKeys } from "@/query-client";
import { listGrants, revokeGrant, type Grant } from "../settings/tenancy-api";

const MODE: Record<
  GrantEffect,
  { readonly label: string; readonly tone: "success" | "danger" | "info" }
> = {
  allow: { label: "Always allow", tone: "success" },
  ask: { label: "Ask", tone: "info" },
  deny: { label: "Deny", tone: "danger" },
};

/** This workbench's own grants; they never inherit from the workspace. */
export function GrantsTab({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const queryClient = useQueryClient();
  const query = toAPIQuery<readonly Grant[]>(
    useQuery({
      queryKey: tenantKeys.grants(workbenchTenantId),
      queryFn: () => listGrants(workbenchTenantId, {}),
    }),
  );
  const revoke = useMutation({
    mutationFn: (grant: Grant) => revokeGrant(workbenchTenantId, grant.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantKeys.grants(workbenchTenantId) });
      toast("Grant revoked.");
    },
    onError: (cause: unknown) => {
      toast(describeApiError(cause, "revoking this grant"));
    },
  });

  return (
    <section className="workbench-info-panel">
      <div className="workbench-info-panel-header">
        <h2>What workers may do here</h2>
      </div>
      <p className="workbench-info-empty-note">
        Set per workbench. Never inherited from the workspace.
      </p>
      <QueryView query={query} label="this workbench's grants" skeleton="rows">
        {(grants) =>
          grants.length === 0 ? (
            <p className="workbench-info-empty-note">No grants here yet.</p>
          ) : (
            <ul className="bench-tab-list">
              {grants.map((grant) => (
                <li key={grant.id} className="bench-tab-row">
                  <span className="bench-tab-text">
                    <span className="bench-tab-mono">{grant.action}</span>
                    <span className="workbench-info-cell-context">
                      {grant.resource} · {grant.roleName ?? grant.principalName ?? "—"}
                    </span>
                  </span>
                  <Badge tone={MODE[grant.effect].tone}>{MODE[grant.effect].label}</Badge>
                  <ConfirmButton
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    confirmLabel="Revoke?"
                    onConfirm={() => {
                      revoke.mutate(grant);
                    }}
                  >
                    Revoke
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
    </section>
  );
}
