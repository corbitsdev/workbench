import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@workbench/ui";
import {
  deleteTenantOffering,
  getTenantOfferings,
  setTenantOfferingDisabled,
} from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Catalog offerings management. Lists the offerings owned directly by
 * this tenant (the native owned-offerings route, which — unlike the `/models`
 * discovery view — includes disabled offerings and carries the `disabled`
 * flag) and lets the owner enable/disable or remove each one. Inherited
 * offerings never appear here; they are managed at the tenant that owns them.
 *
 * Model and provider ids are joined to human names through the discovery
 * view's lookups (passed in from the page). A disabled offering can be absent
 * from that view, so an unresolved id falls back to the raw id rather than
 * hiding the row.
 */
export function OwnerOfferings({
  tenantId,
  modelNameById,
  providerNameById,
}: {
  tenantId: string;
  modelNameById: Map<string, string>;
  providerNameById: Map<string, string>;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const offerings = useQuery({
    queryKey: ["owner", "offerings", tenantId],
    queryFn: () => getTenantOfferings(tenantId),
    staleTime: 5 * 60_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["owner", "offerings", tenantId],
    });

  const toggle = useMutation({
    mutationFn: (vars: { offeringId: string; disabled: boolean }) =>
      setTenantOfferingDisabled(tenantId, vars.offeringId, vars.disabled),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: () =>
      setError("Could not update the offering. Try again in a moment."),
  });

  const remove = useMutation({
    mutationFn: (offeringId: string) =>
      deleteTenantOffering(tenantId, offeringId),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: () =>
      setError("Could not remove the offering. Try again in a moment."),
  });

  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold text-text">Offerings</h2>
      <p className="mb-2 text-sm text-text-2">
        Enable, disable, or remove the offerings this workbench owns. Offerings
        inherited from a parent workbench are managed there and do not appear
        here.
      </p>

      {offerings.isLoading ? (
        <p className="p-3 text-sm text-text-2">Loading…</p>
      ) : offerings.isError || !offerings.data ? (
        <p className="p-3 text-sm text-text-2">
          Could not load offerings. Try again in a moment.
        </p>
      ) : offerings.data.length === 0 ? (
        <p className="p-3 text-sm text-text-2">
          This workbench owns no offerings yet.
        </p>
      ) : (
        <div className={adminTableCard}>
          <ul className="divide-y divide-border">
            {offerings.data.map((o) => {
              const modelName = modelNameById.get(o.modelId) ?? o.modelId;
              const providerName =
                providerNameById.get(o.providerId) ?? o.providerId;
              const busy = toggle.isPending || remove.isPending;
              return (
                <li
                  key={o.id}
                  className="flex items-center justify-between gap-4 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text">{modelName}</p>
                    <p className="mt-0.5 font-mono text-xs text-text-3">
                      {providerName}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-xs ${
                        o.disabled
                          ? "border-border text-text-3"
                          : "border-border text-text-2"
                      }`}
                    >
                      {o.disabled ? "Disabled" : "Enabled"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        toggle
                          .mutateAsync({
                            offeringId: o.id,
                            disabled: !o.disabled,
                          })
                          .catch(() => {
                            /* onError surfaces this to the user */
                          });
                      }}
                    >
                      {o.disabled ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        remove.mutateAsync(o.id).catch(() => {
                          /* onError surfaces this to the user */
                        });
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-text-3" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
