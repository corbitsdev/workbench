// Wires @corbits/mailbox's createMailboxPersist onto the hub's own
// persistMail lookup so every outbound frame also lands a durable
// principal_mail row, not just session_mail.

import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable } from "@intx/db/schema";
import type { AuthorizeMailboxSender, MailboxPersistArgs } from "@corbits/mailbox";
import { resolveRoutableAddress } from "@intx/hub-sessions";
import { ensureRunSession, type EventCollectorPort } from "@corbits/workflows";
import { reportError } from "@corbits/error-sink";
import { getLogger } from "@intx/log";

const logger = getLogger(["hub", "mailbox-persist"]);

/**
 * Ensures a run's agent_session/event collector exist before the first
 * mail-triggered write reaches it, since workflow_run.principal_id only
 * reconciles onto the trigger that just fired. Best-effort: a failure
 * here must not block the mail upstream is about to persist regardless.
 */
export function createHubPersistMailWithSessionEnsure<R extends readonly unknown[]>(
  db: DB["db"],
  eventCollectorsRef: { current?: Pick<EventCollectorPort, "create" | "has"> },
  upstream: (args: MailboxPersistArgs) => Promise<R>,
): (args: MailboxPersistArgs) => Promise<R> {
  return async (args) => {
    const sender = await resolveRoutableAddress(db, args.senderAddress);
    try {
      const eventCollectors = eventCollectorsRef.current;
      if (sender !== undefined && eventCollectors !== undefined) {
        await ensureRunSession({ db, eventCollectors, runId: sender.id });
      }
    } catch (err) {
      reportError(err, {
        operation: "hub.mailboxPersist.ensureRunSession",
        extra: { senderAddress: args.senderAddress },
      });
    }
    // The vendored session_mail write keys on the sender's principal, which
    // doesn't exist yet on a run's first outbound mail; skip it rather than
    // let it throw, since @corbits/mailbox's own write already persists this
    // frame.
    if (sender !== undefined && sender.sessionId === null) {
      logger.debug("skipping vendored persistMail for run {runId}: no session yet", {
        runId: sender.id,
        senderAddress: args.senderAddress,
      });
      return [] as unknown as R;
    }
    return upstream(args);
  };
}

export function createHubMailboxAuthorizeSender(db: DB["db"]): AuthorizeMailboxSender {
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
