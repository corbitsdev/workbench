// Carries a just-connected credential's plaintext key from the OAuth
// callback (which must never wait on a workflow deploy — see
// `complete-credential.ts`) to the onboarding page's own follow-up
// request, the one that actually runs `ensureSeeded`. The hub's
// credential rows are write-only by design (a secret is never handed
// back over `GET /api/tenants/:id/credentials`), so once the callback's
// own request ends, the plaintext key is gone from memory unless
// something carries it forward — this is that something.
//
// Sealed the same way the PKCE connect state is (`pkce.ts`): AEAD via
// the shared `CredentialCipher`, so a value minted moments before a hub
// restart survives it. Handed to the browser as an HttpOnly cookie, not
// a redirect query parameter, so the key never touches a URL, browser
// history, or a referrer header. Unlike the connect state, this is not
// single-use — the workflow-deploy step it feeds
// (`seedTenant`/`ensureSeeded`) is itself idempotent (409-then-list on
// every create), so two overlapping "finish setup" calls both reading
// the same still-valid cookie is exactly as safe as one, and a legit
// retry after a transient failure can reuse it within the same short
// window instead of being stranded with no key to retry with.

import { type } from "arktype";
import type { CredentialCipher } from "@intx/types";
import {
  supportedCredentialProviders,
  type SupportedCredentialProvider,
} from "@workbench/hub-client";

export const PENDING_SEED_COOKIE = "workbench_pending_seed";
export const PENDING_SEED_TTL_MS = 10 * 60 * 1000;

const PROVIDER_IDS = supportedCredentialProviders().map((p) => p.id) as [
  SupportedCredentialProvider,
  ...SupportedCredentialProvider[],
];

const PendingSeedPayload = type({
  userId: "string > 0",
  tenantId: "string > 0",
  principalId: "string > 0",
  tenantDomain: "string > 0",
  provider: type.enumerated(...PROVIDER_IDS),
  apiKey: "string > 0",
  expiresAt: "number",
});

export type PendingSeed = {
  readonly userId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly tenantDomain: string;
  readonly provider: SupportedCredentialProvider;
  readonly apiKey: string;
};

const PENDING_SEED_AAD = JSON.stringify(["onboarding-pending-seed"]);

export function sealPendingSeed(
  cipher: CredentialCipher,
  seed: PendingSeed,
  args: { ttlMs?: number; now?: () => number } = {},
): Promise<string> {
  const now = args.now ?? Date.now;
  const ttlMs = args.ttlMs ?? PENDING_SEED_TTL_MS;
  const payload = { ...seed, expiresAt: now() + ttlMs };
  return cipher.encrypt(JSON.stringify(payload), PENDING_SEED_AAD);
}

/**
 * Opens a sealed pending-seed cookie for exactly the signed-in user and
 * personal tenant this request already resolved — a token minted for a
 * different user or a different tenant (a stale cookie left over from a
 * prior account on a shared browser) is rejected exactly like an
 * expired or corrupt one, never partially trusted.
 */
export async function openPendingSeed(
  cipher: CredentialCipher,
  token: string,
  args: {
    userId: string;
    tenantId: string;
    now?: () => number;
  },
): Promise<PendingSeed | undefined> {
  const now = args.now ?? Date.now;
  let payload: typeof PendingSeedPayload.infer;
  try {
    const plaintext = await cipher.decrypt(token, PENDING_SEED_AAD);
    const parsed = PendingSeedPayload(JSON.parse(plaintext));
    if (parsed instanceof type.errors) return undefined;
    payload = parsed;
  } catch {
    return undefined;
  }

  if (payload.expiresAt <= now()) return undefined;
  if (payload.userId !== args.userId) return undefined;
  if (payload.tenantId !== args.tenantId) return undefined;

  const { expiresAt: _expiresAt, ...seed } = payload;
  return seed;
}
