// The one delivery step this package adds to the platform: something needs a
// human, so it becomes mail in that human's mailbox. Nothing else here is new
// state — an approval's parked run already lives in `signal_correlation` and
// `approval`, and this never registers a correlation of its own.
//
// Fan-out to external sinks is queued strictly after the mail commits, one
// dispatch row per (mail row, enabled sink). A sink is never called from this
// path: the mail is the durable record, and a copy of it is the worker's job.
import {
  parseNotificationEvent,
  type ApprovalNotification,
  type MentionNotification,
  type NotificationEvent,
  type RunFailureNotification,
} from "./events";
import type {
  MailboxDelivery,
  NotifyAddressing,
  NotifyInboxItem,
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
  const written: { id: string; tenantId: string; principalId: string }[] = [];
  await deps.mail(toInboxItems(event, deps.addressing), {
    enqueue: ({ id, item }) => {
      written.push({
        id,
        tenantId: item.tenantId,
        principalId: item.principalId,
      });
    },
  });

  const queued: EnqueueDispatchInput[] = [];
  for (const row of written) {
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
