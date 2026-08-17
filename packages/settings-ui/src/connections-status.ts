// Pure status derivation for a connector card: cross-references a
// `ConnectorDescriptor` against the tenant's already-fetched credentials
// and providers (no new fetch — see connections-section.tsx).

import type { Credential, Provider } from "./credentials-api";

export type ConnectorStatus = "not_connected" | "connected" | "needs_attention";

export type ConnectorStatusResult =
  | { readonly status: "not_connected" }
  | { readonly status: "connected"; readonly credential: Credential }
  | { readonly status: "needs_attention"; readonly credential: Credential };

/**
 * The backend names a connector's provider row after the connector's
 * lowercase `id` (see `packages/connections/src/routes.ts`'s and
 * `@workbench/hub-client`'s `seed.ts`'s own `ensureProvider` calls,
 * both of which pass `descriptor.id`/`seed.provider.name`, never a
 * display label) — matching on that id is how a card finds its provider
 * without a new list route. `displayName` is UI-only and never reaches
 * a provider row, so matching on it here would leave every card reading
 * "not connected" forever. If a tenant reconnected more than once, more
 * than one credential can point at the same provider; the tiebreak here
 * is newest `createdAt` (falling back to `updatedAt` for a tie) — "most
 * recently created" reads as "the connection currently in effect" better
 * than "most recently touched," since a stale credential can still be
 * touched by an unrelated update.
 */
export function connectorStatus(
  connectorId: string,
  credentials: readonly Credential[],
  providers: readonly Provider[],
): ConnectorStatusResult {
  const provider = providers.find((p) => p.name === connectorId);
  if (provider === undefined) return { status: "not_connected" };

  const matches = credentials.filter((c) => c.providerId === provider.id);
  if (matches.length === 0) return { status: "not_connected" };

  const newest = matches.reduce((latest, candidate) => {
    const latestKey = latest.createdAt ?? latest.updatedAt;
    const candidateKey = candidate.createdAt ?? candidate.updatedAt;
    return candidateKey > latestKey ? candidate : latest;
  });

  if (newest.status === "active") {
    return { status: "connected", credential: newest };
  }
  if (newest.status === "expired" || newest.status === "error") {
    return { status: "needs_attention", credential: newest };
  }
  // revoked reads the same as never having connected — nothing to attend
  // to, the user must reconnect from scratch.
  return { status: "not_connected" };
}
