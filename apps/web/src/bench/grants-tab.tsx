import { ConfirmButton, toast } from "@corbits/react-ui";
import type { GrantEffect } from "@intx/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { WorkbenchParticipant } from "@/chat/threads-api";
import { QueryView, describeApiError, toAPIQuery } from "@/lib/api-query";
import { tenantKeys } from "@/query-client";
import { GRANT_RESOURCE_LABEL, type GrantResource } from "../settings/resource-vocabulary";
import { principalLabel } from "../settings/identity";
import { listGrants, revokeGrant, type Grant } from "../settings/tenancy-api";

const MODE: Record<GrantEffect, string> = {
  allow: "Always allow",
  ask: "Ask first",
  deny: "Deny",
};

const TOOL_PREFIX = "tool:";

/** "tool:artifact_link_file" reads "Artifact link file"; other resources keep
 * their vocabulary label. */
function resourceName(resource: string): string {
  if (!resource.startsWith(TOOL_PREFIX)) {
    return GRANT_RESOURCE_LABEL[resource as GrantResource] ?? resource;
  }
  const words = resource
    .slice(TOOL_PREFIX.length)
    .replace(/[_.-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** This workbench's own grants; they never inherit from the workspace. */
export function GrantsTab({
  workbenchTenantId,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const who = (grant: Grant): string => {
    if (grant.roleName !== undefined && grant.roleName !== null) return grant.roleName;
    const known = participants.find((p) => p.id === grant.principalId);
    if (known !== undefined) return known.name;
    return grant.principalName === undefined || grant.principalName === null
      ? "Everyone here"
      : principalLabel(grant.principalName).label;
  };
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
                    <span className="workbench-info-cell-primary" title={grant.resource}>
                      {resourceName(grant.resource)}
                    </span>
                    <span className="workbench-info-cell-context">{who(grant)}</span>
                  </span>
                  <span className="drawer-grant-mode" data-effect={grant.effect}>
                    {MODE[grant.effect]}
                  </span>
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
