// Wires `@corbits/mailbox`'s `createMailboxPersist` onto the hub's own
// `persistMail` lookup (`vendor/intx/hub-sessions/src/hub-session-lookups.ts`)
// so every outbound agent frame also lands a durable `principal_mail` row in
// each addressed human participant's mailbox, not just `session_mail`.
//
// Two small seams live here, both host-owned by the package's own contract
// (`persist.ts` in `@corbits/mailbox`): `authorizeSender` decides which
// sender addresses may write at all, and the `onRow` hook stamps a workbench
// ref onto each row the package just inserted so the thread read can scope by
// workbench.

import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable } from "@intx/db/schema";
import { reportError } from "@corbits/error-sink";
import {
  principalMail,
  type MailboxDb,
  type AuthorizeMailboxSender,
  type PersistedMailboxRow,
} from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";

/**
 * Resolve a `mail.outbound` frame's sender run address to the mailbox
 * authorization the package needs: the tenant the resulting rows belong to,
 * and the mail domain that scopes which recipients are even addressable.
 *
 * Mirrors exactly what `persistMail` itself already does to resolve a sender
 * (`resolveRoutableAddress`, the same routable-address resolver) rather than
 * re-deriving liveness some other way: a sender that is not a live run
 * resolves to `undefined` there and to `null` here, which skips the mailbox
 * write while the frame still goes upstream unchanged.
 */
export function createHubMailboxAuthorizeSender(
  db: DB["db"],
): AuthorizeMailboxSender {
  return async (senderAddress) => {
    const sender = await resolveRoutableAddress(db, senderAddress);
    if (sender === undefined) return null;
    const [row] = await db
      .select({ domain: tenantTable.domain })
      .from(tenantTable)
      .where(eq(tenantTable.id, sender.tenantId))
      .limit(1);
    if (row === undefined) return null;
    return { tenantId: sender.tenantId, domain: row.domain };
  };
}

/**
 * Build the `onRow` hook: stamps `refs: [{ kind: "workbench", id: tenantId }]`
 * onto the row `createMailboxPersist` just inserted, so a thread read can
 * scope by workbench. The row's `tenantId` IS the sender run's workbench
 * tenant (`authorizeSender`'s own resolution), so no second lookup is needed.
 *
 * `onRow` is invoked strictly after the insert commits and is documented as
 * best-effort by the package (a throw is logged there and never rejects the
 * persist) -- but that catch only covers a SYNCHRONOUS throw. This hook does
 * its own work asynchronously, so it owns its own try/catch and reports
 * through `reportError` on failure rather than producing an unhandled
 * rejection the package's guard cannot see.
 */
export function createHubMailboxRowRefsStamper(
  mailboxDb: MailboxDb,
): (row: PersistedMailboxRow) => void {
  return (row) => {
    void mailboxDb
      .update(principalMail)
      .set({ refs: [{ kind: "workbench", id: row.tenantId }] })
      .where(eq(principalMail.id, row.id))
      .catch((error: unknown) => {
        reportError(error, {
          operation: "mailbox.persist.stampWorkbenchRef",
          tenantId: row.tenantId,
          extra: { principalMailId: row.id },
        });
      });
  };
}
