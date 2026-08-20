// Redelivers mail the sidecar wire layer could not route locally.
// `rawMessage` is the same full MIME bytes `routeMail` accepts for a
// first delivery attempt — confirmed against
// `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`'s
// `mail.outbound.undelivered` emit sites, every one of which carries
// the original `mail.inbound` frame's `rawMessage`, never a stripped
// notification — so, unlike a payload naming only the recipients, this
// one genuinely supports a retry rather than only a log line.
//
// `ensureAwake` is chat's own wake primitive (`@corbits/chat`'s
// `ChatPlatform` has no generic host-agnostic equivalent across chat,
// tasks, and any other future resident kind). A recipient it rejects
// for — not a chat resident at all, or a task-launched resident whose
// `wake` is deliberately unreachable once its one-shot turn has run —
// still gets the `routeMail` retry, since an address can go from
// unroutable to routable for reasons outside this handler's knowledge
// (e.g. a reconnect that lands between the original drop and this
// handler running).
import { getLogger } from "@intx/log";

export type MailRedeliveryEventBus = {
  on(
    type: "mail.outbound.undelivered",
    listener: (event: { rawMessage: string; recipients: string[] }) => void,
  ): () => void;
};

export type MailRedeliverySidecarRouter = {
  events: MailRedeliveryEventBus;
  getRoutableAddresses(): readonly string[];
  routeMail(agentAddress: string, rawMessage: string): boolean;
};

export type MailRedeliveryChatPlatform = {
  ensureAwake(address: string): Promise<void>;
};

export type WireMailRedeliveryDeps = {
  sidecarRouter: MailRedeliverySidecarRouter;
  chatPlatform: MailRedeliveryChatPlatform;
};

export function wireMailRedelivery(deps: WireMailRedeliveryDeps): () => void {
  const log = getLogger(["hub", "mail-redelivery"]);

  return deps.sidecarRouter.events.on(
    "mail.outbound.undelivered",
    ({ rawMessage, recipients }) => {
      for (const recipient of recipients) {
        void (async () => {
          if (!deps.sidecarRouter.getRoutableAddresses().includes(recipient)) {
            try {
              await deps.chatPlatform.ensureAwake(recipient);
            } catch (cause) {
              log.warn`could not wake ${recipient} ahead of redelivery: ${
                cause instanceof Error ? cause.message : String(cause)
              }`;
            }
          }
          const delivered = deps.sidecarRouter.routeMail(recipient, rawMessage);
          if (!delivered) {
            log.warn`redelivery to ${recipient} failed: still unroutable after wake`;
          }
        })();
      }
    },
  );
}
