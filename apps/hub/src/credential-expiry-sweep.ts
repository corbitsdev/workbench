// A minimal periodic loop that mails a reconnect nudge for any stored
// credential whose token just expired — the notify-to-reconnect half of
// CL-5988's Hugging Face connect. No provider documents a silent-renewal
// or refresh-token grant for a consumer PKCE flow (see
// docs/onboarding-huggingface-connect.md), so a credential's
// `metadata.expiresAt` (set at connect time by `completeCredentialSetup`)
// is the only signal a background sweep has. This mirrors
// `routine-scheduler.ts`'s own shape: the decision of *which* credentials
// are due lives in `@corbits/notify` (`findDueCredentialExpiries`), pure
// and unit-tested there; `CredentialExpirySweepStore` is the same
// store-behind-an-interface seam `@corbits/routines`' `RoutineStore` uses,
// so this loop's own claim/mail orchestration is testable against an
// in-memory store without a live Postgres.
//
// Interchange's inference reactor already fails a credential-category
// error over to the next configured source with no changes here — this
// sweep exists only to tell a human the failover is happening and how to
// stop it (reconnect, or drop in a durable fine-grained PAT instead).
import { and, eq, inArray } from "drizzle-orm";
import { type } from "arktype";
import { credential, principal, provider } from "@intx/db/schema";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import {
  deliverCredentialMail,
  findDueCredentialExpiries,
  type ExpiringCredential,
  type NotifyDeliveryDeps,
} from "@corbits/notify";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const log = getLogger(["hub", "credential-expiry-sweep"]);

// The OAuth-connected providers whose tokens expire, and how to name
// each in the notification. A second such provider generalizes this
// list, never a second parallel sweep.
export const SWEPT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  huggingface: "Hugging Face",
};

const CredentialMetadata = type({ "expiresAt?": "string" });

export type CredentialExpirySweepStore = {
  /** Every `active` credential on a swept provider, with its parsed
   * expiry (if any) and the recipients a reconnect nudge would reach. */
  loadActiveCandidates(): Promise<readonly ExpiringCredential[]>;
  /** Conditionally moves one credential from `active` to `expired`.
   * Returns whether this call won the claim — `false` means another
   * caller (a racing replica) already claimed this exact expiry. */
  claimExpiry(credentialId: string, now: Date): Promise<boolean>;
};

export function createDrizzleCredentialExpirySweepStore(
  db: DB["db"],
): CredentialExpirySweepStore {
  return {
    async loadActiveCandidates() {
      const sweptProviderNames = Object.keys(SWEPT_PROVIDER_LABELS);
      const rows = await db
        .select({
          id: credential.id,
          tenantId: credential.tenantId,
          status: credential.status,
          metadata: credential.metadata,
          providerName: provider.name,
        })
        .from(credential)
        .innerJoin(provider, eq(provider.id, credential.providerId))
        .where(
          and(
            eq(credential.status, "active"),
            inArray(provider.name, sweptProviderNames),
          ),
        );
      if (rows.length === 0) return [];

      const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
      const recipientRows = await db
        .select({ tenantId: principal.tenantId, principalId: principal.id })
        .from(principal)
        .where(
          and(
            inArray(principal.tenantId, tenantIds),
            eq(principal.kind, "user"),
            eq(principal.status, "active"),
          ),
        );
      const recipientsByTenant = new Map<
        string,
        { tenantId: string; principalId: string }[]
      >();
      for (const row of recipientRows) {
        const list = recipientsByTenant.get(row.tenantId) ?? [];
        list.push(row);
        recipientsByTenant.set(row.tenantId, list);
      }

      return rows.map((row) => {
        const parsedMetadata = CredentialMetadata(row.metadata ?? {});
        const expiresAt =
          parsedMetadata instanceof type.errors
            ? undefined
            : parsedMetadata.expiresAt;
        return {
          credentialId: row.id,
          tenantId: row.tenantId,
          providerId: row.providerName,
          providerLabel:
            SWEPT_PROVIDER_LABELS[row.providerName] ?? row.providerName,
          status: row.status,
          expiresAt,
          recipients: recipientsByTenant.get(row.tenantId) ?? [],
        };
      });
    },
    async claimExpiry(credentialId, now) {
      const claimed = await db
        .update(credential)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(eq(credential.id, credentialId), eq(credential.status, "active")),
        )
        .returning({ id: credential.id });
      return claimed.length > 0;
    },
  };
}

export type CredentialExpirySweepDeps = {
  store: CredentialExpirySweepStore;
  notify: NotifyDeliveryDeps;
  /** Injectable for deterministic tests; defaults to `Date.now`-backed wall time. */
  now?: () => Date;
};

/**
 * One sweep: claim and mail every credential expiry due at `now`.
 * Exported (rather than kept as a closure) so a test can drive a single,
 * deterministic pass without waiting on `setInterval`.
 */
export async function tickCredentialExpirySweep(
  deps: CredentialExpirySweepDeps,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await deps.store.loadActiveCandidates();
  const due = findDueCredentialExpiries(candidates, now);

  for (const { credential: expiring, event } of due) {
    const claimed = await deps.store.claimExpiry(expiring.credentialId, now);
    // False means another replica already claimed this exact expiry
    // between `loadActiveCandidates` and this claim — not an error.
    if (!claimed) continue;

    if (expiring.recipients.length === 0) {
      log.warn`credential ${expiring.credentialId} expired with no active recipient to notify`;
      continue;
    }
    await deliverCredentialMail(deps.notify, event);
  }
}

export function createCredentialExpirySweep(deps: CredentialExpirySweepDeps) {
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tickCredentialExpirySweep(deps);
    } catch (err) {
      log.error`credential expiry sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      tickInFlight = false;
    }
  }

  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
