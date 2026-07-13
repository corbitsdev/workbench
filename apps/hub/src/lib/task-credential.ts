import { type } from "arktype";
import { resolveCredentialRequirement } from "@intx/db";
import type { ResolveAdapterCredential } from "@workbench/tasks";
import type { HubDb } from "../db";
import { decryptToolCredentialSecret } from "./credential-crypto";

// The subset of a provider's metadata this resolver reads. `+: "ignore"` keeps
// any other keys, so an unrelated metadata shape still parses.
export const ProviderMetadataSchema = type({
  "baseURL?": "string",
  "+": "ignore",
});
export type ProviderMetadata = typeof ProviderMetadataSchema.infer;

// Resolve a task adapter's tenant credential to the `{ apiKey, baseURL }` shape
// the adapter's downstream tool package expects. Tenant-scoped per call so the
// same resolver serves both the per-tenant push route and the global
// pending-ref reconciler (which spans tenants). A missing credential resolves
// to null (the push service leaves the ref pending); an ambiguous-match error
// from the resolver is a real misconfiguration and propagates.
export function resolveAdapterCredential(db: HubDb): ResolveAdapterCredential {
  return async (providerName, tenantId) => {
    const resolved = await resolveCredentialRequirement(
      db,
      tenantId,
      { providerName, source: "tenant" },
      null,
      null,
    );
    if (!resolved) return null;
    const providerRow = await db.query.provider.findFirst({
      where: (p, { eq }) => eq(p.id, resolved.providerId),
    });
    const parsed = ProviderMetadataSchema(providerRow?.metadata ?? {});
    const baseURL = parsed instanceof type.errors ? "" : (parsed.baseURL ?? "");
    return { apiKey: decryptToolCredentialSecret(resolved.secret), baseURL };
  };
}
