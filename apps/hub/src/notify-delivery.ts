// The hub's `@corbits/notify` delivery deps, composed once at the root so
// every mail writer (the credential-expiry sweep today) mails through the
// same adapter the inbox read-back repairs. Kept here instead of inline in
// `index.ts` so the composed path is a single construction site the
// crash-window suite can exercise directly.
import {
  createResolveExistingMailIds,
  createWorkbenchMailboxDelivery,
} from "@corbits/inbox";
import type { MailboxDb, MailboxEventBus } from "@corbits/mailbox";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
  type NotifyDeliveryDeps,
  type NotifyDispatchStore,
  type SinkRegistry,
} from "@corbits/notify";

export interface CreateHubNotifyDeliveryDepsOpts {
  mailboxDb: MailboxDb;
  bus?: MailboxEventBus;
  host: string;
  dispatch?: NotifyDispatchStore;
  sinks?: SinkRegistry;
}

export function createHubNotifyDeliveryDeps(
  opts: CreateHubNotifyDeliveryDepsOpts,
): NotifyDeliveryDeps {
  return {
    mail: createWorkbenchMailboxDelivery({
      db: opts.mailboxDb,
      ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
    }),
    addressing: {
      inbox: (recipient) => `${recipient.principalId}@inbox.${opts.host}`,
      from: (kind) => `${kind}@notify.${opts.host}`,
    },
    dispatch: opts.dispatch ?? createInMemoryNotifyDispatchStore(),
    sinks: opts.sinks ?? createSinkRegistry(),
    // CL-7238: without this read-back a redelivery after a crash between
    // the mail write and the dispatch enqueue still loses the dispatch.
    // Resolved from the mailbox unique mail key — the same key the write
    // dedupes on — so the lookup can never disagree with the delivery.
    resolveExistingMailIds: createResolveExistingMailIds(opts.mailboxDb),
  };
}
