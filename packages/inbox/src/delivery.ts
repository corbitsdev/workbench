// Workbench adapter that turns `@corbits/notify`'s MailboxDelivery seam into
// a real write against `@corbits/mailbox`. Stamps classification (product
// group) and status so list filters and the three-column UI work without
// re-deriving on every read.

import {
  deliverInboxItems,
  type DeliverInboxItemsOpts,
  type MailboxDb,
  type MailboxEventBus,
} from "@corbits/mailbox";
import type { MailboxDelivery, NotifyInboxItem } from "@corbits/notify";

import { classificationFromRefs } from "./group";

export interface CreateWorkbenchMailboxDeliveryOpts {
  db: MailboxDb;
  /** When set, each newly written row publishes a mailbox event for SSE. */
  bus?: MailboxEventBus;
}

/**
 * Build the `mail` callback `@corbits/notify` needs. Every item is written
 * with `status: "open"` and a classification derived from its refs so the
 * product groups (action / mention / delivery) are filterable at the store.
 */
export function createWorkbenchMailboxDelivery(
  opts: CreateWorkbenchMailboxDeliveryOpts,
): MailboxDelivery {
  const { db, bus } = opts;
  return async (items, deliverOpts) => {
    const stamped = items.map((item: NotifyInboxItem) => {
      const refs = item.refs ?? [];
      return {
        tenantId: item.tenantId,
        principalId: item.principalId,
        address: item.address,
        fromAddress: item.fromAddress,
        subject: item.subject,
        body: item.body,
        source: item.source,
        externalId: item.externalId,
        refs: refs.map((ref) => ({ kind: ref.kind, id: ref.id })),
        classification: classificationFromRefs(refs),
        status: "open",
      };
    });

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

    return deliverInboxItems(db, stamped, writeOpts);
  };
}
