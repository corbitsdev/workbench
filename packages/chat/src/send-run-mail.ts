// Delivers one inbound message to a provisioned run through Interchange's
// own workflow-run mail-trigger route (`./run-trigger-client.ts`), then
// records a local, chat-signed copy on `session_mail` so this workbench's
// own subscribers (the `mail.delivered` event and `fetchBlob`'s outbound
// attachment reads) see it exactly as before (CL-7490).
//
// CL-7490: `sessionService.sendUserMessage` used to both sign AND
// deliver. It never reached the trigger route's durable-dispatch branch,
// so a provisioned run invited but never yet triggered natively never
// got its first `agent.deploy` and stayed permanently unreachable. The
// trigger route now owns delivery (and, on its first call, the deploy);
// it returns no raw MIME bytes, so this still assembles and signs its
// own local copy — with `@intx/mime`/`@intx/crypto`, the same primitives
// the route itself uses — purely for that local record. It is never
// delivered a second time: the sidecar send lives entirely on the
// trigger route's side of this call.
import {
  assembleMessage,
  assembleSignedContent,
  createDetachedSignatureFromProvider,
  type MessageHeaders,
} from "@intx/mime";
import { sessionMail } from "@intx/db/schema";
import type { DB } from "@intx/db";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { CryptoProvider, MessageAttachment } from "@intx/types/runtime";

import { mailIdFromBracketMessageId } from "./turn-mail-correlation";
import type { RunTriggerClient } from "./run-trigger-client";

export type RunMailDeps = {
  db: DB["db"];
  runTrigger: RunTriggerClient;
  sidecarRouter: Pick<SidecarRouter, "dispatchAgentEvent">;
};

export type SendRunMailParams = {
  tenantId: string;
  sessionId: string;
  agentAddress: string;
  /** The deployment's anchor run id — `:runId` in the trigger route's
   * path, distinct from `agentAddress` (which names the deployment). */
  anchorRunId: string;
  from: string;
  domain: string;
  content: string;
  attachments?: MessageAttachment[];
  replyTo?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
  cryptoProvider: CryptoProvider;
  /**
   * The better-auth `user.id` this delivery authenticates the trigger
   * call as — see `./run-trigger-client.ts`'s own doc comment on
   * `authAsUserId` for how a caller resolves this.
   */
  authAsUserId: string;
};

export type SentRunMail = {
  readonly id: string;
  readonly createdAt: string;
};

function toWireAttachments(
  attachments: MessageAttachment[] | undefined,
): { mimeType: string; data: string; name?: string }[] | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  return attachments.map((attachment) => ({
    mimeType: attachment.contentType,
    data: Buffer.from(attachment.data).toString("base64"),
    ...(attachment.name !== undefined ? { name: attachment.name } : {}),
  }));
}

/**
 * Assemble and sign a local MIME copy of the message this delivery sent,
 * for `session_mail` — never delivered anywhere itself. Threading
 * headers (`inReplyTo`/`references`) are preserved here even though the
 * trigger route's own `SendMessage` body carries neither (CL-7490: "a
 * trigger occurrence is threading-less at the mail boundary" —
 * `vendor/intx/hub-api/src/workflow-run-trigger.ts`), so the run itself
 * never sees this message as a reply; only this workbench's own local
 * history does.
 */
async function signLocalRunMailCopy(
  params: SendRunMailParams,
  messageId: string,
  now: Date,
): Promise<Uint8Array> {
  const headers: MessageHeaders = {
    from: params.from,
    to: [params.agentAddress],
    cc: undefined,
    date: now,
    messageId,
    subject: undefined,
    inReplyTo: params.inReplyTo ?? params.replyTo,
    references:
      params.references !== undefined ? [...params.references] : undefined,
    mimeVersion: "1.0",
    interchangeType: "conversation.message",
    interchangeCorrelationId: undefined,
    interchangeTenantId: params.tenantId,
    interchangeAgentId: undefined,
    interchangeSessionId: params.sessionId,
    interchangeOfferingId: undefined,
    interchangeSchemaVersion: undefined,
    traceparent: undefined,
    tracestate: undefined,
  };
  const signedContent = assembleSignedContent({
    kind: "conversation",
    text: params.content,
    ...(params.attachments !== undefined
      ? { attachments: params.attachments }
      : {}),
  });
  const signature = await createDetachedSignatureFromProvider(
    signedContent,
    params.cryptoProvider,
  );
  return assembleMessage(headers, signedContent, signature);
}

async function recordRunMail(
  deps: Pick<RunMailDeps, "db" | "sidecarRouter">,
  params: SendRunMailParams,
  mailId: string,
  now: Date,
  rawMIME: Uint8Array,
): Promise<SentRunMail> {
  await deps.db.insert(sessionMail).values({
    id: mailId,
    sessionId: params.sessionId,
    runId: null,
    tenantId: params.tenantId,
    direction: "inbound",
    status: "delivered",
    raw: rawMIME,
    createdAt: now,
  });

  deps.sidecarRouter.dispatchAgentEvent(params.agentAddress, {
    type: "mail.delivered",
    data: {
      id: mailId,
      direction: "inbound",
      receivedAt: now.toISOString(),
    },
  });

  return { id: mailId, createdAt: now.toISOString() };
}

export async function sendRunMail(
  deps: RunMailDeps,
  params: SendRunMailParams,
): Promise<SentRunMail> {
  const now = new Date();
  const triggered = await deps.runTrigger.triggerMail({
    tenantId: params.tenantId,
    anchorRunId: params.anchorRunId,
    content: params.content,
    attachments: toWireAttachments(params.attachments),
    authAsUserId: params.authAsUserId,
  });
  const mailId = mailIdFromBracketMessageId(triggered.messageId);
  const rawMIME = await signLocalRunMailCopy(params, triggered.messageId, now);
  // A run's session and event collector are ensured lazily now, at the
  // hub seams that actually see the run become mail-routable
  // (`apps/hub/src/mailbox-persist.ts`, the wrapped `eventCollectors`
  // dispatch in `apps/hub/src/index.ts`) — CL-7480. Nothing here needs
  // to record it.
  return recordRunMail(deps, params, mailId, now, rawMIME);
}
