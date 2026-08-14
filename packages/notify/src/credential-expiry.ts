// Pure decision layer for the "notify to reconnect" fallback the
// CL-5988 research settled on: an OAuth-connected provider (Hugging
// Face today) documents no silent-renewal or refresh-token grant for
// its consumer PKCE flow, so a stored credential's `metadata.expiresAt`
// is the only signal a periodic sweep has that a token has gone stale.
// This module only decides which stored credentials just crossed that
// line as of a given instant; it touches no database and sends no
// mail. The caller (a periodic sweep, e.g. apps/hub's
// credential-expiry-sweep.ts) is responsible for loading candidates,
// marking each due credential `expired` so a later tick doesn't
// re-decide it, and mailing the paired event via `deliverCredentialMail`.
import type { CredentialExpiredNotification, NotifyRecipient } from "./events";

export type ExpiringCredential = {
  readonly credentialId: string;
  readonly tenantId: string;
  readonly providerId: string;
  readonly providerLabel: string;
  readonly status: "active" | "expired" | "revoked" | "error";
  /** ISO instant from the credential's `metadata.expiresAt`; `undefined`
   * when the credential carries no expiry (a durable key or PAT). */
  readonly expiresAt: string | undefined;
  readonly recipients: readonly NotifyRecipient[];
};

export type DueCredentialExpiry = {
  readonly credential: ExpiringCredential;
  readonly event: CredentialExpiredNotification;
};

/**
 * Which of `candidates` just crossed their stored expiry as of `now`:
 * still `active` (an already-`expired`/`revoked`/`error` row was
 * handled by an earlier tick or another path, and is never re-decided
 * here), carries a parseable `expiresAt`, and that instant is at or
 * before `now`. Order is preserved from `candidates`.
 */
export function findDueCredentialExpiries(
  candidates: readonly ExpiringCredential[],
  now: Date,
): readonly DueCredentialExpiry[] {
  const due: DueCredentialExpiry[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== "active") continue;
    if (candidate.expiresAt === undefined) continue;
    const expiresAt = new Date(candidate.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) continue;
    if (expiresAt.getTime() > now.getTime()) continue;
    due.push({
      credential: candidate,
      event: {
        kind: "credential-expired",
        tenantId: candidate.tenantId,
        credentialId: candidate.credentialId,
        providerId: candidate.providerId,
        providerLabel: candidate.providerLabel,
        recipients: [...candidate.recipients],
        createdAt: now.toISOString(),
      },
    });
  }
  return due;
}
