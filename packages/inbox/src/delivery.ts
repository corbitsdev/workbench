// Workbench adapter that turns `@corbits/notify`'s MailboxDelivery seam into
// a real write against `@corbits/mailbox`. Stamps classification (product
// group) and status so list filters and the three-column UI work without
// re-deriving on every read.

import { and, eq, or } from "drizzle-orm";
import {
  deliverInboxItems,
  mailboxKey,
  principalMail,
  type DeliverInboxItemsOpts,
  type MailboxDb,
  type MailboxEventBus,
} from "@corbits/mailbox";
import type {
  MailboxDelivery,
  NotifyInboxItem,
  ResolveExistingMailIds,
} from "@corbits/notify/mailbox";

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
        refs: refs.map((ref) => ({
          kind: ref.kind,
          id: ref.id,
          // A ref's display label (an artifact's title, say) rides
          // along so the inbox detail can render a chip without a
          // second lookup — dropped only when the writer had none.
          label: ref.label,
        })),
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

/**
 * CL-7238 read-back for `@corbits/notify`'s crash window: a redelivery
 * reports an already-committed row as pre-existing (`id: null`), so the
 * host resolves it to its row id here and the missing dispatch rows get
 * repaired instead of lost. Served from the mailbox unique mail key —
 * the same `mailboxKey.inbox(source, externalId)` the write dedupes on —
 * so the lookup can never disagree with the delivery about which row an
 * item belongs to. Positional in, positional out, `null` where no row
 * exists; the dispatch store dedupes by (mail row, sink), so a benign
 * redelivery's repair never double-queues.
 */
export function createResolveExistingMailIds(db: MailboxDb): ResolveExistingMailIds {
  return async (items) => {
    if (items.length === 0) return [];
    const keyed = items.map((item) => ({
      tenantId: item.tenantId,
      principalId: item.principalId,
      messageKey: mailboxKey.inbox(item.source, item.externalId),
    }));
    const rows = await db
      .select({
        id: principalMail.id,
        tenantId: principalMail.tenantId,
        principalId: principalMail.principalId,
        messageKey: principalMail.messageKey,
      })
      .from(principalMail)
      .where(
        or(
          ...keyed.map((key) =>
            and(
              eq(principalMail.tenantId, key.tenantId),
              eq(principalMail.principalId, key.principalId),
              eq(principalMail.messageKey, key.messageKey),
            ),
          ),
        ),
      );
    const idsByKey = new Map(
      rows.map((row) => [`${row.tenantId}\n${row.principalId}\n${row.messageKey}`, row.id]),
    );
    return keyed.map(
      (key) => idsByKey.get(`${key.tenantId}\n${key.principalId}\n${key.messageKey}`) ?? null,
    );
  };
}
