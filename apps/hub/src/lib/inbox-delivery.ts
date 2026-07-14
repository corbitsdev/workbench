import type { HubDb } from "../db";
import { buildMailFrame, writeMailboxMessage } from "./mailbox-write";
import type { MailboxEventBus } from "./mailbox-events";
import type { MailboxTriage } from "../services/mailbox-triage";
import type { UserMailboxRowEvent } from "./principal-mailbox";
import type { IntakeItem } from "../services/inbox-source-registry";

/** The mailbox a delivered item is filed under. A subset of
 * `InboxIntakeMember` so both the poller and the webhook receiver can deliver
 * through the same helper (identical dedupe + triage handoff). */
export interface InboxDeliveryTarget {
  tenantId: string;
  memberPrincipalId: string;
  /** The member's `usr_` address the row is filed under. */
  inboxAddress: string;
  /** The domain the source's `from` address is built on. */
  tenantDomain: string;
}

export interface InboxDeliveryDeps {
  db: HubDb;
  mailboxEventBus?: MailboxEventBus;
  mailboxTriage?: Pick<MailboxTriage, "enqueue">;
}

/**
 * Write + SSE-publish + triage-enqueue each item for a member, deduped by the
 * `inbox:<sourceKey>:<externalId>` messageKey. Returns the count of newly
 * delivered rows (items whose key was already written are skipped).
 *
 * This is the single delivery seam shared by the intake poller and the Linear
 * webhook receiver (CL-3585): because both build the SAME `externalId` for the
 * same underlying activity, a webhook delivery and a later poll of the same
 * issue/comment collapse to one mailbox row via the messageKey conflict.
 */
export async function deliverInboxItems(
  deps: InboxDeliveryDeps,
  target: InboxDeliveryTarget,
  sourceKey: string,
  items: IntakeItem[],
): Promise<number> {
  const fromAddress = `${sourceKey}@${target.tenantDomain}`;
  let delivered = 0;
  for (const item of items) {
    const written = await writeMailboxMessage(
      deps.db,
      {
        tenantId: target.tenantId,
        principalId: target.memberPrincipalId,
        address: target.inboxAddress,
        fromAddress,
        subject: item.subject,
        body: item.body,
        messageKey: `inbox:${sourceKey}:${item.externalId}`,
      },
      deps.mailboxEventBus,
    );
    if (!written) continue; // already delivered (dedupe)
    delivered += 1;
    if (deps.mailboxTriage) {
      const event: UserMailboxRowEvent = {
        rowId: written.id,
        tenantId: target.tenantId,
        memberPrincipalId: target.memberPrincipalId,
        recipientAddress: target.inboxAddress,
        senderAddress: fromAddress,
        subject: item.subject,
        fromAddress,
        raw: buildMailFrame({
          from: fromAddress,
          to: target.inboxAddress,
          subject: item.subject,
          body: item.body,
        }),
      };
      deps.mailboxTriage.enqueue(event);
    }
  }
  return delivered;
}
