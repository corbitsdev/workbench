// The mail substrate this package writes through, expressed as the one
// function it calls. The shape is `@corbits/mailbox`'s `deliverInboxItems`
// bound to a database handle: same fields, same dedupe contract, same
// post-commit `enqueue` callback. Naming it here is what keeps `@corbits/notify`
// free of a direct dependency on any one mailbox build while still refusing to
// invent a second delivery mechanism — there is exactly one seam, and it is mail.
export type NotifyMailRef = {
  readonly kind: string;
  readonly id: string;
  /** A human label for the ref, when the caller already has one to
   * hand (e.g. an artifact's title) — optional, since most refs are
   * navigational only (see `render.ts`'s own doc note) and a reader
   * resolves a display label from the id itself. */
  readonly label?: string;
};

export type NotifyInboxItem = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly address: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly source: string;
  readonly externalId: string;
  readonly refs?: readonly NotifyMailRef[];
};

/** `id` is null exactly when the item deduped and no row was written. */
export type NotifyDeliveredItem = {
  readonly messageKey: string;
  readonly id: string | null;
};

export type NotifyDeliverOpts = {
  /** Called once per newly written row, strictly after the batch commits. */
  readonly enqueue?: (delivered: { id: string; item: NotifyInboxItem }) => void;
};

export type MailboxDelivery = (
  items: NotifyInboxItem[],
  opts?: NotifyDeliverOpts,
) => Promise<NotifyDeliveredItem[]>;

/**
 * How a notification addresses mail. The host owns its own address space —
 * a mailbox address is a deployment fact, not a product rule — so both halves
 * are supplied rather than assembled from a hardcoded domain here.
 */
export type NotifyAddressing = {
  inbox(recipient: { tenantId: string; principalId: string }): string;
  from(kind: string): string;
};
