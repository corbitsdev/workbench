// A cron schedule fires with nobody signed in, so it cannot ride the
// mailbox persist path: that path authorizes its sender against a live
// routable endpoint, and `cron@<domain>` is not one. A due schedule is a
// trigger, exactly like an inbound webhook, so it takes the same route an
// inbound webhook takes: materialize the run's mail-triggered grants, hand
// them to the sidecar, then route a signed trigger frame in which the run
// is the authenticated sender of its own trigger mail. No authorization
// check is skipped -- the frame never enters the mailbox sender path at
// all.

import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import {
  assembleMessage,
  assembleSignedContent,
  createDetachedSignatureFromProvider,
} from "@intx/mime";
import { base64Encode, deriveWorkflowRunId, isRunAddress } from "@intx/types";

export type CronMailRouter = {
  routeMail: (
    address: string,
    rawMessage: string,
    authenticatedSender: string,
    messageId?: string,
  ) => boolean;
  sendRunGrants: (
    address: string,
    runId: string,
    stepGrants: unknown,
    senderIdentities: unknown,
  ) => boolean;
};

export type CronMaterializeRunGrants = (args: { agentAddress: string; runId: string }) => Promise<{
  outcome: string;
  stepGrants?: unknown;
  code?: string;
  message?: string;
}>;

export type CreateCronDeliverOpts = {
  router: CronMailRouter;
  materialize: CronMaterializeRunGrants;
  tenantDomain: (tenantId: string) => Promise<string>;
};

export type CronMessage = {
  to: string[];
  subject: string;
  body: string;
  tenantId: string;
};

export function createCronDeliver(
  opts: CreateCronDeliverOpts,
): (message: CronMessage) => Promise<void> {
  return async (message) => {
    const domain = await opts.tenantDomain(message.tenantId);
    for (const address of message.to) {
      if (!isRunAddress(address)) {
        throw new Error(`cron schedule address "${address}" is not a live run address`);
      }
      const runId = deriveWorkflowRunId(address);
      const grants = await opts.materialize({ agentAddress: address, runId });
      if (grants.outcome !== "materialized" || grants.stepGrants === undefined) {
        throw new Error(grants.message ?? grants.code ?? `no live deployment at "${address}"`);
      }
      // A cron trigger carries no inbound sender, so there is no sender key
      // to co-deliver on this barrier.
      if (!opts.router.sendRunGrants(address, runId, grants.stepGrants, undefined)) {
        throw new Error(`run grants not routable for "${address}"`);
      }
      const raw = await assembleCronMail({
        address,
        subject: message.subject,
        body: message.body,
        tenantId: message.tenantId,
        domain,
      });
      if (!opts.router.routeMail(address, raw.base64, address, raw.messageId)) {
        throw new Error(`run mail not routable for "${address}"`);
      }
    }
  };
}

async function assembleCronMail(opts: {
  address: string;
  subject: string;
  body: string;
  tenantId: string;
  domain: string;
}): Promise<{ base64: string; messageId: string }> {
  const cryptoProvider = createEd25519Crypto(await generateKeyPair());
  const messageId = `<${crypto.randomUUID()}@${opts.domain}>`;
  const signedContent = assembleSignedContent({ kind: "conversation", text: opts.body });
  const rawMessage = assembleMessage(
    {
      from: `cron@${opts.domain}`,
      to: [opts.address],
      cc: undefined,
      date: new Date(),
      messageId,
      subject: opts.subject,
      inReplyTo: undefined,
      references: undefined,
      mimeVersion: "1.0" as const,
      interchangeType: "conversation.message" as const,
      interchangeCorrelationId: undefined,
      interchangeAgentId: undefined,
      interchangeSessionId: undefined,
      interchangeOfferingId: undefined,
      interchangeSchemaVersion: undefined,
      interchangeTenantId: opts.tenantId,
      traceparent: undefined,
      tracestate: undefined,
    },
    signedContent,
    await createDetachedSignatureFromProvider(signedContent, cryptoProvider),
  );
  return { base64: base64Encode(rawMessage), messageId };
}
