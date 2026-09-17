// Pure decision layer for the reconnect-notice sweep (CL-8181): given the
// stock-shaped credential rows this workflow's own tool fetches from
// `GET /api/tenants/:tenantId/credentials`, decide which are `active`
// and already past their own `expiresAt`. Ported from the hub's
// `credential-expiry-sweep.ts` (CL-5988), which decided the same thing
// over DB rows and one specific provider's `metadata.expiresAt`; this
// workflow reads the credential's real `expiresAt` column through the
// stock route instead, so the decision generalizes across every
// provider rather than a curated `SWEPT_PROVIDER_LABELS` list.
//
// Touches no network and sends no mail — the caller (`./tool.ts`) is
// responsible for fetching candidates and turning a due credential into
// a reconnect notice.

export type CredentialStatus = "active" | "expired" | "revoked" | "error";

export type ExpiringCredential = {
  readonly credentialId: string;
  readonly name: string;
  readonly providerLabel: string;
  readonly status: CredentialStatus;
  /** ISO instant from the credential's own `expiresAt` column;
   * `undefined`/`null` for a durable credential with no expiry. */
  readonly expiresAt: string | null | undefined;
};

export type DueCredentialExpiry = {
  readonly credential: ExpiringCredential;
};

/**
 * Which of `candidates` are `active` and past their own `expiresAt` as
 * of `now`. An already `expired`/`revoked`/`error` row is never
 * re-decided here, and an unparseable or absent `expiresAt` is skipped
 * rather than guessed at. Order is preserved from `candidates`.
 */
export function findDueCredentialExpiries(
  candidates: readonly ExpiringCredential[],
  now: Date,
): readonly DueCredentialExpiry[] {
  const due: DueCredentialExpiry[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== "active") continue;
    if (candidate.expiresAt === null || candidate.expiresAt === undefined) {
      continue;
    }
    const expiresAt = new Date(candidate.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) continue;
    if (expiresAt.getTime() > now.getTime()) continue;
    due.push({ credential: candidate });
  }
  return due;
}
