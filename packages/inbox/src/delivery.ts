// Workbench adapter that turns `@corbits/notify`'s MailboxDelivery seam into
// a real write against `@corbits/mailbox`'s native mailbox store. Refs and
// classification are gone with the retired triage layer (CL-8174, native
// `@corbits/mailbox` 1.0) — a notify item lands as a plain mailbox message,
// and the inbox reads it back through the library's own `/me/inbox` routes.

import { and, eq } from "drizzle-orm";
import {
  deliverInboxItems,
  principalMail,
  type DeliverInboxItemsOpts,
  type InboxItem,
  type MailboxDb,
  type MailboxEventBus,
} from "@corbits/mailbox";
import type {
  MailboxDelivery,
  NotifyInboxItem,
  ResolveExistingMailIds,
} from "@corbits/notify/mailbox";

export interface CreateWorkbenchMailboxDeliveryOpts {
  db: MailboxDb;
  /** When set, each newly written row publishes a mailbox event for SSE. */
  bus?: MailboxEventBus;
}

/** The same deterministic id `@corbits/mailbox`'s `deliverInboxItems` mints
 * for an item that carries no `messageId` of its own — kept here only for
 * `createResolveExistingMailIds`'s read-back, which needs to name the exact
 * row a redelivery reports as pre-existing. */
function inboxMessageIdFor(item: { source: string; externalId: string }): string {
  return `<inbox-${item.source}-${item.externalId}@mailbox.invalid>`;
}

/**
 * Build the `mail` callback `@corbits/notify` needs: a thin pass-through
 * onto `deliverInboxItems`.
 */
export function createWorkbenchMailboxDelivery(
  opts: CreateWorkbenchMailboxDeliveryOpts,
): MailboxDelivery {
  const { db, bus } = opts;
  return async (items, deliverOpts) => {
    const stamped: InboxItem[] = items.map((item: NotifyInboxItem) => ({
      tenantId: item.tenantId,
      principalId: item.principalId,
      address: item.address,
      fromAddress: item.fromAddress,
      subject: item.subject,
      body: item.body,
      source: item.source,
      externalId: item.externalId,
    }));

    const hostEnqueue = deliverOpts?.enqueue;
    const writeOpts: DeliverInboxItemsOpts = {};
    if (bus !== undefined) writeOpts.bus = bus;
    if (hostEnqueue !== undefined) {
      writeOpts.enqueue = ({ id, item }) => {
        const original = items.find(
          (candidate) =>
            candidate.tenantId === item.tenantId &&
            candidate.principalId === item.principalId &&
            candidate.externalId === item.externalId &&
            candidate.source === item.source,
        );
        if (original !== undefined) {
          hostEnqueue({ id, item: original });
        }
      };
    }

    const delivered = await deliverInboxItems(db, stamped, writeOpts);
    return delivered.map((result, index) => ({
      messageKey: inboxMessageIdFor(items[index] as NotifyInboxItem),
      id: result.id,
    }));
  };
}

/**
 * CL-7238 read-back for `@corbits/notify`'s crash window: a redelivery
 * reports an already-committed row as pre-existing (`id: null`), so the
 * host resolves it to its row id here and the missing dispatch rows get
 * repaired instead of lost. Served from the mailbox's `message_id` column
 * — the same deterministic id `deliverInboxItems` mints from
 * `(source, externalId)` when the item carries none of its own — so the
 * lookup can never disagree with the delivery about which row an item
 * belongs to. Positional in, positional out, `null` where no row exists.
 */
export function createResolveExistingMailIds(db: MailboxDb): ResolveExistingMailIds {
  return async (items) => {
    if (items.length === 0) return [];
    const rows = await Promise.all(
      items.map(async (item) => {
        const messageId = inboxMessageIdFor(item);
        const [row] = await db
          .select({ id: principalMail.id })
          .from(principalMail)
          .where(
            and(
              eq(principalMail.tenantId, item.tenantId),
              eq(principalMail.principalId, item.principalId),
              eq(principalMail.messageId, messageId),
            ),
          )
          .limit(1);
        return row?.id ?? null;
      }),
    );
    return rows;
  };
}
