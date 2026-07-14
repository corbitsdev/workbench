import { resolveCredentialRequirement, resolveProviderByName } from "@intx/db";
import type { HubDb } from "../db";
import { decryptToolCredentialSecret } from "./credential-crypto";
import { resolveOAuthToken } from "./oauth-flow";

/**
 * A tool credential resolved for a specific member, with its provenance. The
 * `apiKey` is a secret — never log or persist it. `baseURL` is the provider
 * row's configured endpoint (empty when none).
 */
export interface MemberToolCredential {
  apiKey: string;
  baseURL: string;
  source: "member" | "tenant";
}

/**
 * The CL-3510 credential rail: resolve a tool credential for the brief / intake
 * / triage paths, preferring the MEMBER's own connected OAuth token over the
 * shared tenant key, falling back to the tenant credential when the member has
 * not connected the provider.
 *
 * This is the seam that makes a per-user OAuth connection actually usable: the
 * member's principal-owned `oauth_token` credential (minted by the Connections
 * flow) is consulted first, so a member who connected their own Linear/Attio
 * account acts as themselves; a member who has not connected still gets the
 * tenant key when one is configured. A provider with neither returns null — the
 * caller skips that source legibly rather than stubbing.
 *
 * The member token is read through `resolveOAuthToken` (which filters by the
 * member principal and skips non-active rows) so a revoked/expired connection
 * transparently falls through to the tenant key instead of failing.
 */
export async function resolveMemberOrTenantToolCredential(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
  providerName: string,
): Promise<MemberToolCredential | null> {
  const providerRow = await resolveProviderByName(db, tenantId, providerName);
  const metadata =
    providerRow?.metadata != null && typeof providerRow.metadata === "object"
      ? (providerRow.metadata as { baseURL?: string })
      : undefined;
  const baseURL = metadata?.baseURL ?? "";

  const memberToken = await resolveOAuthToken(
    db,
    tenantId,
    memberPrincipalId,
    providerName,
  );
  if (memberToken) {
    return { apiKey: memberToken.accessToken, baseURL, source: "member" };
  }

  const tenantCred = await resolveCredentialRequirement(
    db,
    tenantId,
    { providerName, source: "tenant" },
    null,
    null,
  );
  if (!tenantCred) return null;
  return {
    apiKey: decryptToolCredentialSecret(tenantCred.secret),
    baseURL,
    source: "tenant",
  };
}

/**
 * Resolve a provider's TENANT-owned tool credential, with no member fallback.
 * Used by workspace-scope inbox sources (tenant-wide pollers), which run once
 * per tenant with no member principal to prefer. Returns null when the tenant
 * has no configured credential — the caller skips the source legibly.
 */
export async function resolveTenantToolCredential(
  db: HubDb,
  tenantId: string,
  providerName: string,
): Promise<MemberToolCredential | null> {
  const providerRow = await resolveProviderByName(db, tenantId, providerName);
  const metadata =
    providerRow?.metadata != null && typeof providerRow.metadata === "object"
      ? (providerRow.metadata as { baseURL?: string })
      : undefined;
  const baseURL = metadata?.baseURL ?? "";

  const tenantCred = await resolveCredentialRequirement(
    db,
    tenantId,
    { providerName, source: "tenant" },
    null,
    null,
  );
  if (!tenantCred) return null;
  return {
    apiKey: decryptToolCredentialSecret(tenantCred.secret),
    baseURL,
    source: "tenant",
  };
}
