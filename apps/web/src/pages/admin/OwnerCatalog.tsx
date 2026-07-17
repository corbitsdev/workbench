import { useQuery } from "@tanstack/react-query";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import {
  getTenantProviders,
  getTenantModels,
  getOwnerCredentials,
} from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";
import { CredentialRow } from "./CredentialRow";
import { OwnerOfferings } from "./OwnerOfferings";

/**
 * Owner → Catalog. Read-only view of the workbench's model + provider catalog
 * (the tenant providers, including ones inherited from ancestor tenants, and
 * the resolved model catalog grouped under the providers that offer each
 * model — calls the native Interchange tenant APIs directly since owner holds
 * `*`/`*`, a superset of `provider:*`/`read` and `model:*`/`read`), plus a
 * "Provider credentials" section for the INFERENCE providers this workbench's
 * agents draw on (CL-2879/CL-2883). Credentials are write-only: the owner
 * pastes a key in and it is sent straight to the hub; every read only ever
 * sees masked configured/missing state, never the key itself. Tool-only
 * providers (Granola, Exa, Firecrawl, Gamma, Linear, GitHub, Attio) are
 * managed on the Capabilities tab, not here.
 */
export function OwnerCatalog() {
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

  const credentials = useQuery({
    queryKey: ["owner", "credentials"],
    queryFn: getOwnerCredentials,
  });
  const inferenceCredentials = credentials.data?.filter(
    (c) => c.kind === "inference",
  );

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

  // Join offering ids to human names via the discovery view: a model's id maps
  // to its canonicalName, and each offering carries its provider's id + name.
  const modelNameById = new Map(
    models.data.map((m) => [m.id, m.canonicalName]),
  );
  const providerNameById = new Map<string, string>();
  for (const m of models.data) {
    for (const o of m.offerings) {
      providerNameById.set(o.providerId, o.providerName);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">
          Provider credentials
        </h2>
        <p className="mb-2 text-sm text-text-2">
          Set or clear API keys for the inference providers this workbench's
          agents use. Keys are write-only — once saved, the key itself is never
          shown again, only whether a provider is configured.
        </p>
        {credentials.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : credentials.isError || !inferenceCredentials ? (
          <p className="p-3 text-sm text-text-2">
            Could not load credentials. Try again in a moment.
          </p>
        ) : inferenceCredentials.length === 0 ? (
          <p className="p-3 text-sm text-text-2">
            No inference providers are configurable for this workbench yet.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {inferenceCredentials.map((c) => (
                <CredentialRow key={c.providerName} credential={c} />
              ))}
            </ul>
          </div>
        )}
      </div>

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

      {activeTenantId && (
        <OwnerOfferings
          tenantId={activeTenantId}
          modelNameById={modelNameById}
          providerNameById={providerNameById}
        />
      )}
    </div>
  );
}
