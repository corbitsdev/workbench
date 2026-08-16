// The Plugins gallery's one seam onto tenant inheritance (CL-6090): a
// workbench (a bench tenant, or any of its channel/sub-workbench children)
// does not hold its own copy of every plugin connection — it inherits
// whatever an ancestor tenant connected, unless it has connected (or
// explicitly removed) that connector for itself. This module is the
// browser-safe client for the one already-published, already-chain-aware
// route that makes that honest: `GET /credentials/resolve/:name`
// (`vendor/intx/hub-api/src/routes/credentials.ts`, backed by
// `resolveCredentialByName` in `vendor/intx/db/src/credential-resolution.ts`
// — the same ancestor-walk `buildCredentialDelivery` uses at agent-launch
// time to hand a run its provider credential). The plain `GET /credentials`
// list route this package's own `credentials-api.ts` equivalent in
// settings-ui calls is tenant-local only and would silently hide anything
// a parent tenant connected — this module deliberately calls the resolver
// instead of that list route.
//
// A connector's CREDENTIAL row is named after `descriptor.displayName`
// (see `./routes.ts`'s `/complete` handler) — the exact name this module
// resolves by. That means a credential seeded under a different name (for
// example onboarding's `"<id>-default"` rows for the inference providers)
// will not be found here; those inference-provider connectors are already
// a Settings-only concern with no plugins-gallery card of their own, so
// this gap does not reach the gallery, but it would if a future connector
// grew a second write path with its own naming.
//
// `granola-webhook` (`authKind: "webhook-secret"`) is deliberately excluded
// from resolution here: its "connection" is a routine binding plus a minted
// secret, not a `Credential` row, and a routine lives in exactly one bench
// tenant — there is no inheritance story for it. `GranolaWebhookCard`
// (`@corbits/settings-ui`) already owns that surface end to end; a caller
// composes it directly instead of resolving it through this module.

import { type } from "arktype";

import type { ConnectorDescriptor } from "./descriptor";
import { connectorDescriptors } from "./registry";

/** Where a resolved plugin's credential actually lives relative to the
 * tenant that asked: `"this-workbench"` when this exact tenant owns it,
 * `"inherited"` when an ancestor does — the ancestor-chain walk shadows a
 * closer tenant's own credential over a farther one automatically, so
 * `"inherited"` always means "no closer credential exists." */
export type PluginProvenance = "this-workbench" | "inherited";

export type ResolvedPlugin =
  | {
      readonly descriptor: ConnectorDescriptor;
      readonly status: "connected" | "needs_attention";
      readonly provenance: PluginProvenance;
      readonly credentialId: string;
      readonly credentialName: string;
    }
  | {
      readonly descriptor: ConnectorDescriptor;
      readonly status: "not_connected";
      readonly provenance: null;
      readonly credentialId: null;
      readonly credentialName: null;
    };

const ResolvedCredential = type({
  id: "string",
  tenantId: "string",
  name: "string",
  status: "'active' | 'expired' | 'revoked' | 'error'",
});

function notConnected(descriptor: ConnectorDescriptor): ResolvedPlugin {
  return {
    descriptor,
    status: "not_connected",
    provenance: null,
    credentialId: null,
    credentialName: null,
  };
}

async function resolveOne(
  tenantId: string,
  descriptor: ConnectorDescriptor,
): Promise<ResolvedPlugin> {
  const response = await fetch(
    `/api/tenants/${tenantId}/credentials/resolve/${encodeURIComponent(descriptor.displayName)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return notConnected(descriptor);
  if (!response.ok) {
    throw new Error(
      `Couldn't resolve ${descriptor.displayName}'s connection status (${String(response.status)}).`,
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  const parsed = ResolvedCredential(json);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Unexpected response shape resolving ${descriptor.displayName}: ${parsed.summary}`,
    );
  }
  const provenance: PluginProvenance =
    parsed.tenantId === tenantId ? "this-workbench" : "inherited";
  if (parsed.status === "active") {
    return {
      descriptor,
      status: "connected",
      provenance,
      credentialId: parsed.id,
      credentialName: parsed.name,
    };
  }
  if (parsed.status === "expired" || parsed.status === "error") {
    return {
      descriptor,
      status: "needs_attention",
      provenance,
      credentialId: parsed.id,
      credentialName: parsed.name,
    };
  }
  // A revoked credential reads the same as never having connected — the
  // tenant must reconnect from scratch, same rule `connections-status.ts`
  // applies for the tenant-local case.
  return notConnected(descriptor);
}

/**
 * Every registered connector's resolved status for `tenantId`, honest about
 * the ancestor tenant chain: a connector a parent/root tenant connected
 * resolves `"inherited"` here unless `tenantId` holds its own credential of
 * the same name, which shadows it. This is the primitive a per-workbench
 * "inherited vs. yours, with a remove/override action" view (CL-6089) reads
 * instead of re-deriving chain-walk logic of its own.
 */
export function listPluginsForTenant(
  tenantId: string,
): Promise<readonly ResolvedPlugin[]> {
  return Promise.all(
    connectorDescriptors()
      .filter((descriptor) => descriptor.authKind !== "webhook-secret")
      .map((descriptor) => resolveOne(tenantId, descriptor)),
  );
}
