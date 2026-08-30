// Persistence for CL-7208's snooze-until: `@corbits/mailbox`'s enrichment
// has no column for it (see `./schema.ts`), so this module owns the
// package's one product table and the two operations built on it — set at
// snooze time, and the atomic claim-and-reopen a periodic sweep drives
// once `until` has passed.
import { and, eq, lte } from "drizzle-orm";
import {
  enrichMailboxMessage,
  getMailboxMessage,
  type MailboxDb,
} from "@corbits/mailbox";

import { inboxSnooze } from "./schema";

export interface SnoozeScope {
  tenantId: string;
  principalId: string;
  id: string;
}

/**
 * Record when a snoozed message should reopen. Written *before* the
 * message's own status flips to `snoozed` (see `routes.ts`'s `/:id/snooze`
 * handler): if the status flip then fails, the message is left in
 * whatever status it already had with an orphaned snooze row pointing at
 * it — harmless, since `claimAndReopenSnooze` below no-ops and cleans up a
 * row whose message isn't actually `snoozed`. The other ordering (status
 * first, `until` second) would reproduce the exact bug this ticket fixes:
 * a message stuck `snoozed` with nothing ever recording when to reopen it.
 */
export async function setSnoozeUntil(
  db: MailboxDb,
  scope: SnoozeScope,
  until: Date,
): Promise<void> {
  await db
    .insert(inboxSnooze)
    .values({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      messageId: scope.id,
      until,
    })
    .onConflictDoUpdate({
      target: [
        inboxSnooze.tenantId,
        inboxSnooze.principalId,
        inboxSnooze.messageId,
      ],
      set: { until },
    });
}

export async function clearSnoozeUntil(
  db: MailboxDb,
  scope: SnoozeScope,
): Promise<void> {
  await db
    .delete(inboxSnooze)
    .where(
      and(
        eq(inboxSnooze.tenantId, scope.tenantId),
        eq(inboxSnooze.principalId, scope.principalId),
        eq(inboxSnooze.messageId, scope.id),
      ),
    );
}

export interface DueSnooze {
  tenantId: string;
  principalId: string;
  messageId: string;
}

/** Every snooze row due at or before `now`. A bare `SELECT` — claims
 * nothing, so two hub replicas can see the same row; `claimAndReopenSnooze`
 * is what makes acting on it race-safe. */
export async function findDueSnoozes(
  db: MailboxDb,
  now: Date,
): Promise<DueSnooze[]> {
  const rows = await db
    .select({
      tenantId: inboxSnooze.tenantId,
      principalId: inboxSnooze.principalId,
      messageId: inboxSnooze.messageId,
    })
    .from(inboxSnooze)
    .where(lte(inboxSnooze.until, now));
  return rows;
}

/**
 * Atomically claim one due snooze row and reopen its message if it's still
 * `snoozed` — all inside one transaction, so the delete-claim and the
 * status flip either both happen or neither does. Two replicas racing the
 * same row: the second's `DELETE ... RETURNING` simply returns no rows
 * (the first already deleted it), so only one replica ever flips the
 * status or is told to publish a reopened event.
 *
 * Returns whether this call actually reopened the message — `false` means
 * it lost the race, the row was no longer due, or the message had already
 * left `snoozed` (e.g. the user manually reopened it) and the row was just
 * cleaned up. A throw rolls the whole transaction back, so a failure here
 * leaves the snooze row exactly as it was — retried on the sweep's next
 * tick rather than dropped (the same mail-then-claim ordering lesson
 * CL-7209 applied to the credential-expiry sweep, applied here to the
 * claim itself).
 */
export async function claimAndReopenSnooze(
  db: MailboxDb,
  row: DueSnooze,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .delete(inboxSnooze)
      .where(
        and(
          eq(inboxSnooze.tenantId, row.tenantId),
          eq(inboxSnooze.principalId, row.principalId),
          eq(inboxSnooze.messageId, row.messageId),
          lte(inboxSnooze.until, now),
        ),
      )
      .returning({ messageId: inboxSnooze.messageId });
    if (claimed.length === 0) return false;

    const message = await getMailboxMessage(tx, {
      tenantId: row.tenantId,
      principalId: row.principalId,
      id: row.messageId,
    });
    if (message === null || message.status !== "snoozed") return false;

    await enrichMailboxMessage(
      tx,
      {
        tenantId: row.tenantId,
        principalId: row.principalId,
        id: row.messageId,
      },
      { status: "open" },
    );
    return true;
  });
}
