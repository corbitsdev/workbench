import { toast } from "@corbits/react-ui/ui/toast";
import type { GrantEffect } from "@intx/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { WorkbenchParticipant } from "@/chat/threads-api";
import { QueryView, describeApiError, toAPIQuery } from "@/lib/api-query";
import { tenantKeys } from "@/query-client";
import { GRANT_RESOURCE_LABEL, type GrantResource } from "../settings/resource-vocabulary";
import { principalLabel } from "../settings/identity";
import { listGrants, updateGrant, type Grant } from "../settings/tenancy-api";
import { useGrantNames } from "./grant-names";
import "./drawer.css";

const EFFECTS: readonly { readonly effect: GrantEffect; readonly label: string }[] = [
  { effect: "allow", label: "Allow" },
  { effect: "ask", label: "Ask" },
  { effect: "deny", label: "Deny" },
];

const TOOL_PREFIX = "tool:";

/** A tool grant shows the tool's native name; other resources keep their
 * vocabulary label. */
function resourceName(resource: string): string {
  if (resource.startsWith(TOOL_PREFIX)) return resource.slice(TOOL_PREFIX.length);
  return GRANT_RESOURCE_LABEL[resource as GrantResource] ?? resource;
}

/** This workbench's own grants; they never inherit from the workspace. */
export function GrantsTab({
  workbenchTenantId,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const names = useGrantNames(workbenchTenantId);
  const who = (grant: Grant): string | undefined => {
    if (grant.roleName !== undefined && grant.roleName !== null) return grant.roleName;
    const known = participants.find((p) => p.id === grant.principalId);
    if (known !== undefined) return known.name;
    if (grant.principalName === undefined || grant.principalName === null) return "Everyone here";
    const named = names.replaceTenantIds(grant.principalName);
    // A raw run id is never shown; with no resolvable name the row has no hint.
    return principalLabel(named).raw === null ? named : undefined;
  };
  const queryClient = useQueryClient();
  const query = toAPIQuery<readonly Grant[]>(
    useQuery({
      queryKey: tenantKeys.grants(workbenchTenantId),
      queryFn: () => listGrants(workbenchTenantId, {}),
    }),
  );
  const setEffect = useMutation({
    mutationFn: (input: { readonly grant: Grant; readonly effect: GrantEffect }) =>
      updateGrant(workbenchTenantId, input.grant.id, { effect: input.effect }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tenantKeys.grants(workbenchTenantId) });
    },
    onError: (cause: unknown) => {
      toast(describeApiError(cause, "changing this grant"));
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
            <div>
              {grants.map((grant) => {
                const label = names.resource(grant.resource) ?? resourceName(grant.resource);
                return (
                  <div key={grant.id} className="drawer-perm" title={who(grant)}>
                    <b className="drawer-perm-name">{label}</b>
                    <div className="drawer-seg" role="radiogroup" aria-label={label}>
                      {EFFECTS.map(({ effect, label: text }) => (
                        <button
                          key={effect}
                          type="button"
                          role="radio"
                          aria-checked={effect === grant.effect}
                          className={effect === grant.effect ? "active" : undefined}
                          disabled={setEffect.isPending}
                          onClick={() => {
                            if (effect !== grant.effect) setEffect.mutate({ grant, effect });
                          }}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        }
      </QueryView>
    </section>
  );
}
