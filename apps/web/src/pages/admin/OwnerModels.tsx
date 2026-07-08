import { useQuery } from "@tanstack/react-query";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import { getTenantProviders, getTenantModels } from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

/**
 * Owner → Models. Read-only view of the workbench's model + provider catalog:
 * the tenant providers (including ones inherited from ancestor tenants) and
 * the resolved model catalog, grouped under the providers that offer each
 * model. Calls the native Interchange tenant APIs directly (owner holds
 * `*`/`*`, a superset of `provider:*`/`read` and `model:*`/`read`) rather than
 * a hub-specific endpoint. Read-only for v1 — adding/removing providers or
 * models is a follow-up.
 */
export function OwnerModels() {
  const { activeTenantId } = useActiveWorkbench();

  const providers = useQuery({
    queryKey: ["owner", "models", "providers", activeTenantId],
    queryFn: () => getTenantProviders(activeTenantId as string),
    enabled: !!activeTenantId,
    staleTime: 5 * 60_000,
  });

  const models = useQuery({
    queryKey: ["owner", "models", "catalog", activeTenantId],
    queryFn: () => getTenantModels(activeTenantId as string),
    enabled: !!activeTenantId,
    staleTime: 5 * 60_000,
  });

  if (providers.isLoading || models.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (providers.isError || models.isError || !providers.data || !models.data) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load the model catalog. Try again in a moment.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">Providers</h2>
        {providers.data.length === 0 ? (
          <p className="text-sm text-text-2">
            No providers are configured for this workbench yet.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {providers.data.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-4 p-3"
                >
                  <p className="text-sm text-text">{p.name}</p>
                  <p className="font-mono text-xs text-text-3">{p.plugin}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">Models</h2>
        {models.data.length === 0 ? (
          <p className="text-sm text-text-2">
            No models are resolved for this workbench yet.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {models.data.map((m) => (
                <li key={m.id} className="space-y-1 p-3">
                  <p className="text-sm text-text">
                    {m.displayName ?? m.canonicalName}
                  </p>
                  <p className="font-mono text-xs text-text-3">
                    {m.canonicalName}
                  </p>
                  {m.offerings.length === 0 ? (
                    <p className="text-xs text-text-3">
                      No offering providers.
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2 pt-1">
                      {m.offerings.map((o) => (
                        <li
                          key={o.offeringId}
                          className="rounded-md border border-border px-2 py-1 font-mono text-xs text-text-2"
                        >
                          {o.providerName}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
