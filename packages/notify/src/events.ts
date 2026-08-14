// The three things that can need a human's attention, parsed at the
// boundary before anything is written. An approval carries no new state
// of its own: the platform's `signal_correlation` + `approval` row pair
// already IS the parked run, and these events only describe the delivery
// of that fact into somebody's mail.
import { type } from "arktype";

export const NotifyRecipient = type({
  tenantId: "string > 0",
  principalId: "string > 0",
});

export const ApprovalNotification = type({
  kind: '"approval"',
  approvalId: "string > 0",
  tenantId: "string > 0",
  runId: "string > 0",
  deploymentId: "string > 0",
  toolName: "string > 0",
  toolArguments: "object",
  recipients: NotifyRecipient.array(),
  createdAt: "string.date.iso",
});

export const RunFailureNotification = type({
  kind: '"run-failure"',
  tenantId: "string > 0",
  runId: "string > 0",
  deploymentId: "string > 0",
  runLabel: "string > 0",
  error: "string",
  recipients: NotifyRecipient.array(),
  createdAt: "string.date.iso",
});

export const MentionNotification = type({
  kind: '"mention"',
  tenantId: "string > 0",
  threadId: "string > 0",
  threadLabel: "string > 0",
  mentionedBy: "string > 0",
  excerpt: "string",
  recipients: NotifyRecipient.array(),
  createdAt: "string.date.iso",
});

/** A stored credential's token expired — not a run event, but the same
 * shape of "a human needs to act" the other three kinds carry.
 * `providerId` is the credential's provider id (e.g. `huggingface`);
 * `providerLabel` is what a person calls it. Keyed for dedupe on
 * `credentialId` alone (see `notificationExternalId`), not per-sweep-tick,
 * so a still-expired credential is only ever mailed once until it's fixed. */
export const CredentialExpiredNotification = type({
  kind: '"credential-expired"',
  tenantId: "string > 0",
  credentialId: "string > 0",
  providerId: "string > 0",
  providerLabel: "string > 0",
  recipients: NotifyRecipient.array(),
  createdAt: "string.date.iso",
});

export const NotificationEvent = ApprovalNotification.or(RunFailureNotification)
  .or(MentionNotification)
  .or(CredentialExpiredNotification);

export type NotifyRecipient = typeof NotifyRecipient.infer;
export type ApprovalNotification = typeof ApprovalNotification.infer;
export type RunFailureNotification = typeof RunFailureNotification.infer;
export type MentionNotification = typeof MentionNotification.infer;
export type CredentialExpiredNotification =
  typeof CredentialExpiredNotification.infer;
export type NotificationEvent = typeof NotificationEvent.infer;

export class InvalidNotificationEventError extends Error {
  constructor(summary: string) {
    super(`Notification event does not parse: ${summary}`);
    this.name = "InvalidNotificationEventError";
  }
}

/** Parse-or-throw at the delivery boundary; nothing downstream casts. */
export function parseNotificationEvent(input: unknown): NotificationEvent {
  const parsed = NotificationEvent(input);
  if (parsed instanceof type.errors) {
    throw new InvalidNotificationEventError(parsed.summary);
  }
  return parsed;
}
