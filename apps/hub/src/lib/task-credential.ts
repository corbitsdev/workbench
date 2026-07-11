import { resolveCredentialRequirement } from "@intx/db";
import type { ResolveAdapterCredential } from "@workbench/tasks";
import type { HubDb } from "../db";

// Resolve a task adapter's tenant credential to the `{ apiKey, baseURL }` shape
// the adapter's downstream tool package expects. Tenant-scoped per call so the
// same resolver serves both the per-tenant push route and the global
// pending-ref reconciler (which spans tenants). A missing credential resolves
// to null: the push service leaves the ref pending, never surfacing an error.
export function resolveAdapterCredential(db: HubDb): ResolveAdapterCredential {
  return async (providerName, tenantId) => {
    const resolved = await resolveCredentialRequirement(
      db,
      tenantId,
      { providerName, source: "tenant" },
      null,
      null,
    ).catch(() => null);
    if (!resolved) return null;
    const providerRow = await db.query.provider.findFirst({
      where: (p, { eq }) => eq(p.id, resolved.providerId),
    });
    const metadata = (providerRow?.metadata ?? {}) as { baseURL?: string };
    return { apiKey: resolved.secret, baseURL: metadata.baseURL ?? "" };
  };
}
