// The one delivery step this package adds to the platform: something needs a
// human, so it becomes mail in that human's mailbox. Nothing else here is new
// state — an approval's parked run already lives in `signal_correlation` and
// `approval`, and this never registers a correlation of its own.
//
// Fan-out to external sinks is queued strictly after the mail commits, one
// dispatch row per (mail row, enabled sink). A sink is never called from this
// path: the mail is the durable record, and a copy of it is the worker's job.
//
// That queuing step is NOT atomic with the mail write: a crash or a
// throw between them leaves a mail row committed with no dispatch row
// queued (CL-7238). The mail delivery reports such rows with a `null`
// id, so a redelivery resolves their ids through the host's
// `resolveExistingMailIds` read-back and repairs the missing dispatch
// rows; the dispatch store dedupes by (mail row, sink), so the repair
// never double-queues.
import {
  parseNotificationEvent,
  type ApprovalNotification,
  type CredentialExpiredNotification,
  type MentionNotification,
  type NotificationEvent,
  type RunFailureNotification,
} from "./events";
import type {
  MailboxDelivery,
  NotifyAddressing,
  NotifyInboxItem,
  ResolveExistingMailIds,
} from "./mailbox";
import { notificationExternalId, renderNotification } from "./render";
import type { SinkRegistry } from "./sinks";
import type { EnqueueDispatchInput, NotifyDispatchStore } from "./store";

/** Every notification is mail from the same place, so a mailbox can group it. */
export const NOTIFY_MAIL_SOURCE = "notify";

export interface NotifyDeliveryDeps {
  readonly mail: MailboxDelivery;
  readonly addressing: NotifyAddressing;
  readonly dispatch: NotifyDispatchStore;
  readonly sinks: SinkRegistry;
  /**
   * Read-back for the CL-7238 crash window: when the mail delivery
   * reports an item as pre-existing (`id: null`), the row was committed
   * by an earlier attempt that died before its dispatch enqueue.
   * Resolving those items to their row ids lets this call repair the
   * missing dispatch rows; without it a redelivery after such a crash
   * still loses the dispatch. The host owns this wiring.
   */
  readonly resolveExistingMailIds?: ResolveExistingMailIds;
}

export interface NotifyDeliveryReport {
  /** Mail rows newly written by this call; a deduped recipient contributes none. */
  readonly deliveredMailboxRowIds: readonly string[];
  /** Dispatch rows queued for external sinks; zero until a sink is registered. */
  readonly queuedDispatchCount: number;
}

function toInboxItems(
  event: NotificationEvent,
  addressing: NotifyAddressing,
): NotifyInboxItem[] {
  const rendered = renderNotification(event);
  const externalId = notificationExternalId(event);
  return event.recipients.map((recipient) => ({
    tenantId: recipient.tenantId,
    principalId: recipient.principalId,
    address: addressing.inbox(recipient),
    fromAddress: addressing.from(event.kind),
    subject: rendered.subject,
    body: rendered.body,
    source: NOTIFY_MAIL_SOURCE,
    externalId,
    refs: rendered.refs,
  }));
}

/**
 * Parse, write mail, then queue sink fan-out. The event is parsed here and
 * nowhere else, so no caller can push an unvalidated shape into a mailbox.
 */
export async function deliverNotification(
  deps: NotifyDeliveryDeps,
  input: unknown,
): Promise<NotifyDeliveryReport> {
  const event = parseNotificationEvent(input);
  const items = toInboxItems(event, deps.addressing);
  const written: { id: string; tenantId: string; principalId: string }[] = [];
  const results = await deps.mail(items, {
    enqueue: ({ id, item }) => {
      written.push({
        id,
        tenantId: item.tenantId,
        principalId: item.principalId,
      });
    },
  });

  // CL-7238: a `null` id marks a row committed by an earlier attempt
  // that died before its dispatch enqueue (or a benign redelivery).
  // Resolve those ids so the enqueue below repairs the missing rows;
  // without the read-back there is nothing to enqueue for them.
  const deduped = items.filter(
    (_, index) => (results[index]?.id ?? null) === null,
  );
  const repaired: { id: string; tenantId: string; principalId: string }[] = [];
  if (deduped.length > 0 && deps.resolveExistingMailIds !== undefined) {
    const resolved = await deps.resolveExistingMailIds(deduped);
    deduped.forEach((item, index) => {
      const id = resolved[index];
      if (id !== undefined && id !== null) {
        repaired.push({
          id,
          tenantId: item.tenantId,
          principalId: item.principalId,
        });
      }
    });
  }

  const queued: EnqueueDispatchInput[] = [];
  for (const row of [...written, ...repaired]) {
    const enabled = await deps.sinks.listEnabledFor({
      tenantId: row.tenantId,
      principalId: row.principalId,
    });
    for (const sink of enabled) {
      queued.push({
        mailboxRowId: row.id,
        tenantId: row.tenantId,
        principalId: row.principalId,
        sinkName: sink.name,
      });
    }
  }
  await deps.dispatch.enqueue(queued);

  return {
    deliveredMailboxRowIds: written.map((row) => row.id),
    queuedDispatchCount: queued.length,
  };
}

/** A workflow parked on an approval, delivered to the people who can resolve it. */
export function deliverApprovalMail(
  deps: NotifyDeliveryDeps,
  event: ApprovalNotification,
): Promise<NotifyDeliveryReport> {
  return deliverNotification(deps, event);
}

export function deliverRunFailureMail(
  deps: NotifyDeliveryDeps,
  event: RunFailureNotification,
): Promise<NotifyDeliveryReport> {
  return deliverNotification(deps, event);
}

export function deliverMentionMail(
  deps: NotifyDeliveryDeps,
  event: MentionNotification,
): Promise<NotifyDeliveryReport> {
  return deliverNotification(deps, event);
}

/** A stored credential's token expired, mailed to whoever can reconnect it. */
export function deliverCredentialMail(
  deps: NotifyDeliveryDeps,
  event: CredentialExpiredNotification,
): Promise<NotifyDeliveryReport> {
  return deliverNotification(deps, event);
}
